// One outbound SMTP connection: TCP connect, framed replies with per-command deadlines, writes with
// backpressure, and the STARTTLS upgrade (RFC 3207). Every failure (timeout, close, a reply that
// cannot be framed, the attempt's abort signal) fails the whole connection at once: after any of
// them the client cannot know what the server has accepted, so the socket is destroyed and every
// pending read or write rejects with the same error.
//
// Routing is not this file's business. On the host the delivery container shares the WireGuard
// sidecar's network namespace, where nftables sends tcp/25 into wg0 and the Lightsail edge
// masquerades it (PST-REQ-019): a plain connect to port 25 egresses from the edge's static IP.
// What the code can do is record the local address the socket used (10.77.0.2 on the host).
import net from 'node:net';
import tls from 'node:tls';
import { ReplyParser, type SmtpReply } from '@postroom/smtp-proto';

export type Stage =
  | 'connect'
  | 'greeting'
  | 'ehlo'
  | 'helo'
  | 'starttls'
  | 'tls'
  | 'auth'
  | 'mail'
  | 'rcpt'
  | 'data'
  | 'data-body'
  | 'data-end'
  | 'quit';

export type FailureKind = 'connect' | 'timeout' | 'closed' | 'protocol' | 'tls' | 'aborted';

export class SmtpClientError extends Error {
  override readonly name = 'SmtpClientError';
  readonly kind: FailureKind;
  readonly stage: Stage;
  constructor(kind: FailureKind, stage: Stage, message: string, options?: ErrorOptions) {
    super(`${stage}: ${message}`, options);
    this.kind = kind;
    this.stage = stage;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'aborted';
}

export interface ConnectOptions {
  host: string;
  port: number;
  localAddress?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type Connector = (options: ConnectOptions) => Promise<net.Socket>;

/** Connect to an IP address (never a name: MX targets are resolved by @postroom/dns, not the OS). */
export const connectTcp: Connector = (options) =>
  new Promise<net.Socket>((resolve, reject) => {
    const { host, port, localAddress, timeoutMs, signal } = options;
    const family = net.isIP(host);
    if (family === 0) {
      reject(new SmtpClientError('connect', 'connect', `refusing to dial a name, not an address: ${host}`));
      return;
    }
    if (signal.aborted) {
      reject(new SmtpClientError('aborted', 'connect', abortReason(signal)));
      return;
    }
    const socket = net.connect({ host, port, family, ...(localAddress === undefined ? {} : { localAddress }) });
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error === undefined) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => { finish(); };
    const onError = (error: Error): void => {
      finish(new SmtpClientError('connect', 'connect', `${host}:${port}: ${error.message}`, { cause: error }));
    };
    const onAbort = (): void => { finish(new SmtpClientError('aborted', 'connect', abortReason(signal))); };
    const timer = setTimeout(() => {
      finish(new SmtpClientError('timeout', 'connect', `${host}:${port}: no connection within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });

interface PendingRead {
  resolve: (reply: SmtpReply) => void;
  reject: (error: Error) => void;
}

export class SmtpConnection {
  private readonly plain: net.Socket;
  private socket: net.Socket;
  private secure: tls.TLSSocket | null = null;
  private readonly parser = new ReplyParser();
  private readonly queue: SmtpReply[] = [];
  private pendingRead: PendingRead | null = null;
  private failure: Error | null = null;
  private readonly failListeners = new Set<(error: Error) => void>();
  private stage: Stage = 'greeting';
  private readonly signal: AbortSignal;
  /** Recorded at connect time: the socket's source address (the WireGuard tunnel address on the host). */
  readonly localAddress: string | undefined;
  readonly remoteAddress: string | undefined;

  private readonly onData = (chunk: Buffer): void => {
    if (this.failure !== null) return;
    let replies: SmtpReply[];
    try {
      replies = this.parser.push(chunk);
    } catch (error) {
      this.fail(new SmtpClientError('protocol', this.stage, `unparseable reply: ${errorText(error)}`, { cause: error }));
      return;
    }
    for (const reply of replies) {
      const waiting = this.pendingRead;
      if (waiting === null) {
        this.queue.push(reply);
      } else {
        this.pendingRead = null;
        waiting.resolve(reply);
      }
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(new SmtpClientError('closed', this.stage, `socket error: ${error.message}`, { cause: error }));
  };

  private readonly onClose = (): void => {
    this.fail(new SmtpClientError('closed', this.stage, 'connection closed'));
  };

  private readonly onAbort = (): void => {
    this.fail(new SmtpClientError('aborted', this.stage, abortReason(this.signal)));
  };

  constructor(socket: net.Socket, signal: AbortSignal) {
    this.plain = socket;
    this.socket = socket;
    this.signal = signal;
    this.localAddress = socket.localAddress;
    this.remoteAddress = socket.remoteAddress;
    socket.on('data', this.onData);
    // Stays attached for the life of the plain socket, including under TLS.
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    if (signal.aborted) this.onAbort();
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  get failed(): Error | null {
    return this.failure;
  }

  get tlsSocket(): tls.TLSSocket | null {
    return this.secure;
  }

  /** Run `listener` (once) when the connection fails; returns an unsubscribe. */
  onFail(listener: (error: Error) => void): () => void {
    if (this.failure !== null) {
      listener(this.failure);
      return () => undefined;
    }
    this.failListeners.add(listener);
    return () => { this.failListeners.delete(listener); };
  }

  /** Fail the connection: destroy the socket and reject everything pending with `error`. Idempotent. */
  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.signal.removeEventListener('abort', this.onAbort);
    const waiting = this.pendingRead;
    this.pendingRead = null;
    waiting?.reject(error);
    const listeners = [...this.failListeners];
    this.failListeners.clear();
    for (const listener of listeners) listener(error);
    this.socket.destroy();
    if (this.socket !== this.plain) this.plain.destroy();
  }

  /** Close the connection from our side (after QUIT, or when giving up on this MX). */
  destroy(reason = 'closed by the client'): void {
    this.fail(new SmtpClientError('closed', this.stage, reason));
  }

  /** The next complete reply, or a rejection when none arrives within `timeoutMs`. */
  read(stage: Stage, timeoutMs: number): Promise<SmtpReply> {
    this.stage = stage;
    if (this.failure !== null) return Promise.reject(this.failure);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.pendingRead !== null) return Promise.reject(new Error('SmtpConnection: concurrent read'));
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new SmtpClientError('timeout', stage, `no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingRead = {
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  /** Write one command line; CRLF is added here and a CR or LF inside the line is refused. */
  send(stage: Stage, line: string): void {
    this.stage = stage;
    if (this.failure !== null) throw this.failure;
    if (/[\r\n]/.test(line)) throw new SmtpClientError('protocol', stage, 'refusing to send a command containing CR or LF');
    this.socket.write(`${line}\r\n`, 'utf8');
  }

  async command(stage: Stage, line: string, timeoutMs: number): Promise<SmtpReply> {
    this.send(stage, line);
    return this.read(stage, timeoutMs);
  }

  /** Write body bytes, waiting for 'drain' (bounded by `timeoutMs`) when the socket buffer is full. */
  async write(stage: Stage, data: Uint8Array, timeoutMs: number): Promise<void> {
    this.stage = stage;
    if (this.failure !== null) throw this.failure;
    if (this.socket.write(data)) return;
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.onFail((error) => {
        clearTimeout(timer);
        socket.off('drain', onDrain);
        reject(error);
      });
      const timer = setTimeout(() => {
        this.fail(new SmtpClientError('timeout', stage, `data block not accepted within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once('drain', onDrain);
    });
  }

  /**
   * Upgrade to TLS after the server's 220 to STARTTLS. Any reply bytes already buffered at this
   * point were sent before the handshake, in plaintext, and would be read as if they came over TLS:
   * that is the STARTTLS response-injection attack, so the connection is dropped instead.
   */
  async startTls(options: tls.ConnectionOptions, timeoutMs: number): Promise<tls.TLSSocket> {
    this.stage = 'tls';
    if (this.failure !== null) throw this.failure;
    if (this.queue.length > 0 || this.parser.pending) {
      const error = new SmtpClientError('protocol', 'tls', 'plaintext bytes after the STARTTLS 220 reply (response injection?)');
      this.fail(error);
      throw error;
    }
    this.plain.off('data', this.onData);
    this.plain.off('close', this.onClose);
    const secure = tls.connect({ ...options, socket: this.plain });
    this.socket = secure;
    this.secure = secure;
    secure.on('error', this.onError);
    secure.on('close', this.onClose);
    await new Promise<void>((resolve, reject) => {
      const onSecure = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.onFail((error) => {
        clearTimeout(timer);
        secure.off('secureConnect', onSecure);
        reject(new SmtpClientError('tls', 'tls', `handshake failed: ${errorText(error)}`, { cause: error }));
      });
      const timer = setTimeout(() => {
        this.fail(new SmtpClientError('timeout', 'tls', `no TLS handshake within ${timeoutMs} ms`));
      }, timeoutMs);
      secure.once('secureConnect', onSecure);
    });
    secure.on('data', this.onData);
    return secure;
  }
}
