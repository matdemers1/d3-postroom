// One ManageSieve connection (RFC 5804): not authenticated → authenticated → logout.
//
//   PST-REQ-149  every RFC 5804 command a client needs to edit scripts: CAPABILITY, STARTTLS,
//                AUTHENTICATE PLAIN, LOGOUT, NOOP, HAVESPACE, PUTSCRIPT, LISTSCRIPTS, SETACTIVE,
//                GETSCRIPT, DELETESCRIPT, RENAMESCRIPT, CHECKSCRIPT.
//   PST-REQ-027  AUTHENTICATE takes an app password with the `sieve` scope, and only once TLS is
//                active: before it, SASL is advertised empty and AUTHENTICATE answers
//                NO (ENCRYPT-NEEDED). The account password is never consulted.
//   PST-REQ-075  every credential check goes through the shared, audit-backed throttle (server.ts).
//   PST-REQ-009  every script mutation is audited, by the store (store.ts).
//
// Commands run strictly one at a time. A script is refused unless it compiles; the refusal names the
// line and column of the first error.
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { SecureContext } from 'node:tls';
import type { Db } from '@postroom/db';
import { ChunkSource, TimeoutError, upgradeToTls } from './io.js';
import { capabilityLines, CommandReader, encodeLiteral, encodeString, status, type ReaderEvent, type ResponseCode, type Token } from './protocol.js';
import {
  checkScript,
  deleteScript,
  getScript,
  haveSpace,
  listScripts,
  MAX_REDIRECTS,
  MAX_SCRIPT_BYTES,
  putScript,
  renameScript,
  setActive,
  SIEVE_EXTENSIONS,
  SieveStoreError,
  type StoreActor,
} from './store.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type AuthOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly kind: 'failed' | 'locked' | 'unavailable' | 'aborted' };

/** Checks one set of credentials, throttled (server.ts wires credentials + auth-throttle). */
export type Authenticator = (username: string, password: string, ip: string, signal: AbortSignal) => Promise<AuthOutcome>;

export interface SessionOptions {
  readonly db: Db;
  readonly authenticate: Authenticator;
  /** Null: no certificate, so no STARTTLS — and so no login at all. */
  readonly secureContext: SecureContext | null;
  readonly log?: Log;
  readonly preauthTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Protocol errors and unknown commands before the connection is dropped. */
  readonly maxBadCommands?: number;
  /** Failed AUTHENTICATEs before the connection is dropped. */
  readonly maxAuthFailures?: number;
}

export const DEFAULT_PREAUTH_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

const ANY_STATE = new Set(['CAPABILITY', 'LOGOUT', 'NOOP']);
const NOT_AUTHENTICATED = new Set(['STARTTLS', 'AUTHENTICATE']);
const AUTHENTICATED = new Set(['HAVESPACE', 'PUTSCRIPT', 'LISTSCRIPTS', 'SETACTIVE', 'GETSCRIPT', 'DELETESCRIPT', 'RENAMESCRIPT', 'CHECKSCRIPT']);

const utf8 = new TextDecoder('utf-8', { fatal: true });

class Closed extends Error {
  constructor() {
    super('connection closed');
  }
}

/** A client mistake: answered with NO and counted towards the bad-command limit. */
class Bad extends Error {}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function codeFor(err: SieveStoreError): ResponseCode | undefined {
  switch (err.code) {
    case 'nonexistent':
      return 'NONEXISTENT';
    case 'already-exists':
      return 'ALREADYEXISTS';
    case 'active':
      return 'ACTIVE';
    case 'too-many-scripts':
      return 'QUOTA/MAXSCRIPTS';
    case 'too-large':
      return 'QUOTA/MAXSIZE';
    default:
      return undefined;
  }
}

export class ManageSieveSession {
  readonly id = randomUUID().replace(/-/g, '').slice(0, 12);
  private stream: Duplex;
  private source: ChunkSource;
  private reader = new CommandReader({ maxLiteral: MAX_SCRIPT_BYTES + 1024 });
  private secure: boolean;
  private accountId: string | null = null;
  private username: string | null = null;
  private closed = false;
  private badCommands = 0;
  private authFailures = 0;
  private commands = 0;
  private readonly hangup = new AbortController();
  private readonly log: Log;
  readonly done: Promise<void>;

  constructor(
    stream: Duplex,
    secure: boolean,
    readonly clientIp: string,
    private readonly o: SessionOptions,
  ) {
    this.stream = stream;
    this.secure = secure;
    this.source = new ChunkSource(stream);
    this.log = o.log ?? (() => undefined);
    stream.once('close', () => {
      this.hangup.abort();
    });
    this.done = this.run();
  }

  /** Server shutdown: say goodbye and close. */
  async shutdown(text = 'Server shutting down'): Promise<void> {
    if (this.closed) return;
    await this.write(status('BYE', text, 'TRYLATER')).catch(() => undefined);
    this.close();
  }

  private capabilities(): string {
    return capabilityLines({
      secure: this.secure,
      startTlsAvailable: this.o.secureContext !== null,
      authenticated: this.accountId !== null,
      sieveExtensions: SIEVE_EXTENSIONS,
      maxRedirects: MAX_REDIRECTS,
    });
  }

  private timeout(): number {
    return this.accountId === null ? (this.o.preauthTimeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS) : (this.o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private async run(): Promise<void> {
    const started = Date.now();
    try {
      // RFC 5804 §1.7: the capabilities, then OK, as soon as the connection opens.
      await this.write(this.capabilities() + status('OK', 'Postroom ManageSieve ready'));
      while (!this.closed) {
        const ev = await this.nextEvent();
        if (ev === null) break;
        await this.onEvent(ev);
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        await this.write(status('BYE', 'Idle for too long')).catch(() => undefined);
      } else if (!(err instanceof Closed)) {
        this.log('session-error', { session: this.id, ip: this.clientIp, error: errorText(err) });
        await this.write(status('BYE', 'Internal error')).catch(() => undefined);
      }
    } finally {
      this.close();
      this.log('session', { session: this.id, ip: this.clientIp, user: this.username, tls: this.secure, commands: this.commands, durationMs: Date.now() - started });
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.detach();
    this.stream.end();
    const s = this.stream;
    setTimeout(() => {
      s.destroy();
    }, 1_000).unref();
  }

  private async write(data: string | Buffer): Promise<void> {
    if (this.stream.destroyed) throw new Closed();
    await new Promise<void>((resolve, reject) => {
      this.stream.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async nextEvent(): Promise<ReaderEvent | null> {
    for (;;) {
      const ev = this.reader.next();
      if (ev !== null) return ev;
      if (this.closed) return null;
      const chunk = await this.source.read(this.timeout());
      if (chunk === null) return null;
      this.reader.push(chunk);
    }
  }

  private async bad(text: string, code?: ResponseCode): Promise<void> {
    this.badCommands++;
    if (this.badCommands >= (this.o.maxBadCommands ?? 20)) {
      await this.write(status('BYE', 'Too many bad commands'));
      this.close();
      return;
    }
    await this.write(status('NO', text, code));
  }

  private async onEvent(ev: ReaderEvent): Promise<void> {
    if (ev.type === 'error') {
      if (ev.fatal) {
        await this.write(status('BYE', `Protocol error: ${ev.message}`));
        this.close();
        return;
      }
      await this.bad(ev.message, ev.code);
      return;
    }
    const [first, ...args] = ev.tokens;
    if (first?.kind !== 'atom') {
      await this.bad('Expected a command name');
      return;
    }
    this.commands++;
    const name = first.value;
    try {
      await this.dispatch(name, args);
    } catch (err) {
      if (err instanceof Bad) {
        await this.bad(err.message);
        return;
      }
      if (err instanceof SieveStoreError) {
        await this.write(status('NO', err.message, codeFor(err)));
        return;
      }
      throw err;
    }
  }

  // --- argument helpers -------------------------------------------------------------------------

  private arity(args: readonly Token[], min: number, max = min): void {
    if (args.length < min || args.length > max) throw new Bad(min === max ? `Expected ${min} argument(s)` : `Expected ${min} to ${max} arguments`);
  }

  private text(token: Token | undefined, what: string): string {
    if (token?.kind !== 'string') throw new Bad(`Expected ${what} as a string`);
    try {
      return utf8.decode(token.value);
    } catch {
      throw new Bad(`${what} is not valid UTF-8`);
    }
  }

  private actor(): StoreActor {
    if (this.accountId === null) throw new Error('not authenticated');
    return { accountId: this.accountId, context: { requestId: `managesieve-${this.id}-${this.commands}`, ip: this.clientIp, userAgent: 'managesieve' } };
  }

  // --- commands ---------------------------------------------------------------------------------

  private async dispatch(name: string, args: readonly Token[]): Promise<void> {
    const authed = this.accountId !== null;
    if (!ANY_STATE.has(name) && !NOT_AUTHENTICATED.has(name) && !AUTHENTICATED.has(name)) throw new Bad(`Unknown command ${name}`);
    if (NOT_AUTHENTICATED.has(name) && authed) throw new Bad(`${name} is not allowed once authenticated`);
    if (AUTHENTICATED.has(name) && !authed) {
      await this.write(status('NO', 'Authenticate first'));
      return;
    }
    switch (name) {
      case 'CAPABILITY':
        this.arity(args, 0);
        await this.write(this.capabilities() + status('OK', 'Capability completed'));
        return;
      case 'NOOP': {
        this.arity(args, 0, 1);
        const tag = args[0] === undefined ? undefined : this.text(args[0], 'the tag');
        await this.write(status('OK', 'Done', tag === undefined ? undefined : { tag }));
        return;
      }
      case 'LOGOUT':
        await this.write(status('OK', 'Logout completed'));
        this.close();
        return;
      case 'STARTTLS':
        this.arity(args, 0);
        await this.startTls();
        return;
      case 'AUTHENTICATE':
        this.arity(args, 1, 2);
        await this.authenticate(this.text(args[0], 'the mechanism'), args[1] === undefined ? null : this.text(args[1], 'the initial response'));
        return;
      case 'HAVESPACE': {
        this.arity(args, 2);
        const scriptName = this.text(args[0], 'the script name');
        const size = args[1];
        if (size?.kind !== 'number') throw new Bad('Expected the size as a number');
        const refusal = await haveSpace(this.o.db, this.actor().accountId, scriptName, size.value);
        await this.write(refusal === null ? status('OK', 'Putscript would succeed') : status('NO', refusal.message, codeFor(refusal)));
        return;
      }
      case 'PUTSCRIPT': {
        this.arity(args, 2);
        const scriptName = this.text(args[0], 'the script name');
        const content = this.text(args[1], 'the script');
        await putScript(this.o.db, this.actor(), scriptName, content);
        await this.write(status('OK', 'Putscript completed'));
        return;
      }
      case 'CHECKSCRIPT': {
        this.arity(args, 1);
        const problem = checkScript(this.text(args[0], 'the script'));
        await this.write(problem === null ? status('OK', 'Script is valid') : status('NO', problem.message));
        return;
      }
      case 'LISTSCRIPTS': {
        this.arity(args, 0);
        const scripts = await listScripts(this.o.db, this.actor().accountId);
        const lines = scripts.map((s) => `${encodeString(s.name)}${s.active ? ' ACTIVE' : ''}\r\n`).join('');
        await this.write(lines + status('OK', 'Listscripts completed'));
        return;
      }
      case 'GETSCRIPT': {
        this.arity(args, 1);
        const script = await getScript(this.o.db, this.actor().accountId, this.text(args[0], 'the script name'));
        if (script === null) {
          await this.write(status('NO', 'There is no script by that name', 'NONEXISTENT'));
          return;
        }
        await this.write(Buffer.concat([encodeLiteral(Buffer.from(script.content, 'utf8')), Buffer.from(`\r\n${status('OK', 'Getscript completed')}`, 'utf8')]));
        return;
      }
      case 'SETACTIVE':
        this.arity(args, 1);
        await setActive(this.o.db, this.actor(), this.text(args[0], 'the script name'));
        await this.write(status('OK', 'Setactive completed'));
        return;
      case 'DELETESCRIPT':
        this.arity(args, 1);
        await deleteScript(this.o.db, this.actor(), this.text(args[0], 'the script name'));
        await this.write(status('OK', 'Deletescript completed'));
        return;
      case 'RENAMESCRIPT':
        this.arity(args, 2);
        await renameScript(this.o.db, this.actor(), this.text(args[0], 'the old name'), this.text(args[1], 'the new name'));
        await this.write(status('OK', 'Renamescript completed'));
        return;
    }
  }

  private async startTls(): Promise<void> {
    if (this.secure) throw new Bad('TLS is already active');
    if (this.o.secureContext === null) {
      await this.write(status('NO', 'TLS is not available'));
      return;
    }
    await this.write(status('OK', 'Begin TLS negotiation now'));
    // Anything the client pipelined after STARTTLS is discarded with the old reader.
    this.source.detach();
    try {
      const tls = await upgradeToTls(this.stream, this.o.secureContext);
      this.stream = tls;
      this.source = new ChunkSource(tls);
      this.reader = new CommandReader({ maxLiteral: MAX_SCRIPT_BYTES + 1024 });
      this.secure = true;
      tls.once('close', () => {
        this.hangup.abort();
      });
    } catch (err) {
      this.log('tls-error', { session: this.id, ip: this.clientIp, error: errorText(err) });
      this.closed = true;
      this.stream.destroy();
      throw new Closed();
    }
    // RFC 5804 §2.2: after the TLS handshake the server re-issues its capabilities, then OK.
    await this.write(this.capabilities() + status('OK', 'TLS negotiation successful'));
  }

  private async authenticate(mechanism: string, initial: string | null): Promise<void> {
    if (mechanism.toUpperCase() !== 'PLAIN') {
      await this.write(status('NO', 'Only the PLAIN mechanism is supported'));
      return;
    }
    if (!this.secure) {
      await this.write(status('NO', 'Authentication needs TLS: use STARTTLS first', 'ENCRYPT-NEEDED'));
      return;
    }
    let response = initial;
    if (response === null) {
      // An empty challenge, then the client's response as a string (or "*" to cancel).
      await this.write('""\r\n');
      const ev = await this.nextEvent();
      if (ev === null) throw new Closed();
      if (ev.type === 'error' || ev.tokens.length !== 1 || ev.tokens[0]?.kind !== 'string') {
        await this.bad('Expected the SASL response as a string');
        return;
      }
      response = this.text(ev.tokens[0], 'the SASL response');
    }
    if (response === '*') {
      await this.write(status('NO', 'Authentication cancelled'));
      return;
    }
    if (response !== '' && (response.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(response))) {
      await this.bad('The SASL response is not valid base64');
      return;
    }
    const parts = Buffer.from(response, 'base64').toString('utf8').split('\0');
    let username = '';
    let password = '';
    if (parts.length === 3) {
      const [authz = '', authc = '', pass = ''] = parts;
      // Acting as another user (a different authorisation identity) is never allowed.
      if (authz === '' || authz.toLowerCase() === authc.toLowerCase()) {
        username = authc;
        password = pass;
      }
    }
    const r = await this.o.authenticate(username, password, this.clientIp, this.hangup.signal);
    if (!r.ok) {
      this.log('auth', { session: this.id, ip: this.clientIp, username, ok: false, reason: r.kind });
      switch (r.kind) {
        case 'aborted':
          throw new Closed();
        case 'locked':
          await this.write(status('NO', 'Too many failed attempts; try again later', 'TRYLATER'));
          return;
        case 'unavailable':
          await this.write(status('NO', 'Authentication is temporarily unavailable', 'TRYLATER'));
          return;
        default:
          this.authFailures++;
          if (this.authFailures >= (this.o.maxAuthFailures ?? 3)) {
            await this.write(status('BYE', 'Too many authentication failures'));
            this.close();
            return;
          }
          await this.write(status('NO', 'Authentication failed'));
          return;
      }
    }
    this.accountId = r.accountId;
    this.username = username;
    this.log('auth', { session: this.id, ip: this.clientIp, username, ok: true, accountId: r.accountId });
    await this.write(status('OK', 'Authenticated'));
  }
}
