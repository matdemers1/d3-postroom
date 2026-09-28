// A minimal SMTP client for the tests: real sockets, real TLS (STARTTLS or implicit), strict reply
// parsing from @postroom/smtp-proto. Accepts the test's self-signed certificate.
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ReplyParser, type SmtpReply } from '@postroom/smtp-proto';

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/**
 * A Duplex over a socket whose first write is prefixed with `prefix` — so a PROXY v2 header and the
 * TLS ClientHello leave in ONE socket write, as the edge's forwarder may coalesce them (PST-T-4.17).
 */
class PrefixFirstWrite extends Duplex {
  constructor(
    private readonly socket: Socket,
    private prefix: Buffer | null,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      this.push(null);
    });
    socket.on('error', (err) => {
      this.destroy(err);
    });
    socket.on('close', () => {
      this.destroy();
    });
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const out = this.prefix === null ? chunk : Buffer.concat([this.prefix, chunk]);
    this.prefix = null;
    this.socket.write(out, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.socket.end(cb);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.socket.destroy();
    cb(err);
  }
}

export class SmtpTestClient {
  private parser = new ReplyParser();
  private queue: SmtpReply[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private readonly onData = (chunk: Buffer): void => {
    this.queue.push(...this.parser.push(chunk));
    this.wake();
  };
  private readonly onClose = (): void => {
    this.closed = true;
    this.wake();
  };

  private constructor(private socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('close', this.onClose);
    socket.on('error', () => {
      this.onClose();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** `prefix` (a PROXY header, say) is written as soon as the connection opens. */
  static async plain(port: number, prefix?: Buffer): Promise<SmtpTestClient> {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    const client = new SmtpTestClient(socket);
    if (prefix !== undefined) socket.write(prefix);
    return client;
  }

  /**
   * Implicit TLS (465). With `prefix`, it is sent before the handshake: in a write of its own, or —
   * `oneWrite` — in the same socket write as the ClientHello.
   */
  static async implicitTls(port: number, prefix?: Buffer, oneWrite = false): Promise<SmtpTestClient> {
    if (prefix === undefined) {
      const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
      await once(socket, 'secureConnect');
      return new SmtpTestClient(socket);
    }
    const raw = createConnection({ host: '127.0.0.1', port });
    raw.setNoDelay(true);
    await once(raw, 'connect');
    let under: Duplex = raw;
    if (oneWrite) under = new PrefixFirstWrite(raw, prefix);
    else raw.write(prefix);
    const socket = tlsConnect({ socket: under, rejectUnauthorized: false });
    await once(socket, 'secureConnect');
    return new SmtpTestClient(socket);
  }

  /** Resolves once the server closes the connection (true), or false after `timeoutMs`. */
  async closedWithin(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.closed;
  }

  /** Replies received and not yet read with next(). */
  get pending(): readonly SmtpReply[] {
    return this.queue;
  }

  /** Raw bytes, no CRLF added. */
  write(bytes: Buffer | string): void {
    this.socket.write(bytes);
  }

  get encrypted(): boolean {
    return 'encrypted' in this.socket && this.socket.encrypted;
  }

  async next(): Promise<SmtpReply> {
    for (;;) {
      const r = this.queue.shift();
      if (r !== undefined) return r;
      if (this.closed) throw new Error('connection closed');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async send(line: string): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    return this.next();
  }

  /** STARTTLS, then the TLS handshake over the same socket. */
  async startTls(): Promise<SmtpReply> {
    const r = await this.send('STARTTLS');
    if (r.code !== 220) return r;
    const plain = this.socket;
    plain.off('data', this.onData);
    plain.off('close', this.onClose);
    const secure = tlsConnect({ socket: plain, rejectUnauthorized: false });
    await once(secure, 'secureConnect');
    this.parser = new ReplyParser();
    this.attach(secure);
    return r;
  }

  /** DATA, the message (CRLF lines, dot-stuffed here), and the final reply. */
  async data(message: string): Promise<{ start: SmtpReply; final: SmtpReply | null }> {
    const start = await this.send('DATA');
    if (start.code !== 354) return { start, final: null };
    const stuffed = message.replace(/(^|\r\n)\./g, '$1..');
    this.socket.write(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    return { start, final: await this.next() };
  }

  close(): void {
    this.socket.destroy();
  }
}
