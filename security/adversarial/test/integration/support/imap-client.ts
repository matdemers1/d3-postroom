// An attacker's IMAP client: raw bytes in, response lines out (literals kept inline), and STARTTLS
// done by hand so a test can pipeline whatever it likes behind the STARTTLS command.
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

const LITERAL = /[~]?\{(\d+)\+?\}$/;

export class ImapClient {
  private buf = Buffer.alloc(0);
  private queue: string[] = [];
  private wake: (() => void) | null = null;
  private stream: Duplex;
  ended = false;
  /** Every response line the server ever sent, in order. */
  readonly transcript: string[] = [];

  private constructor(readonly socket: Socket) {
    this.stream = socket;
    this.attach(socket);
  }

  static async plain(port: number, prefix?: Buffer): Promise<ImapClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const c = new ImapClient(socket);
    if (prefix) socket.write(prefix);
    return c;
  }

  static async implicitTls(port: number): Promise<ImapClient> {
    const c = await ImapClient.plain(port);
    await c.upgrade();
    return c;
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.split();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake?.();
  };

  private attach(s: Duplex): void {
    s.on('data', this.onData);
    s.on('close', this.onEnd);
    s.on('end', this.onEnd);
    s.on('error', this.onEnd);
  }

  private split(): void {
    let start = 0;
    let pos = 0;
    for (;;) {
      const nl = this.buf.indexOf('\r\n', pos);
      if (nl < 0) break;
      const m = LITERAL.exec(this.buf.toString('latin1', pos, nl));
      if (m !== null) {
        const size = Number(m[1]);
        if (this.buf.length < nl + 2 + size) break;
        pos = nl + 2 + size;
        continue;
      }
      const line = this.buf.toString('utf8', start, nl);
      this.queue.push(line);
      this.transcript.push(line);
      pos = nl + 2;
      start = pos;
    }
    this.buf = this.buf.subarray(start);
    if (this.queue.length > 0) this.wake?.();
  }

  /** The next response line, or null once the connection has closed. */
  async next(ms = 10_000): Promise<string | null> {
    const deadline = Date.now() + ms;
    while (this.queue.length === 0) {
      if (this.ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for the server');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          this.wake = null;
          resolve();
        };
      });
    }
    return this.queue.shift() ?? null;
  }

  write(data: string | Buffer): void {
    this.stream.write(data);
  }

  /** Everything up to and including the line tagged `tag` (throws if the server closes first). */
  async collect(tag: string, ms = 10_000): Promise<{ untagged: string[]; tagged: string }> {
    const untagged: string[] = [];
    for (;;) {
      const line = await this.next(ms);
      if (line === null) throw new Error(`closed before ${tag} completed: ${JSON.stringify(untagged)}`);
      if (line.startsWith(`${tag} `)) return { untagged, tagged: line };
      untagged.push(line);
    }
  }

  async command(tag: string, text: string): Promise<{ untagged: string[]; tagged: string }> {
    this.write(`${tag} ${text}\r\n`);
    return this.collect(tag);
  }

  /** Lines until the server closes (or `ms` passes). */
  async drain(ms = 3_000): Promise<string[]> {
    const out: string[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return out;
      let line: string | null;
      try {
        line = await this.next(left);
      } catch {
        return out;
      }
      if (line === null) return out;
      out.push(line);
    }
  }

  /** Lines that arrive within `ms` without being asked for. */
  async unsolicited(ms = 300): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.queue.splice(0);
  }

  async closed(ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.ended) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  /** TLS over the current socket (after the tagged OK to STARTTLS, or at once for 993). */
  async upgrade(): Promise<void> {
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onEnd);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onEnd);
    const secure = await new Promise<Duplex>((resolve, reject) => {
      const t = tlsConnect({ socket: this.socket, rejectUnauthorized: false, servername: 'localhost' }, () => {
        t.off('error', reject);
        resolve(t);
      });
      t.once('error', reject);
    });
    this.buf = Buffer.alloc(0);
    this.stream = secure;
    this.attach(secure);
  }

  close(): void {
    this.stream.destroy();
    this.socket.destroy();
  }
}
