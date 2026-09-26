// An attacker's SMTP client: raw bytes on a real socket (plaintext, STARTTLS or implicit TLS), the
// server's replies parsed strictly, and the two questions an adversarial test keeps asking — "did
// the server close on me?" and "did the server say anything I did not ask for?".
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { ReplyParser, type SmtpReply } from '@postroom/smtp-proto';

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export function codeOf(r: SmtpReply): string {
  return r.enhanced === undefined ? String(r.code) : `${String(r.code)} ${r.enhanced}`;
}

export class SmtpClient {
  private parser = new ReplyParser();
  private queue: SmtpReply[] = [];
  private waiter: (() => void) | null = null;
  private stream: Duplex;
  ended = false;
  /** Every reply the server ever sent on this connection, in order. */
  readonly transcript: SmtpReply[] = [];

  private readonly onData = (chunk: Buffer): void => {
    for (const r of this.parser.push(chunk)) {
      this.queue.push(r);
      this.transcript.push(r);
    }
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };

  private constructor(readonly socket: Socket) {
    this.stream = socket;
    this.attach(socket);
    socket.on('error', this.onEnd);
  }

  /** Plaintext connection; `prefix` is written before anything is read (a PROXY header). */
  static async plain(port: number, prefix?: Buffer): Promise<SmtpClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ port, host: '127.0.0.1' }, () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const c = new SmtpClient(socket);
    if (prefix) socket.write(prefix);
    return c;
  }

  /** Implicit TLS (465). */
  static async implicitTls(port: number): Promise<SmtpClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ port, host: '127.0.0.1' }, () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const c = new SmtpClient(socket);
    await c.upgrade();
    return c;
  }

  private attach(s: Duplex): void {
    s.on('data', this.onData);
    s.on('end', this.onEnd);
    s.on('close', this.onEnd);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next reply; throws if the connection closes (or `ms` passes) first. */
  async next(ms = 10_000): Promise<SmtpReply> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = this.queue.shift();
      if (r) return r;
      if (this.ended) throw new Error('connection closed before the next reply');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a reply');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  async cmd(line: string): Promise<SmtpReply> {
    this.write(`${line}\r\n`);
    return this.next();
  }

  write(data: string | Buffer): void {
    this.stream.write(data);
  }

  /** Replies that arrive within `ms` (nothing asked for). Used to prove the server stayed silent. */
  async unsolicited(ms = 300): Promise<SmtpReply[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.queue.splice(0);
  }

  /** True once the server has closed the connection (false if still open after `ms`). */
  async closed(ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.ended) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    return true;
  }

  /** Hand the plaintext socket to TLS (after a 220 to STARTTLS, or at once for 465). */
  async upgrade(): Promise<void> {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    const secure = await new Promise<Duplex>((resolve, reject) => {
      const t = tlsConnect({ socket: this.socket, rejectUnauthorized: false, servername: 'localhost' }, () => {
        t.off('error', reject);
        resolve(t);
      });
      t.once('error', reject);
    });
    secure.on('error', this.onEnd);
    this.parser = new ReplyParser();
    this.stream = secure;
    this.attach(secure);
  }

  close(): void {
    this.stream.destroy();
    this.socket.destroy();
  }
}
