// A minimal SMTP test client over loopback: raw writes, parsed replies, and a close signal.
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { ReplyParser, type SmtpReply } from '@postroom/smtp-proto';

export class TestClient {
  private parser = new ReplyParser();
  private queue: SmtpReply[] = [];
  private waiter: (() => void) | null = null;
  ended = false;
  private stream: Duplex;
  private readonly onData = (chunk: Buffer): void => {
    for (const r of this.parser.push(chunk)) this.queue.push(r);
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };

  constructor(readonly socket: Socket) {
    this.stream = socket;
    this.attach(socket);
    socket.on('error', () => {
      this.onEnd();
    });
  }

  static async open(port: number, prefix?: Buffer): Promise<TestClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ port, host: '127.0.0.1' }, () => { resolve(s); });
      s.once('error', reject);
    });
    const client = new TestClient(socket);
    if (prefix) socket.write(prefix);
    return client;
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

  async next(): Promise<SmtpReply> {
    for (;;) {
      const r = this.queue.shift();
      if (r) return r;
      if (this.ended) throw new Error('connection closed before the next reply');
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }

  /** Send one command line and return its reply. */
  async cmd(line: string): Promise<SmtpReply> {
    this.write(`${line}\r\n`);
    return this.next();
  }

  write(data: string | Buffer): void {
    this.stream.write(data);
  }

  /** Write with backpressure. */
  async writeAsync(data: Buffer): Promise<void> {
    if (!this.stream.write(data)) await new Promise<void>((resolve) => this.stream.once('drain', resolve));
  }

  /** Resolves once the server has closed the connection (with a deadline). */
  async closed(ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.ended) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 50);
      });
    }
    return true;
  }

  /** Upgrade after a 220 to STARTTLS. */
  async startTls(): Promise<void> {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    const secure = await new Promise<Duplex>((resolve, reject) => {
      const t = tlsConnect({ socket: this.socket, rejectUnauthorized: false, servername: 'mx.test' }, () => { resolve(t); });
      t.once('error', reject);
    });
    this.parser = new ReplyParser();
    this.stream = secure;
    this.attach(secure);
  }

  end(): void {
    this.stream.end();
    this.socket.destroy();
  }

  async quit(): Promise<SmtpReply> {
    const r = await this.cmd('QUIT');
    this.end();
    return r;
  }
}

export function codeOf(r: SmtpReply): string {
  return r.enhanced === undefined ? String(r.code) : `${String(r.code)} ${r.enhanced}`;
}
