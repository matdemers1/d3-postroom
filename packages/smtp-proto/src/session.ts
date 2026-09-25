// The server session engine: greeting, EHLO/HELO, sequencing, pipelining, DATA streaming, AUTH
// exchange and STARTTLS, over any Duplex (net.Socket, tls.TLSSocket, or an in-memory pair).
//
// Policy is not here. MAIL, RCPT, DATA, AUTH and the TLS upgrade are async hooks that return
// replies; the engine enforces the protocol around them. `onRcpt` and `onData` are required so no
// daemon can end up relaying by default (PST-REQ-053 lives in the daemons, but the engine never
// accepts a recipient on its own).
//
// Pipelining (RFC 2920): commands are taken one at a time, strictly in order, and each is answered
// before the next is looked at. Replies are queued and written together when the input runs dry or
// at a sync point (354, 334, 220 STARTTLS, 221), so a pipelined group gets one write.
//
// Memory (PST-REQ-050): the engine pulls one socket read at a time and does not read again until
// the reader has consumed it; DATA bytes go to the hook as a Readable with a fixed high-water mark,
// and the socket is not read while that stream is full. `stats` records the high-water marks.

import { randomUUID } from 'node:crypto';
import { Readable, type Duplex } from 'node:stream';
import type { ForwardPath, ReversePath } from './address.js';
import { parseCommand, type MailParams, type RcptParams, type SmtpCommand } from './command.js';
import { SmtpLineReader, type DataRejection, type LineError, type LineReaderEvent } from './line-reader.js';
import { Replies, buildEhloReply, formatReply, reply, type SmtpReply } from './reply.js';

type Awaitable<T> = T | Promise<T>;

export interface Recipient {
  readonly to: ForwardPath;
  readonly params: RcptParams;
}

export interface Transaction {
  readonly from: ReversePath;
  readonly params: MailParams;
  /** Recipients the RCPT hook accepted (2xx). */
  readonly recipients: Recipient[];
}

export interface SessionContext {
  readonly id: string;
  readonly remoteAddress: string | undefined;
  /** True once TLS is active (implicit TLS on 465, or after STARTTLS). */
  secure: boolean;
  hello: { readonly verb: 'EHLO' | 'HELO'; readonly domain: string } | null;
  auth: { readonly mechanism: string; readonly identity: string } | null;
  transaction: Transaction | null;
}

export type AuthResult =
  | { readonly ok: true; readonly identity: string; readonly reply?: SmtpReply }
  | { readonly ok: false; readonly reply: SmtpReply };

/** The SASL exchange for one AUTH command. */
export interface SaslExchange {
  /**
   * Send `334 <base64>` and resolve with the client's next line (base64 text, unvalidated).
   * Rejects with `SaslCancelledError` when the client sends `*`; the engine answers 501.
   */
  challenge(base64: string): Promise<string>;
}

export interface ServerHooks {
  /** Return a non-220 reply (e.g. 554) to refuse the connection; the engine then closes. */
  onConnect?(ctx: Readonly<SessionContext>): Awaitable<SmtpReply | undefined>;
  onHello?(domain: string, verb: 'EHLO' | 'HELO', ctx: Readonly<SessionContext>): Awaitable<SmtpReply | undefined>;
  /** Default: accept with 250 2.1.0. */
  onMail?(from: ReversePath, params: MailParams, ctx: Readonly<SessionContext>): Awaitable<SmtpReply | undefined>;
  /** Required: recipient policy (and so relay policy) belongs to the daemon. */
  onRcpt(to: ForwardPath, params: RcptParams, ctx: Readonly<SessionContext>): Awaitable<SmtpReply>;
  /**
   * Required. `body` yields the dot-unstuffed message with backpressure. Return the final reply
   * only after the stream has ended (and after the message is durable — PST-REQ-060). If the
   * message turns out to be unacceptable at the protocol level (bare CR/LF, NUL, too large, or the
   * connection drops), `body` is destroyed with an error and the engine sends its own 5xx.
   */
  onData(body: Readable, ctx: Readonly<SessionContext>): Awaitable<SmtpReply>;
  onAuth?(
    request: { readonly mechanism: string; readonly initialResponse: string | undefined },
    sasl: SaslExchange,
    ctx: Readonly<SessionContext>,
  ): Awaitable<AuthResult>;
  /** Wrap the plaintext socket in TLS (see `tlsUpgrader`). Enables STARTTLS when present. */
  upgradeTls?(socket: Duplex): Promise<Duplex>;
  /** Called with every hook failure and socket error. The engine has already replied 4xx. */
  onError?(error: unknown, ctx: Readonly<SessionContext>): void;
}

export interface ServerCapabilities {
  readonly pipelining?: boolean;
  readonly eightBitMime?: boolean;
  readonly smtpUtf8?: boolean;
  readonly enhancedStatusCodes?: boolean;
  readonly dsn?: boolean;
  /** SASL mechanisms to advertise (only when `onAuth` is set), e.g. ['PLAIN', 'LOGIN']. */
  readonly auth?: readonly string[];
  /** Advertise and accept AUTH only over TLS. Default true. */
  readonly authRequiresTls?: boolean;
  /** Advertise STARTTLS when `upgradeTls` is set and the session is plaintext. Default true. */
  readonly startTls?: boolean;
}

export interface ServerSessionOptions {
  readonly hostname: string;
  /** Largest message, advertised as SIZE and enforced while receiving. */
  readonly maxSize: number;
  readonly hooks: ServerHooks;
  readonly capabilities?: ServerCapabilities;
  /** The socket is already TLS (port 465). */
  readonly secure?: boolean;
  readonly remoteAddress?: string;
  readonly greeting?: string;
  readonly maxLineLength?: number;
  readonly maxRecipients?: number;
  /** Close after this many error replies. Default 10. */
  readonly maxErrors?: number;
  /** Close after a bare CR/LF in a command line (after replying 500). Default true. */
  readonly closeOnBareLineEnding?: boolean;
  /** Idle time before 421 and close, in ms. Default 5 minutes (RFC 5321 §4.5.3.2.7). */
  readonly idleTimeoutMs?: number;
  /** High-water mark of the DATA body stream. Default 64 KiB. */
  readonly bodyHighWaterMark?: number;
}

export interface SessionStats {
  commands: number;
  /** Highest number of octets the line reader held at once. */
  maxReaderBuffered: number;
  /** Highest `readableLength` of a DATA body stream. */
  maxBodyBuffered: number;
  /** Octets thrown away when STARTTLS completed (PST-REQ-029). */
  discardedOnStartTls: number;
}

export interface ServerSession {
  readonly context: Readonly<SessionContext>;
  readonly stats: Readonly<SessionStats>;
  /** Resolves when the session has ended. Never rejects. */
  readonly done: Promise<void>;
  /** Send 421 (or `reply`) and close. */
  close(reply?: SmtpReply): void;
}

export class SaslCancelledError extends Error {
  override readonly name = 'SaslCancelledError';
}

/** The error a DATA body stream is destroyed with when the protocol layer rejects the message. */
export class SmtpDataRejectedError extends Error {
  override readonly name = 'SmtpDataRejectedError';
  constructor(readonly reason: DataRejection | 'connection-closed') {
    super(`message rejected: ${reason}`);
  }
}

class LineErrorDuringSasl extends Error {
  constructor(readonly error: LineError) {
    super(error);
  }
}
class ConnectionClosed extends Error {}

export function createServerSession(socket: Duplex, options: ServerSessionOptions): ServerSession {
  const engine = new Engine(socket, options);
  return engine;
}

type Pulled = Buffer | 'end' | 'timeout' | 'closed';

const HOOK_FAILED = Symbol('hook-failed');

class Engine implements ServerSession {
  readonly context: SessionContext;
  readonly stats: SessionStats = { commands: 0, maxReaderBuffered: 0, maxBodyBuffered: 0, discardedOnStartTls: 0 };
  readonly done: Promise<void>;

  private socket: Duplex;
  private reader: SmtpLineReader;
  private readonly hooks: ServerHooks;
  private readonly caps: Required<Omit<ServerCapabilities, 'auth'>> & { auth: readonly string[] };
  private outbox: string[] = [];
  private closed = false;
  private errors = 0;
  private wakePull: (() => void) | null = null;
  private readonly onSocketError = (err: unknown): void => {
    this.reportError(err);
  };

  constructor(
    socket: Duplex,
    private readonly options: ServerSessionOptions,
  ) {
    this.socket = socket;
    this.hooks = options.hooks;
    const c = options.capabilities ?? {};
    this.caps = {
      pipelining: c.pipelining ?? true,
      eightBitMime: c.eightBitMime ?? true,
      smtpUtf8: c.smtpUtf8 ?? true,
      enhancedStatusCodes: c.enhancedStatusCodes ?? true,
      dsn: c.dsn ?? false,
      auth: c.auth ?? [],
      authRequiresTls: c.authRequiresTls ?? true,
      startTls: c.startTls ?? true,
    };
    this.context = {
      id: randomUUID(),
      remoteAddress: options.remoteAddress,
      secure: options.secure ?? false,
      hello: null,
      auth: null,
      transaction: null,
    };
    this.reader = this.newReader();
    socket.on('error', this.onSocketError);
    this.done = this.run();
  }

  close(r: SmtpReply = Replies.shuttingDown): void {
    if (this.closed) return;
    this.send(r);
    void this.flush().finally(() => {
      this.finish();
    });
  }

  // --- plumbing ---------------------------------------------------------------------------------

  private newReader(): SmtpLineReader {
    return new SmtpLineReader(
      this.options.maxLineLength === undefined ? {} : { maxLineLength: this.options.maxLineLength },
    );
  }

  private reportError(err: unknown): void {
    this.hooks.onError?.(err, this.context);
  }

  private useEnhanced(): boolean {
    return this.caps.enhancedStatusCodes && this.context.hello?.verb === 'EHLO';
  }

  private send(r: SmtpReply): void {
    this.outbox.push(formatReply(r, { enhanced: this.useEnhanced() }));
  }

  /** Write queued replies; wait for drain so a peer that never reads cannot grow our buffers. */
  private async flush(): Promise<void> {
    if (this.outbox.length === 0 || this.socket.destroyed || this.socket.writableEnded) {
      this.outbox = [];
      return;
    }
    const data = this.outbox.join('');
    this.outbox = [];
    await new Promise<void>((resolve) => {
      const s = this.socket;
      const cleanup = (): void => {
        s.off('close', onDone);
        s.off('drain', onDone);
      };
      const onDone = (): void => {
        cleanup();
        resolve();
      };
      s.once('close', onDone);
      const ok = s.write(data, (err) => {
        if (err) {
          cleanup();
          resolve();
        }
      });
      if (ok) {
        cleanup();
        resolve();
      } else s.once('drain', onDone);
    });
  }

  /** One read from the socket, waiting if nothing is buffered. */
  private async pull(): Promise<Pulled> {
    for (;;) {
      if (this.closed) return 'closed';
      const s = this.socket;
      const chunk = s.read() as Buffer | string | null;
      if (chunk !== null) return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (s.readableEnded || s.destroyed) return 'end';
      const result = await new Promise<'readable' | 'end' | 'timeout' | 'closed'>((resolve) => {
        const timer = setTimeout(() => {
          done('timeout');
        }, this.options.idleTimeoutMs ?? 300_000);
        const onReadable = (): void => {
          done('readable');
        };
        const onEnd = (): void => {
          done('end');
        };
        const done = (r: 'readable' | 'end' | 'timeout' | 'closed'): void => {
          clearTimeout(timer);
          s.off('readable', onReadable);
          s.off('end', onEnd);
          s.off('close', onEnd);
          this.wakePull = null;
          resolve(r);
        };
        this.wakePull = () => {
          done('closed');
        };
        s.on('readable', onReadable);
        s.once('end', onEnd);
        s.once('close', onEnd);
      });
      if (result !== 'readable') return result;
    }
  }

  /** The next reader event; flushes queued replies before blocking on input. */
  private async nextEvent(): Promise<LineReaderEvent | Exclude<Pulled, Buffer>> {
    for (;;) {
      const ev = this.reader.next();
      if (ev) return ev;
      await this.flush();
      const got = await this.pull();
      if (!Buffer.isBuffer(got)) return got;
      this.reader.push(got);
      if (this.reader.maxBufferedBytes > this.stats.maxReaderBuffered) {
        this.stats.maxReaderBuffered = this.reader.maxBufferedBytes;
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakePull?.();
    const s = this.socket;
    if (!s.destroyed) {
      s.end(() => {
        s.destroy();
      });
    }
  }

  // --- main loop --------------------------------------------------------------------------------

  private async run(): Promise<void> {
    try {
      await Promise.resolve();
      const custom = await this.callHook(() => this.hooks.onConnect?.(this.context));
      const greeting =
        custom === HOOK_FAILED
          ? reply(421, '4.3.0', 'Service not available')
          : (custom ?? reply(220, undefined, `${this.options.hostname} ${this.options.greeting ?? 'ESMTP Postroom'}`));
      this.send(greeting);
      if (greeting.code !== 220) {
        await this.flush();
        return;
      }
      while (!this.closed) {
        const ev = await this.nextEvent();
        if (ev === 'end' || ev === 'closed') return;
        if (ev === 'timeout') {
          this.send(Replies.idleTimeout);
          await this.flush();
          return;
        }
        if (ev.type === 'line-error') {
          if (!(await this.lineError(ev.error))) return;
          continue;
        }
        if (ev.type !== 'line') continue; // DATA events cannot occur in command mode.
        this.stats.commands++;
        const keepGoing = await this.command(ev.line);
        if (!keepGoing) return;
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      // The error listener stays attached: a late socket error must never become an uncaught exception.
      if (!this.closed) {
        await this.flush();
        this.finish();
      }
    }
  }

  /** Reply to a malformed line. Returns false when the session must close. */
  private async lineError(error: LineError): Promise<boolean> {
    if (error === 'line-too-long') return this.errorReply(Replies.lineTooLong);
    this.send(Replies.bareLineEnding);
    if (this.options.closeOnBareLineEnding ?? true) {
      await this.flush();
      return false;
    }
    return this.errorReply(null);
  }

  /** Queue an error reply and count it. Returns false when the error budget is spent. */
  private errorReply(r: SmtpReply | null): boolean {
    if (r) this.send(r);
    this.errors++;
    if (this.errors >= (this.options.maxErrors ?? 10)) {
      this.send(Replies.tooManyErrors);
      return false;
    }
    return true;
  }

  private async callHook<T>(fn: () => Awaitable<T>): Promise<T | typeof HOOK_FAILED> {
    try {
      return await fn();
    } catch (err) {
      this.reportError(err);
      return HOOK_FAILED;
    }
  }

  private async command(line: Buffer): Promise<boolean> {
    const parsed = parseCommand(line, { smtputf8: this.context.transaction?.params.smtputf8 === true });
    if (!parsed.ok) return this.errorReply(parsed.reply);
    const cmd = parsed.command;
    switch (cmd.verb) {
      case 'EHLO':
      case 'HELO':
        return this.hello(cmd.verb, cmd.domain);
      case 'MAIL':
        return this.mail(cmd);
      case 'RCPT':
        return this.rcpt(cmd);
      case 'DATA':
        return this.data();
      case 'RSET':
        this.context.transaction = null;
        this.send(Replies.reset);
        return true;
      case 'NOOP':
        this.send(Replies.ok);
        return true;
      case 'VRFY':
        this.send(Replies.vrfy);
        return true;
      case 'HELP':
        this.send(Replies.help);
        return true;
      case 'QUIT':
        this.send(Replies.bye);
        await this.flush();
        return false;
      case 'STARTTLS':
        return this.startTls();
      case 'AUTH':
        return this.auth(cmd.mechanism, cmd.initialResponse);
    }
  }

  private capabilityLines(): string[] {
    const c = this.caps;
    const lines: string[] = [];
    if (c.pipelining) lines.push('PIPELINING');
    lines.push(`SIZE ${String(this.options.maxSize)}`);
    if (c.eightBitMime) lines.push('8BITMIME');
    if (c.smtpUtf8 && c.eightBitMime) lines.push('SMTPUTF8');
    if (c.enhancedStatusCodes) lines.push('ENHANCEDSTATUSCODES');
    if (c.dsn) lines.push('DSN');
    if (this.startTlsAvailable()) lines.push('STARTTLS');
    if (this.authAvailable() && (this.context.secure || !c.authRequiresTls)) {
      lines.push(`AUTH ${c.auth.join(' ')}`);
    }
    return lines;
  }

  private startTlsAvailable(): boolean {
    return this.caps.startTls && this.hooks.upgradeTls !== undefined && !this.context.secure;
  }

  private authAvailable(): boolean {
    return this.hooks.onAuth !== undefined && this.caps.auth.length > 0;
  }

  private async hello(verb: 'EHLO' | 'HELO', domain: string): Promise<boolean> {
    this.context.transaction = null;
    const r = await this.callHook(() => this.hooks.onHello?.(domain, verb, this.context));
    if (r === HOOK_FAILED) {
      this.send(Replies.localError);
      return true;
    }
    if (r !== undefined && r.code >= 400) {
      this.send(r);
      return true;
    }
    this.context.hello = { verb, domain };
    if (verb === 'HELO') this.send(reply(250, undefined, this.options.hostname));
    else this.send(buildEhloReply(this.options.hostname, `greets ${domain}`, this.capabilityLines()));
    return true;
  }

  /** Reject MAIL parameters the session did not advertise (RFC 5321 §4.1.1.11: 555). */
  private unadvertised(params: MailParams): string | null {
    const ehlo = this.context.hello?.verb === 'EHLO';
    if (!ehlo && Object.keys(params).length > 0) return 'parameters require EHLO';
    if (params.body === '8BITMIME' && !this.caps.eightBitMime) return 'BODY=8BITMIME';
    if (params.smtputf8 === true && !(this.caps.smtpUtf8 && this.caps.eightBitMime)) return 'SMTPUTF8';
    if ((params.ret !== undefined || params.envid !== undefined) && !this.caps.dsn) return 'RET/ENVID';
    if (params.auth !== undefined && !this.authAvailable()) return 'AUTH';
    return null;
  }

  private async mail(cmd: Extract<SmtpCommand, { verb: 'MAIL' }>): Promise<boolean> {
    if (!this.context.hello) return this.errorReply(Replies.ehloFirst);
    if (this.context.transaction) return this.errorReply(Replies.nestedMail);
    const bad = this.unadvertised(cmd.params);
    if (bad !== null) return this.errorReply(reply(555, '5.5.4', `Unsupported parameter: ${bad}`));
    if (cmd.params.size !== undefined && cmd.params.size > this.options.maxSize) {
      this.send(Replies.messageTooBig);
      return true;
    }
    const r = await this.callHook(() => this.hooks.onMail?.(cmd.from, cmd.params, this.context));
    if (r === HOOK_FAILED) {
      this.send(Replies.localError);
      return true;
    }
    const answer = r ?? Replies.mailOk;
    if (answer.code >= 200 && answer.code < 300) {
      this.context.transaction = { from: cmd.from, params: cmd.params, recipients: [] };
    }
    this.send(answer);
    return true;
  }

  private async rcpt(cmd: Extract<SmtpCommand, { verb: 'RCPT' }>): Promise<boolean> {
    const tx = this.context.transaction;
    if (!this.context.hello) return this.errorReply(Replies.ehloFirst);
    if (!tx) return this.errorReply(Replies.mailFirst);
    if ((cmd.params.notify !== undefined || cmd.params.orcpt !== undefined) && !this.caps.dsn) {
      return this.errorReply(reply(555, '5.5.4', 'Unsupported parameter: NOTIFY/ORCPT'));
    }
    if (tx.recipients.length >= (this.options.maxRecipients ?? 100)) {
      this.send(Replies.tooManyRecipients);
      return true;
    }
    const r = await this.callHook(() => this.hooks.onRcpt(cmd.to, cmd.params, this.context));
    if (r === HOOK_FAILED) {
      this.send(Replies.localError);
      return true;
    }
    if (r.code >= 200 && r.code < 300) tx.recipients.push({ to: cmd.to, params: cmd.params });
    this.send(r);
    return true;
  }

  private async data(): Promise<boolean> {
    const tx = this.context.transaction;
    if (!this.context.hello) return this.errorReply(Replies.ehloFirst);
    if (!tx) return this.errorReply(Replies.mailFirst);
    if (tx.recipients.length === 0) return this.errorReply(Replies.noValidRecipients);

    this.send(Replies.startData);
    await this.flush();
    this.reader.startData({ maxSize: this.options.maxSize });

    let wake: (() => void) | null = null;
    const poke = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const body = new Readable({ highWaterMark: this.options.bodyHighWaterMark ?? 65_536, read: poke });
    const state: { settled: { reply: SmtpReply } | { error: unknown } | null } = { settled: null };
    // The hook may never attach an error listener; a destroyed body must not crash the process.
    body.on('error', (err) => {
      if (!(err instanceof SmtpDataRejectedError)) this.reportError(err);
    });
    body.on('close', poke);
    const hook = Promise.resolve()
      .then(() => this.hooks.onData(body, this.context))
      .then(
        (r) => {
          state.settled = { reply: r };
        },
        (error: unknown) => {
          state.settled = { error };
        },
      )
      .finally(poke);

    let rejection: DataRejection | null = null;
    let end: Extract<LineReaderEvent, { type: 'data-end' }> | null = null;
    while (end === null) {
      const ev = await this.nextEvent();
      if (typeof ev === 'string') {
        // Connection gone (or idle) mid-DATA: the message is incomplete, never accepted.
        if (!body.destroyed) body.destroy(new SmtpDataRejectedError('connection-closed'));
        await hook;
        this.context.transaction = null;
        if (ev === 'timeout') this.send(Replies.idleTimeout);
        return false;
      }
      switch (ev.type) {
        case 'data':
          if (state.settled !== null || body.destroyed) break;
          if (!body.push(ev.chunk)) {
            if (body.readableLength > this.stats.maxBodyBuffered) this.stats.maxBodyBuffered = body.readableLength;
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (state.settled !== null || body.destroyed) poke();
            });
          } else if (body.readableLength > this.stats.maxBodyBuffered) {
            this.stats.maxBodyBuffered = body.readableLength;
          }
          break;
        case 'data-rejected':
          rejection ??= ev.reason;
          if (!body.destroyed) body.destroy(new SmtpDataRejectedError(ev.reason));
          break;
        case 'data-end':
          end = ev;
          break;
        default:
          break;
      }
    }
    rejection ??= end.rejection;
    // The transaction stays in the context until the hook has settled (it may read the envelope
    // while it stores the message); every branch below ends it.
    try {
      this.send(await this.finishData(body, hook, state, rejection));
    } finally {
      this.context.transaction = null;
    }
    return true;
  }

  private async finishData(
    body: Readable,
    hook: Promise<void>,
    state: { settled: { reply: SmtpReply } | { error: unknown } | null },
    rejection: DataRejection | null,
  ): Promise<SmtpReply> {

    if (rejection !== null) {
      if (!body.destroyed) body.destroy(new SmtpDataRejectedError(rejection));
      await hook;
      const s = state.settled;
      if (s && 'error' in s && !(s.error instanceof SmtpDataRejectedError)) this.reportError(s.error);
      return dataRejectionReply(rejection);
    }
    const early = state.settled;
    if (early !== null) {
      // The hook answered before the message was complete. Only a refusal can stand.
      if (!body.destroyed) body.destroy(new SmtpDataRejectedError('connection-closed'));
      if ('error' in early) {
        this.reportError(early.error);
        return Replies.localError;
      }
      return early.reply.code >= 400 ? early.reply : Replies.localError;
    }
    body.push(null);
    await hook;
    const final = state.settled;
    if (final === null || 'error' in final) {
      if (final !== null) this.reportError(final.error);
      return Replies.localError;
    }
    return final.reply;
  }

  private async auth(mechanism: string, initialResponse: string | undefined): Promise<boolean> {
    const hooks = this.hooks;
    if (!hooks.onAuth || !this.authAvailable()) return this.errorReply(Replies.authUnavailable);
    if (this.context.hello?.verb !== 'EHLO') return this.errorReply(Replies.ehloFirst);
    if (this.context.auth) return this.errorReply(Replies.alreadyAuthenticated);
    if (this.context.transaction) return this.errorReply(Replies.authInTransaction);
    if (this.caps.authRequiresTls && !this.context.secure) return this.errorReply(Replies.authNeedsTls);
    if (!this.caps.auth.includes(mechanism)) return this.errorReply(Replies.authMechanism);

    const sasl: SaslExchange = {
      challenge: async (b64: string): Promise<string> => {
        if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new TypeError('challenge must be base64');
        this.outbox.push(`334 ${b64}\r\n`);
        await this.flush();
        const ev = await this.nextEvent();
        if (typeof ev === 'string') throw new ConnectionClosed();
        if (ev.type === 'line-error') throw new LineErrorDuringSasl(ev.error);
        if (ev.type !== 'line') throw new ConnectionClosed();
        const text = ev.line.toString('latin1').trim();
        if (text === '*') throw new SaslCancelledError('client cancelled');
        return text;
      },
    };
    let result: AuthResult;
    try {
      // RFC 4954 §4: "=" is a zero-length initial response.
      const ir = initialResponse === '=' ? '' : initialResponse;
      result = await hooks.onAuth({ mechanism, initialResponse: ir }, sasl, this.context);
    } catch (err) {
      if (err instanceof SaslCancelledError) return this.errorReply(Replies.authCancelled);
      if (err instanceof LineErrorDuringSasl) return this.lineError(err.error);
      if (err instanceof ConnectionClosed) return false;
      this.reportError(err);
      this.send(Replies.authTempFail);
      return true;
    }
    if (result.ok) {
      this.context.auth = { mechanism, identity: result.identity };
      this.send(result.reply ?? Replies.authOk);
      return true;
    }
    return this.errorReply(result.reply);
  }

  /**
   * STARTTLS (RFC 3207, PST-REQ-029). Everything the client sent after the STARTTLS line in
   * plaintext — whether already in the reader or still in the socket's buffer — is discarded before
   * the 220 is written, then the socket is handed to the TLS hook and the session starts over.
   */
  private async startTls(): Promise<boolean> {
    const hooks = this.hooks;
    if (this.context.secure) return this.errorReply(Replies.alreadyTls);
    if (!hooks.upgradeTls || !this.startTlsAvailable()) return this.errorReply(Replies.tlsUnavailable);

    let discarded = this.reader.discardPending();
    for (;;) {
      const chunk = this.socket.read() as Buffer | string | null;
      if (chunk === null) break;
      discarded += chunk.length;
    }
    this.stats.discardedOnStartTls += discarded;

    this.send(Replies.startTls);
    await this.flush();
    const plain = this.socket;
    let secured: Duplex;
    try {
      secured = await hooks.upgradeTls(plain);
    } catch (err) {
      // The handshake failed; the stream is no longer usable as plaintext either.
      this.reportError(err);
      plain.destroy();
      return false;
    }
    // `plain` keeps its error listener: a late error on it must not crash the process.
    this.socket = secured;
    secured.on('error', this.onSocketError);
    this.reader = this.newReader();
    this.context.secure = true;
    this.context.hello = null;
    this.context.transaction = null;
    this.context.auth = null;
    return true;
  }
}

export function dataRejectionReply(reason: DataRejection): SmtpReply {
  switch (reason) {
    case 'bare-lf':
    case 'bare-cr':
      return Replies.bareLineEndingInData;
    case 'nul':
      return Replies.nulInData;
    case 'too-large':
      return Replies.messageTooBig;
  }
}
