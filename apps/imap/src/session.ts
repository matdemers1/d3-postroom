// One IMAP connection: not-authenticated → authenticated → selected → logout (RFC 9051 §3).
//
//   PST-REQ-070  IMAP4rev1 and IMAP4rev2 are both advertised; a session behaves as rev1 until the
//                client sends ENABLE IMAP4rev2 (UTF-8 names, ESEARCH for SEARCH, no RECENT/UNSEEN
//                in SELECT, [CLOSED] on reselect).
//   PST-REQ-027  LOGIN and AUTHENTICATE PLAIN take app passwords (scope imap) only, and only over
//                TLS: before it, LOGINDISABLED is advertised and both answer NO [PRIVACYREQUIRED].
//   PST-REQ-075  every credential check goes through the shared throttle (see server.ts).
//   PST-REQ-072  UIDs and modseqs: see store.ts; sequence numbers: see view.ts.
//
// Commands run strictly one at a time, in order. After every command in the selected state the
// view is synced with the database before the tagged response, so changes by other sessions arrive
// as untagged EXISTS / EXPUNGE / FETCH at the points RFC 9051 §7.5.1 allows.
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, type Duplex } from 'node:stream';
import type { SecureContext } from 'node:tls';
import type { BlobStore } from '@postroom/blobstore';
import type { SpecialUse } from '@postroom/db';
import {
  capabilityResponse,
  CommandReader,
  continuationResponse,
  dateTimeToDate,
  enabledResponse,
  esearchResponse,
  fetchResponse,
  flagsResponse,
  idResponse,
  listResponse,
  namespaceResponse,
  numberResponse,
  parseAppendPrefix,
  parseCommand,
  parseSaslResponse,
  searchResponse,
  sequenceSetFromNumbers,
  statusResponse,
  taggedResponse,
  untaggedStatus,
  vanishedResponse,
  writeResponse,
  type Command,
  type CommandName,
  type QresyncParams,
  type ReaderEvent,
  type Response,
  type ResponseCode,
  type StatusAtt,
  type Value,
} from '@postroom/imap-proto';
import { CapabilityRegistry, type CommandOutcome, type ExtensionSession } from './capabilities.js';
import { createStructureCache, type StructureCache } from './content.js';
import { CONDSTORE, enablesCondstore, mentionsModseq, withModseq } from './extensions/condstore.js';
import { QRESYNC, qresyncSelectResponses, vanishedSince } from './extensions/qresync.js';
import { runFetch } from './fetch.js';
import { normalizeFlags, SYSTEM_FLAGS } from './flags.js';
import { ChunkSource, TimeoutError, upgradeToTls } from './io.js';
import { listMailboxes, listStatusItems, lsubMailboxes } from './list.js';
import { canonicalName, invalidNameReason, specialUseFromAttribute, stripTrailingDelimiter } from './names.js';
import { search } from './search.js';
import { StructureScanner } from './structure.js';
import { denormalise, MailboxGoneError, type ActorMeta, type MailboxInfo, type MailStore } from './store.js';
import { MailboxView } from './view.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type AuthOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly kind: 'failed' | 'locked' | 'unavailable' | 'aborted' };

/** Checks one set of credentials, throttled (server.ts wires credentials + auth-throttle). */
export type Authenticator = (username: string, password: string, ip: string, signal: AbortSignal) => Promise<AuthOutcome>;

export interface SessionOptions {
  readonly store: MailStore;
  readonly blobs: Pick<BlobStore, 'put' | 'get' | 'release'>;
  readonly structures?: StructureCache;
  readonly authenticate: Authenticator;
  /** Null: no certificate, so no STARTTLS — and so no login on a plaintext port. */
  readonly secureContext: SecureContext | null;
  readonly registry?: CapabilityRegistry;
  readonly log?: Log;
  /** RFC 9051 §5.4: at least 30 minutes once authenticated. */
  readonly idleTimeoutMs?: number;
  readonly preauthTimeoutMs?: number;
  readonly maxAppendSize?: number;
  /** BAD responses before the connection is dropped. */
  readonly maxBadCommands?: number;
}

type State = 'not-authenticated' | 'authenticated' | 'selected' | 'logout';

const ANY_STATE = new Set<CommandName>(['CAPABILITY', 'NOOP', 'LOGOUT', 'ID']);
const NOT_AUTHENTICATED = new Set<CommandName>(['STARTTLS', 'LOGIN', 'AUTHENTICATE']);
const AUTHENTICATED = new Set<CommandName>([
  'ENABLE',
  'SELECT',
  'EXAMINE',
  'CREATE',
  'DELETE',
  'RENAME',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'LIST',
  'LSUB',
  'STATUS',
  'APPEND',
  'NAMESPACE',
  'IDLE',
]);
const SELECTED = new Set<CommandName>(['CHECK', 'CLOSE', 'UNSELECT', 'EXPUNGE', 'UID EXPUNGE', 'SEARCH', 'FETCH', 'STORE', 'COPY', 'MOVE']);

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_PREAUTH_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_APPEND_SIZE = 100 * 1000 * 1000;

interface Outcome {
  readonly status: 'OK' | 'NO' | 'BAD';
  readonly text: string;
  readonly code?: ResponseCode | null;
  /** Sync the selected mailbox before the tagged response (default true). */
  readonly sync?: boolean;
  /** The tagged response was already written (STARTTLS, LOGOUT). */
  readonly skipTagged?: boolean;
}

function ok(text: string, code: ResponseCode | null = null): Outcome {
  return { status: 'OK', text, code };
}

function no(text: string, code: ResponseCode | null = null): Outcome {
  return { status: 'NO', text, code };
}

function bad(text: string, code: ResponseCode | null = null): Outcome {
  return { status: 'BAD', text, code };
}

const noLog: Log = () => undefined;

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

class Closed extends Error {
  constructor() {
    super('connection closed');
  }
}

export class ImapSession {
  readonly id = randomUUID().replace(/-/g, '').slice(0, 12);
  private stream: Duplex;
  private source: ChunkSource;
  private reader: CommandReader;
  private secure: boolean;
  private state: State = 'not-authenticated';
  private accountId: string | null = null;
  private username: string | null = null;
  private rev2 = false;
  private utf8 = false;
  private readonly enabled = new Set<string>();
  private view: MailboxView | null = null;
  private saved: number[] | null = null;
  private closed = false;
  private badCommands = 0;
  private commands = 0;
  private readonly hangup = new AbortController();
  private readonly structures: StructureCache;
  private readonly registry: CapabilityRegistry;
  private readonly log: Log;
  private readonly idleTimeoutMs: number;
  private readonly preauthTimeoutMs: number;
  private readonly maxAppendSize: number;
  private readonly maxBadCommands: number;
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
    this.structures = o.structures ?? createStructureCache(o.blobs);
    this.registry = o.registry ?? new CapabilityRegistry();
    this.log = o.log ?? noLog;
    this.idleTimeoutMs = o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.preauthTimeoutMs = o.preauthTimeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS;
    this.maxAppendSize = o.maxAppendSize ?? DEFAULT_MAX_APPEND_SIZE;
    this.maxBadCommands = o.maxBadCommands ?? 20;
    this.reader = this.newReader();
    stream.once('close', () => {
      this.hangup.abort();
    });
    this.done = this.run();
  }

  /** Server shutdown: say goodbye and close. */
  async shutdown(text = 'Server shutting down'): Promise<void> {
    if (this.closed) return;
    await this.write(untaggedStatus('BYE', text)).catch(() => undefined);
    this.close();
  }

  get isAuthenticated(): boolean {
    return this.accountId !== null;
  }

  private newReader(): CommandReader {
    return new CommandReader({ literalMode: 'literal-', maxAppendSize: this.maxAppendSize });
  }

  private capabilities(): string[] {
    return this.registry.list({
      secure: this.secure,
      startTlsAvailable: this.o.secureContext !== null,
      authenticated: this.state !== 'not-authenticated',
    });
  }

  private timeout(): number {
    return this.state === 'not-authenticated' ? this.preauthTimeoutMs : this.idleTimeoutMs;
  }

  private async run(): Promise<void> {
    const started = Date.now();
    try {
      await this.write(untaggedStatus('OK', 'Postroom IMAP ready', { type: 'CAPABILITY', capabilities: this.capabilities() }));
      while (!this.closed) {
        const ev = await this.nextEvent();
        if (ev === null) break;
        await this.onEvent(ev);
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        await this.write(untaggedStatus('BYE', 'Autologout; idle for too long')).catch(() => undefined);
      } else if (!(err instanceof Closed)) {
        this.log('session-error', { session: this.id, ip: this.clientIp, error: errorText(err) });
      }
    } finally {
      this.close();
      this.log('session', {
        session: this.id,
        ip: this.clientIp,
        user: this.username,
        tls: this.secure,
        rev2: this.rev2,
        commands: this.commands,
        durationMs: Date.now() - started,
      });
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'logout';
    this.source.detach();
    this.stream.end();
    const s = this.stream;
    setTimeout(() => {
      s.destroy();
    }, 1_000).unref();
  }

  private async write(resp: Response): Promise<void> {
    if (this.stream.destroyed) throw new Closed();
    await writeResponse(resp, this.stream);
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

  private async onEvent(ev: ReaderEvent): Promise<void> {
    switch (ev.type) {
      case 'command':
        await this.onCommand(ev.bytes);
        return;
      case 'continue':
        await this.write(continuationResponse('Ready for literal data'));
        return;
      case 'append-begin':
        await this.onAppend(ev);
        return;
      case 'error': {
        const e = ev.error;
        if (e.fatal) {
          await this.write(untaggedStatus('BYE', e.message));
          this.close();
          return;
        }
        if (e.code === 'literal-too-large' && e.tag !== null) {
          await this.write(taggedResponse(e.tag, 'NO', e.message, { type: 'TOOBIG' }));
          return;
        }
        await this.countBad();
        await this.write(e.tag === null ? untaggedStatus('BAD', e.message) : taggedResponse(e.tag, 'BAD', e.message));
        return;
      }
      default:
        // append-data / append-end / raw-line outside the exchange that asked for them: nothing to do.
        return;
    }
  }

  private async countBad(): Promise<void> {
    this.badCommands++;
    if (this.badCommands >= this.maxBadCommands) {
      await this.write(untaggedStatus('BYE', 'Too many invalid commands'));
      this.close();
    }
  }

  private async onCommand(bytes: Buffer): Promise<void> {
    this.commands++;
    const parsed = parseCommand(bytes, { utf8: this.utf8 });
    if (!parsed.ok) {
      await this.write(parsed.tag === null ? untaggedStatus('BAD', parsed.message) : taggedResponse(parsed.tag, 'BAD', parsed.message));
      await this.countBad();
      return;
    }
    const cmd = parsed.command;
    let outcome: Outcome;
    try {
      outcome = await this.dispatch(cmd);
    } catch (err) {
      if (err instanceof Closed || this.stream.destroyed) throw new Closed();
      // IDLE ran past its limit: the session says BYE (see run()).
      if (err instanceof TimeoutError) throw err;
      if (err instanceof MailboxGoneError) {
        outcome = no('Mailbox no longer exists', { type: 'NONEXISTENT' });
      } else {
        this.log('command-error', { session: this.id, command: cmd.name, error: errorText(err) });
        outcome = no('Internal error', { type: 'SERVERBUG' });
      }
    }
    if (this.closed) return;
    await this.finish(cmd, outcome);
  }

  private async finish(cmd: Command, outcome: Outcome): Promise<void> {
    if (outcome.skipTagged === true) return;
    if (this.state === 'selected' && outcome.sync !== false) {
      const numbered = !(cmd.name === 'FETCH' || cmd.name === 'STORE' || cmd.name === 'SEARCH') || cmd.uid;
      await this.syncSelected(numbered);
      if (this.closed) return;
    }
    if (outcome.status === 'BAD') await this.countBad();
    if (this.closed) return;
    await this.write(taggedResponse(cmd.tag, outcome.status, outcome.text, outcome.code ?? null));
  }

  private async syncSelected(allowExpunge: boolean): Promise<void> {
    const view = this.view;
    if (view === null) return;
    const result = await view.sync(this.o.store, {
      allowExpunge,
      utf8: this.utf8,
      condstore: this.enabled.has(CONDSTORE),
      qresync: this.enabled.has(QRESYNC),
    });
    if (result.gone) {
      await this.write(untaggedStatus('BYE', 'The selected mailbox was deleted'));
      this.close();
      return;
    }
    for (const r of result.responses) await this.write(r);
  }

  private meta(): ActorMeta {
    if (this.accountId === null) throw new Error('not authenticated');
    return { accountId: this.accountId, ip: this.clientIp };
  }

  private allowed(name: CommandName): boolean {
    if (ANY_STATE.has(name)) return true;
    if (NOT_AUTHENTICATED.has(name)) return this.state === 'not-authenticated';
    if (AUTHENTICATED.has(name)) return this.state === 'authenticated' || this.state === 'selected';
    if (SELECTED.has(name)) return this.state === 'selected';
    return false;
  }

  private extensionSession(): ExtensionSession {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below needs the session, not the literal
    const self = this;
    return {
      get closed() {
        return self.closed;
      },
      close: () => {
        this.close();
      },
      accountId: this.accountId,
      selectedMailboxId: this.view?.mailboxId ?? null,
      utf8: this.utf8,
      enabled: this.enabled,
      write: (r) => this.write(r),
      syncSelected: (allow) => this.syncSelected(allow),
      readRawLine: async (timeoutMs) => {
        this.reader.expectRawLine();
        for (;;) {
          const ev = this.reader.next();
          if (ev !== null) return ev.type === 'raw-line' ? ev.line : null;
          const chunk = await this.source.read(timeoutMs);
          if (chunk === null) return null;
          this.reader.push(chunk);
        }
      },
    };
  }

  private async dispatch(cmd: Command): Promise<Outcome> {
    const ext = this.registry.handler(cmd.name);
    if (ext !== undefined) {
      const r: CommandOutcome = await ext(cmd, this.extensionSession());
      return { status: r.status, text: r.text };
    }
    if (!this.allowed(cmd.name)) {
      return bad(this.state === 'not-authenticated' ? 'Authenticate first' : `${cmd.name} is not valid in this state`);
    }
    // RFC 7162 §3.1: the first CONDSTORE enabling command makes the session CONDSTORE-aware.
    if (enablesCondstore(cmd)) this.enabled.add(CONDSTORE);
    switch (cmd.name) {
      case 'CAPABILITY':
        await this.write(capabilityResponse(this.capabilities()));
        return ok('CAPABILITY completed');
      case 'NOOP':
        return ok('NOOP completed');
      case 'LOGOUT':
        await this.write(untaggedStatus('BYE', 'Logging out'));
        await this.write(taggedResponse(cmd.tag, 'OK', 'LOGOUT completed'));
        this.close();
        return { status: 'OK', text: '', skipTagged: true };
      case 'ID':
        await this.write(
          idResponse([
            ['name', 'Postroom'],
            ['vendor', 'Postroom'],
            ['support-url', 'https://github.com/matdemers1/d3-postroom'],
          ]),
        );
        return ok('ID completed');
      case 'STARTTLS':
        return this.startTls(cmd.tag);
      case 'LOGIN':
        return this.login(cmd.username, cmd.password);
      case 'AUTHENTICATE':
        return this.authenticatePlain(cmd.mechanism, cmd.initialResponse);
      case 'ENABLE':
        return this.enable(cmd.capabilities);
      case 'SELECT':
      case 'EXAMINE':
        return this.select(cmd.mailbox, cmd.name === 'EXAMINE', cmd.qresync);
      case 'CREATE':
        return this.create(cmd.mailbox, cmd.specialUse);
      case 'DELETE':
        return this.deleteMailbox(cmd.mailbox);
      case 'RENAME':
        return this.rename(cmd.from, cmd.to);
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE': {
        const found = await this.o.store.setSubscribed(this.meta().accountId, canonicalName(cmd.mailbox), cmd.name === 'SUBSCRIBE');
        return found ? ok(`${cmd.name} completed`) : no('No such mailbox', { type: 'NONEXISTENT' });
      }
      case 'LIST':
        return this.list(cmd);
      case 'LSUB':
        return this.lsub(cmd.reference, cmd.pattern);
      case 'STATUS':
        return this.status(cmd.mailbox, cmd.items);
      case 'NAMESPACE':
        await this.write(namespaceResponse([['', '/']], null, null, { utf8: this.utf8 }));
        return ok('NAMESPACE completed');
      case 'APPEND':
        return bad('APPEND message data must follow as a literal');
      case 'IDLE':
        return bad('IDLE is not supported');
      case 'CHECK':
        return ok('CHECK completed');
      case 'CLOSE':
      case 'UNSELECT':
        return this.closeMailbox(cmd.name === 'CLOSE');
      case 'EXPUNGE':
        return this.expunge(null);
      case 'UID EXPUNGE':
        return this.expunge(cmd.set);
      case 'SEARCH':
        return this.search(cmd);
      case 'FETCH':
        return this.fetch(cmd);
      case 'STORE':
        return this.store(cmd);
      case 'COPY':
      case 'MOVE':
        return this.copyOrMove(cmd);
    }
  }

  // --- not authenticated ------------------------------------------------------------------------

  private async startTls(tag: string): Promise<Outcome> {
    if (this.secure) return bad('TLS is already active');
    if (this.o.secureContext === null) return no('TLS is not available');
    await this.write(taggedResponse(tag, 'OK', 'Begin TLS negotiation now'));
    // Anything the client pipelined after STARTTLS is discarded with the old reader (RFC 9051 §6.2.1).
    this.source.detach();
    try {
      const tls = await upgradeToTls(this.stream, this.o.secureContext);
      this.stream = tls;
      this.source = new ChunkSource(tls);
      this.reader = this.newReader();
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
    // The tagged OK is already out; finish() must not send another.
    return { status: 'OK', text: '', sync: false, skipTagged: true };
  }

  private async login(username: string, password: string): Promise<Outcome> {
    if (!this.secure) return no('LOGIN is disabled until TLS is active (STARTTLS)', { type: 'PRIVACYREQUIRED' });
    return this.completeAuth(username, password);
  }

  private async authenticatePlain(mechanism: string, initial: string | null): Promise<Outcome> {
    if (mechanism.toUpperCase() !== 'PLAIN') return no('Unsupported authentication mechanism', { type: 'CANNOT' });
    if (!this.secure) return no('Authentication is disabled until TLS is active (STARTTLS)', { type: 'PRIVACYREQUIRED' });
    let data: Buffer;
    if (initial === null) {
      await this.write(continuationResponse(''));
      this.reader.expectRawLine();
      const ev = await this.nextEvent();
      if (ev === null) throw new Closed();
      if (ev.type !== 'raw-line') return bad('Expected a SASL response');
      const resp = parseSaslResponse(ev.line);
      if (resp.type === 'cancel') return bad('Authentication cancelled');
      if (resp.type === 'invalid') return bad('Invalid base64 in the SASL response');
      data = resp.data;
    } else {
      if (initial !== '' && (initial.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(initial))) return bad('Invalid base64 in the initial response');
      data = Buffer.from(initial, 'base64');
    }
    const parts = data.toString('utf8').split('\0');
    if (parts.length !== 3) return this.completeAuth('', '');
    const [authz = '', authc = '', password = ''] = parts;
    if (authz !== '' && authz.toLowerCase() !== authc.toLowerCase()) return this.completeAuth('', '');
    return this.completeAuth(authc, password);
  }

  private async completeAuth(username: string, password: string): Promise<Outcome> {
    const r = await this.o.authenticate(username, password, this.clientIp, this.hangup.signal);
    if (!r.ok) {
      this.log('auth', { session: this.id, ip: this.clientIp, username, ok: false, reason: r.kind });
      switch (r.kind) {
        case 'aborted':
          throw new Closed();
        case 'locked':
          return no('Too many failed attempts; try again later', { type: 'UNAVAILABLE' });
        case 'unavailable':
          return no('Authentication is temporarily unavailable', { type: 'UNAVAILABLE' });
        default:
          return no('Authentication failed', { type: 'AUTHENTICATIONFAILED' });
      }
    }
    this.accountId = r.accountId;
    this.username = username;
    this.state = 'authenticated';
    this.log('auth', { session: this.id, ip: this.clientIp, username, ok: true, accountId: r.accountId });
    return ok('Logged in', { type: 'CAPABILITY', capabilities: this.capabilities() });
  }

  // --- authenticated ------------------------------------------------------------------------------

  private async enable(names: readonly string[]): Promise<Outcome> {
    const allowed = this.registry.enableable();
    const now: string[] = [];
    for (const n of names) {
      const upper = n.toUpperCase();
      if (!allowed.has(upper) || this.enabled.has(upper)) continue;
      this.enabled.add(upper);
      if (upper === 'IMAP4REV2') {
        this.rev2 = true;
        this.utf8 = true;
        now.push('IMAP4rev2');
      } else {
        if (upper === 'UTF8=ACCEPT') this.utf8 = true;
        // QRESYNC implies CONDSTORE (RFC 7162 §3.2.3).
        if (upper === QRESYNC) this.enabled.add(CONDSTORE);
        now.push(upper);
      }
    }
    await this.write(enabledResponse(now));
    return ok('ENABLE completed');
  }

  private async select(name: string, readOnly: boolean, qresync: QresyncParams | null): Promise<Outcome> {
    if (this.view !== null) {
      this.view = null;
      this.saved = null;
      this.state = 'authenticated';
      if (this.rev2 || this.enabled.has(QRESYNC)) await this.write(untaggedStatus('OK', 'Previous mailbox is now closed', { type: 'CLOSED' }));
    }
    if (qresync !== null && !this.enabled.has(QRESYNC)) return bad('QRESYNC is not enabled');
    const mb = await this.o.store.findMailbox(this.meta().accountId, canonicalName(name));
    if (mb === null) return no('No such mailbox', { type: 'NONEXISTENT' });
    const opened = await MailboxView.open(this.o.store, mb, readOnly);
    const keywords = await this.o.store.keywords(mb.id);
    const flags = [...SYSTEM_FLAGS, ...keywords];
    await this.write(flagsResponse(flags));
    await this.write(numberResponse(opened.view.exists, 'EXISTS'));
    if (!this.rev2) {
      await this.write(numberResponse(0, 'RECENT'));
      if (opened.firstUnseen !== null) {
        await this.write(untaggedStatus('OK', `Message ${opened.firstUnseen} is first unseen`, { type: 'UNSEEN', value: opened.firstUnseen }));
      }
    }
    await this.write(untaggedStatus('OK', 'UIDs valid', { type: 'UIDVALIDITY', value: mb.uidvalidity }));
    await this.write(untaggedStatus('OK', 'Predicted next UID', { type: 'UIDNEXT', value: opened.uidnext }));
    await this.write(
      untaggedStatus('OK', readOnly ? 'No permanent flags permitted' : 'Flags permitted', {
        type: 'PERMANENTFLAGS',
        flags: readOnly ? [] : [...flags, '\\*'],
      }),
    );
    await this.write(untaggedStatus('OK', 'Highest', { type: 'HIGHESTMODSEQ', value: opened.highestModseq }));
    if (qresync !== null) {
      for (const r of await qresyncSelectResponses(this.o.store, opened.view, qresync, opened.uidnext)) await this.write(r);
    }
    this.view = opened.view;
    this.saved = null;
    this.state = 'selected';
    return ok(`${readOnly ? 'EXAMINE' : 'SELECT'} completed`, { type: readOnly ? 'READ-ONLY' : 'READ-WRITE' });
  }

  private async create(raw: string, specialUse: readonly string[] | null): Promise<Outcome> {
    const name = canonicalName(stripTrailingDelimiter(raw));
    if (name === 'INBOX') return no('INBOX already exists', { type: 'ALREADYEXISTS' });
    const invalid = invalidNameReason(name);
    if (invalid !== null) return no(invalid, { type: 'CANNOT' });
    let use: SpecialUse | null = null;
    for (const attr of specialUse ?? []) {
      const u = specialUseFromAttribute(attr);
      if (u === undefined) return no(`Special use ${attr} is not supported`, { type: 'USEATTR' });
      use = u;
    }
    const r = await this.o.store.createMailbox(this.meta(), name, use);
    return r.ok ? ok('CREATE completed') : no('Mailbox already exists', { type: 'ALREADYEXISTS' });
  }

  private async deleteMailbox(raw: string): Promise<Outcome> {
    const name = canonicalName(raw);
    const selected = this.view !== null && this.view.name === name;
    const r = await this.o.store.deleteMailbox(this.meta(), name);
    switch (r) {
      case 'nonexistent':
        return no('No such mailbox', { type: 'NONEXISTENT' });
      case 'inbox':
        return no('INBOX cannot be deleted', { type: 'CANNOT' });
      case 'special':
        return no('A special-use mailbox cannot be deleted', { type: 'CANNOT' });
      case 'children':
        return no('Delete its child mailboxes first', { type: 'HASCHILDREN' });
      case 'ok':
        if (selected) {
          this.view = null;
          this.saved = null;
          this.state = 'authenticated';
          if (this.rev2) await this.write(untaggedStatus('OK', 'The selected mailbox is closed', { type: 'CLOSED' }));
        }
        return ok('DELETE completed');
    }
  }

  private async rename(rawFrom: string, rawTo: string): Promise<Outcome> {
    const from = canonicalName(rawFrom);
    const to = canonicalName(stripTrailingDelimiter(rawTo));
    if (to === 'INBOX') return no('INBOX already exists', { type: 'ALREADYEXISTS' });
    const invalid = invalidNameReason(to);
    if (invalid !== null) return no(invalid, { type: 'CANNOT' });
    const r = await this.o.store.renameMailbox(this.meta(), from, to);
    switch (r) {
      case 'nonexistent':
        return no('No such mailbox', { type: 'NONEXISTENT' });
      case 'exists':
        return no('Target mailbox already exists', { type: 'ALREADYEXISTS' });
      case 'into-self':
        return no('A mailbox cannot be moved inside itself', { type: 'CANNOT' });
      case 'ok':
        return ok('RENAME completed');
    }
  }

  private async list(cmd: Extract<Command, { name: 'LIST' }>): Promise<Outcome> {
    const plain = cmd.selection === null && cmd.returnOpts === null;
    if (plain && cmd.patterns.length === 1 && cmd.patterns[0] === '') {
      await this.write(listResponse({ attributes: ['\\Noselect'], delimiter: '/', name: '' }, { utf8: this.utf8 }));
      return ok('LIST completed');
    }
    const all = await this.o.store.listMailboxes(this.meta().accountId);
    const statusItems = listStatusItems(cmd);
    for (const line of listMailboxes(all, cmd)) {
      const extended: Value[] = line.childInfo ? ['CHILDINFO', ['SUBSCRIBED']] : [];
      await this.write(listResponse({ attributes: line.attributes, delimiter: '/', name: line.name, extended }, { utf8: this.utf8 }));
      if (statusItems !== null && line.mailbox !== null) await this.writeStatus(line.mailbox, statusItems);
    }
    return ok('LIST completed');
  }

  private async lsub(reference: string, pattern: string): Promise<Outcome> {
    const all = await this.o.store.listMailboxes(this.meta().accountId);
    for (const line of lsubMailboxes(all, reference, pattern)) {
      await this.write(listResponse({ attributes: line.attributes, delimiter: '/', name: line.name }, { utf8: this.utf8 }, 'LSUB'));
    }
    return ok('LSUB completed');
  }

  private async status(raw: string, items: readonly StatusAtt[]): Promise<Outcome> {
    const mb = await this.o.store.findMailbox(this.meta().accountId, canonicalName(raw));
    if (mb === null) return no('No such mailbox', { type: 'NONEXISTENT' });
    await this.writeStatus(mb, items);
    return ok('STATUS completed');
  }

  private async writeStatus(mb: MailboxInfo, items: readonly StatusAtt[]): Promise<void> {
    const needCounts = items.some((i) => i === 'MESSAGES' || i === 'UNSEEN' || i === 'DELETED' || i === 'SIZE');
    const counts = needCounts ? await this.o.store.counts(mb.id) : null;
    const out: [string, number | bigint][] = [];
    for (const item of items) {
      switch (item) {
        case 'MESSAGES':
          out.push([item, counts?.messages ?? 0]);
          break;
        case 'RECENT':
          out.push([item, 0]);
          break;
        case 'UIDNEXT':
          out.push([item, mb.uidnext]);
          break;
        case 'UIDVALIDITY':
          out.push([item, mb.uidvalidity]);
          break;
        case 'UNSEEN':
          out.push([item, counts?.unseen ?? 0]);
          break;
        case 'DELETED':
          out.push([item, counts?.deleted ?? 0]);
          break;
        case 'SIZE':
          out.push([item, counts?.size ?? 0]);
          break;
        case 'HIGHESTMODSEQ':
          out.push([item, mb.highestModseq]);
          break;
        case 'APPENDLIMIT':
          out.push([item, this.maxAppendSize]);
          break;
      }
    }
    await this.write(statusResponse(mb.name, out, { utf8: this.utf8 }));
  }

  // --- APPEND (streamed) --------------------------------------------------------------------------

  private async onAppend(ev: Extract<ReaderEvent, { type: 'append-begin' }>): Promise<void> {
    this.commands++;
    const tag = ev.tag ?? '*';
    const refuse = async (outcome: Outcome): Promise<void> => {
      if (ev.synchronizing && this.reader.rejectLiteral()) {
        await this.finishTag(tag, outcome);
        return;
      }
      // A non-synchronizing literal is on its way regardless: read past it, then answer.
      await this.drainAppend();
      await this.finishTag(tag, outcome);
    };
    if (ev.continued) {
      await refuse(bad('MULTIAPPEND is not supported'));
      return;
    }
    const prefix = parseAppendPrefix(ev.prefix, { utf8: this.utf8 });
    if (!prefix.ok) {
      await refuse(bad(prefix.message));
      return;
    }
    if (this.state !== 'authenticated' && this.state !== 'selected') {
      await refuse(bad(this.state === 'not-authenticated' ? 'Authenticate first' : 'APPEND is not valid in this state'));
      return;
    }
    if (ev.size === 0) {
      await refuse(bad('An empty message cannot be appended'));
      return;
    }
    const mb = await this.o.store.findMailbox(this.meta().accountId, canonicalName(prefix.mailbox));
    if (mb === null) {
      await refuse(no('No such mailbox', { type: 'TRYCREATE' }));
      return;
    }
    if (ev.synchronizing) await this.write(continuationResponse('Ready for the message'));

    const pass = new PassThrough();
    const scanner = new StructureScanner();
    let putError: unknown = null;
    const putting = this.o.blobs.put(pass).catch((err: unknown) => {
      putError = err;
      return null;
    });
    let failed: Outcome | null = null;
    let stray: ReaderEvent | null = null;
    for (;;) {
      const next = await this.nextEvent();
      if (next === null) {
        pass.destroy(new Error('client disconnected during APPEND'));
        await putting;
        throw new Closed();
      }
      if (next.type === 'append-data') {
        const chunk = Buffer.from(next.chunk);
        scanner.write(chunk);
        if (putError === null && !pass.write(chunk)) {
          await Promise.race([once(pass, 'drain'), putting]);
        }
        continue;
      }
      if (next.type === 'append-end') {
        if (next.trailing.length > 0) failed = bad('Unexpected data after the message literal');
        break;
      }
      if (next.type === 'append-begin' && next.continued) {
        failed = bad('MULTIAPPEND is not supported');
        if (next.synchronizing && this.reader.rejectLiteral()) break;
        continue;
      }
      // Anything else (a reader error) ends the APPEND; handle it once the blob is dealt with.
      failed = bad('APPEND interrupted');
      stray = next;
      break;
    }
    pass.end();
    const put = await putting;
    if (put === null) {
      this.log('append-error', { session: this.id, error: errorText(putError) });
      await this.finishTag(tag, no('The message could not be stored', { type: 'SERVERBUG' }));
      if (stray !== null) await this.onEvent(stray);
      return;
    }
    if (failed !== null) {
      await this.o.blobs.release(put.sha256);
      await this.finishTag(tag, failed);
      if (stray !== null) await this.onEvent(stray);
      return;
    }
    const structure = scanner.end();
    this.structures.put(put.sha256, structure);
    const flags = normalizeFlags(prefix.flags ?? []);
    let filed: { uid: number; uidvalidity: number };
    try {
      filed = await this.o.store.append(this.meta().accountId, mb.id, {
        sha256: put.sha256,
        size: put.size,
        flags,
        internalDate: prefix.date === null ? new Date() : dateTimeToDate(prefix.date),
        denorm: denormalise(structure.root.headers),
      });
    } catch (err) {
      await this.o.blobs.release(put.sha256);
      if (err instanceof MailboxGoneError) {
        await this.finishTag(tag, no('No such mailbox', { type: 'TRYCREATE' }));
        return;
      }
      throw err;
    }
    await this.finishTag(
      tag,
      ok('APPEND completed', { type: 'APPENDUID', uidValidity: filed.uidvalidity, uids: sequenceSetFromNumbers([filed.uid]) }),
    );
  }

  /** Discard the rest of an APPEND the client is sending regardless. */
  private async drainAppend(): Promise<void> {
    for (;;) {
      const next = await this.nextEvent();
      if (next === null) throw new Closed();
      if (next.type === 'append-data') continue;
      if (next.type === 'append-begin' && next.continued) {
        if (next.synchronizing && this.reader.rejectLiteral()) return;
        continue;
      }
      if (next.type === 'append-end') return;
      await this.onEvent(next);
      return;
    }
  }

  /** Tagged completion for an event-driven command (APPEND), with the usual selected-state sync. */
  private async finishTag(tag: string, outcome: Outcome): Promise<void> {
    if (this.state === 'selected') {
      await this.syncSelected(true);
      if (this.closed) return;
    }
    if (outcome.status === 'BAD') await this.countBad();
    if (this.closed) return;
    await this.write(taggedResponse(tag, outcome.status, outcome.text, outcome.code ?? null));
  }

  // --- selected -----------------------------------------------------------------------------------

  private selected(): MailboxView {
    if (this.view === null) throw new Error('no mailbox selected');
    return this.view;
  }

  private async closeMailbox(expunge: boolean): Promise<Outcome> {
    const view = this.selected();
    if (expunge && !view.readOnly) {
      // CLOSE expunges silently (no untagged EXPUNGE), and is audited like EXPUNGE.
      await this.o.store.expunge(this.meta(), view.mailboxId, null, 'CLOSE');
    }
    this.view = null;
    this.saved = null;
    this.state = 'authenticated';
    return { ...ok(`${expunge ? 'CLOSE' : 'UNSELECT'} completed`), sync: false };
  }

  private async expunge(set: Extract<Command, { name: 'UID EXPUNGE' }>['set'] | null): Promise<Outcome> {
    const view = this.selected();
    if (view.readOnly) return no('The mailbox is read-only', { type: 'READ-ONLY' });
    const uids = set === null ? null : view.resolveUids(set, this.saved).filter(([, u]) => !view.isExpunged(u)).map(([, u]) => u);
    const removed = await this.o.store.expunge(this.meta(), view.mailboxId, uids, set === null ? 'EXPUNGE' : 'UID EXPUNGE');
    for (const r of view.expungeNow(removed, this.enabled.has(QRESYNC))) await this.write(r);
    return ok(`${set === null ? 'EXPUNGE' : 'UID EXPUNGE'} completed`);
  }

  private async search(cmd: Extract<Command, { name: 'SEARCH' }>): Promise<Outcome> {
    const view = this.selected();
    if (cmd.charset !== null && !['UTF-8', 'US-ASCII'].includes(cmd.charset.toUpperCase())) {
      return no('Unsupported charset', { type: 'BADCHARSET', charsets: ['UTF-8', 'US-ASCII'] });
    }
    const uids = await search(
      { store: this.o.store, structures: this.structures, blobs: this.o.blobs, view, saved: this.saved },
      cmd.criteria,
    );
    const numbers = cmd.uid ? uids : uids.map((u) => view.seqOf(u) ?? 0).filter((n) => n > 0);
    // RFC 7162 §3.1.5: a MODSEQ search reports the highest mod-sequence of what it found.
    let modseq: bigint | null = null;
    if (uids.length > 0 && mentionsModseq(cmd.criteria)) {
      for (const r of await this.o.store.rowsByUids(view.mailboxId, uids)) if (modseq === null || r.modseq > modseq) modseq = r.modseq;
    }
    const opts = cmd.returnOpts;
    if (opts === null && !this.rev2) {
      await this.write(searchResponse(numbers, modseq));
      return ok('SEARCH completed');
    }
    const wanted = new Set(opts === null || opts.length === 0 ? ['ALL'] : opts);
    if (wanted.has('SAVE')) {
      const onlyMinMax = !wanted.has('ALL') && !wanted.has('COUNT') && (wanted.has('MIN') || wanted.has('MAX'));
      if (onlyMinMax) {
        const kept: number[] = [];
        if (wanted.has('MIN') && uids[0] !== undefined) kept.push(uids[0]);
        const last = uids[uids.length - 1];
        if (wanted.has('MAX') && last !== undefined && !kept.includes(last)) kept.push(last);
        this.saved = kept;
      } else {
        this.saved = uids;
      }
      if (wanted.size === 1) return ok('SEARCH completed, result saved');
    }
    await this.write(
      esearchResponse({
        tag: cmd.tag,
        uid: cmd.uid,
        ...(wanted.has('MIN') ? { min: numbers[0] ?? null } : {}),
        ...(wanted.has('MAX') ? { max: numbers[numbers.length - 1] ?? null } : {}),
        ...(wanted.has('COUNT') ? { count: numbers.length } : {}),
        ...(wanted.has('ALL') ? { all: numbers } : {}),
        modseq,
      }),
    );
    return ok('SEARCH completed');
  }

  private async fetch(original: Extract<Command, { name: 'FETCH' }>): Promise<Outcome> {
    const view = this.selected();
    const cmd = withModseq(original, this.enabled.has(CONDSTORE));
    if (cmd.vanished) {
      // UID FETCH … (CHANGEDSINCE m VANISHED): the set's expunges since m first (RFC 7162 §3.2.6).
      if (!this.enabled.has(QRESYNC)) return bad('VANISHED requires ENABLE QRESYNC');
      const uidnext = (await this.o.store.probe(view.mailboxId))?.uidnext ?? view.maxUid + 1;
      const set = cmd.set.type === 'saved' ? sequenceSetFromNumbers(this.saved ?? []) : cmd.set;
      const gone = await vanishedSince(this.o.store, view.mailboxId, cmd.changedSince ?? 0n, set, uidnext);
      if (gone.length > 0) await this.write(vanishedResponse(gone, true));
    }
    const r = await runFetch(
      {
        store: this.o.store,
        structures: this.structures,
        blobs: this.o.blobs,
        view,
        utf8: this.utf8,
        condstore: this.enabled.has(CONDSTORE),
        saved: this.saved,
        write: (resp) => this.write(resp),
      },
      cmd,
    );
    return { status: r.status, text: r.text, code: r.code };
  }

  private async store(cmd: Extract<Command, { name: 'STORE' }>): Promise<Outcome> {
    const view = this.selected();
    if (view.readOnly) return no('The mailbox is read-only', { type: 'READ-ONLY' });
    const pairs = (cmd.uid ? view.resolveUids(cmd.set, this.saved) : view.resolveSeqs(cmd.set, this.saved)).filter(([, u]) => !view.isExpunged(u));
    const res = await this.o.store.storeFlags(
      view.mailboxId,
      pairs.map(([, u]) => u),
      cmd.operation,
      cmd.flags,
      cmd.unchangedSince,
    );
    const seqs = new Map(pairs.map(([s, u]) => [u, s]));
    for (const row of res.rows) {
      view.noteModseq(row.uid, row.modseq);
      if (cmd.silent) continue;
      const seq = seqs.get(row.uid);
      if (seq === undefined) continue;
      await this.write(
        fetchResponse(seq, [
          ...(cmd.uid ? [{ name: 'UID' as const, value: row.uid }] : []),
          { name: 'FLAGS', flags: row.flags },
          ...(cmd.unchangedSince !== null || this.enabled.has(CONDSTORE) ? [{ name: 'MODSEQ' as const, value: row.modseq }] : []),
        ]),
      );
    }
    if (res.modified.length > 0) {
      const modified = cmd.uid ? res.modified : res.modified.map((u) => seqs.get(u) ?? 0).filter((n) => n > 0);
      return ok('Some messages were modified since', { type: 'MODIFIED', set: sequenceSetFromNumbers(modified) });
    }
    const missing = pairs.length > res.rows.length;
    return missing ? ok('Some messages were expunged by another session', { type: 'EXPUNGEISSUED' }) : ok('STORE completed');
  }

  private async copyOrMove(cmd: Extract<Command, { name: 'COPY' | 'MOVE' }>): Promise<Outcome> {
    const view = this.selected();
    const move = cmd.name === 'MOVE';
    if (move && view.readOnly) return no('The mailbox is read-only', { type: 'READ-ONLY' });
    const target = await this.o.store.findMailbox(this.meta().accountId, canonicalName(cmd.mailbox));
    if (target === null) return no('No such mailbox', { type: 'TRYCREATE' });
    const uids = (cmd.uid ? view.resolveUids(cmd.set, this.saved) : view.resolveSeqs(cmd.set, this.saved))
      .filter(([, u]) => !view.isExpunged(u))
      .map(([, u]) => u);
    if (uids.length === 0) return ok(`${cmd.name} completed (no messages)`);
    const r = move ? await this.o.store.move(view.mailboxId, uids, target.id) : await this.o.store.copy(view.mailboxId, uids, target.id);
    if (r.pairs.length === 0) return ok(`${cmd.name} completed (no messages)`);
    const code: ResponseCode = {
      type: 'COPYUID',
      uidValidity: r.uidvalidity,
      source: sequenceSetFromNumbers(r.pairs.map(([s]) => s)),
      dest: sequenceSetFromNumbers(r.pairs.map(([, d]) => d)),
    };
    if (!move) return ok('COPY completed', code);
    await this.write(untaggedStatus('OK', 'Moved', code));
    for (const resp of view.expungeNow(
      r.pairs.map(([s]) => s),
      this.enabled.has(QRESYNC),
    ))
      await this.write(resp);
    return ok('MOVE completed');
  }
}
