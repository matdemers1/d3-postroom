// A minimal SMTP client for the tests: real sockets, real TLS (STARTTLS or implicit), strict reply
// parsing from @postroom/smtp-proto. Accepts the test's self-signed certificate.
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ReplyParser, type SmtpReply } from '@postroom/smtp-proto';

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

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

  static async plain(port: number): Promise<SmtpTestClient> {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    return new SmtpTestClient(socket);
  }

  static async implicitTls(port: number): Promise<SmtpTestClient> {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    await once(socket, 'secureConnect');
    return new SmtpTestClient(socket);
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
