// A small scripted IMAP client for the integration tests: raw response text (literals inline), one
// command at a time, STARTTLS, APPEND with a synchronizing literal — and, when asked, a model of
// the selected mailbox's sequence numbers kept only from what the server says (EXISTS, EXPUNGE,
// FETCH UID), the way a real client has to.
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface Reply {
  /** Untagged and continuation responses, each as sent (CRLF-joined lines, literals inline, no final CRLF). */
  readonly untagged: string[];
  readonly tagged: string;
}

const LITERAL = /[~]?\{(\d+)\+?\}$/;

export class ImapClient {
  private buf = Buffer.alloc(0);
  private queue: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private n = 0;
  /** Sequence number − 1 → UID, when tracking. */
  model: number[] | null = null;
  /** Anything the server said that contradicts the model. */
  readonly violations: string[] = [];

  private constructor(private socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  static plain(port: number): Promise<ImapClient> {
    return new Promise((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => {
        s.off('error', reject);
        resolve(new ImapClient(s));
      });
      s.once('error', reject);
    });
  }

  static tls(port: number): Promise<ImapClient> {
    return new Promise((resolve, reject) => {
      const s = tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
        s.off('error', reject);
        resolve(new ImapClient(s));
      });
      s.once('error', reject);
    });
  }

  private attach(s: Socket | TLSSocket): void {
    s.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.split();
    });
    s.on('close', () => {
      this.closed = true;
      this.wake?.();
    });
    s.on('error', () => {
      this.closed = true;
      this.wake?.();
    });
  }

  private split(): void {
    let start = 0;
    let pos = 0;
    for (;;) {
      const nl = this.buf.indexOf('\r\n', pos);
      if (nl < 0) break;
      const line = this.buf.toString('latin1', pos, nl);
      const m = LITERAL.exec(line);
      if (m !== null) {
        const size = Number(m[1]);
        if (this.buf.length < nl + 2 + size) break;
        pos = nl + 2 + size;
        continue;
      }
      this.queue.push(this.buf.toString('utf8', start, nl));
      pos = nl + 2;
      start = pos;
    }
    this.buf = this.buf.subarray(start);
    if (this.queue.length > 0) this.wake?.();
  }

  /** The next response, or null when the connection closed. */
  async next(timeoutMs = 10_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (this.closed) return null;
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

  tag(): string {
    this.n++;
    return `A${String(this.n).padStart(3, '0')}`;
  }

  write(data: string | Buffer): void {
    this.socket.write(data);
  }

  /** Send `tag text` and collect everything up to the tagged response. */
  async command(text: string, tag = this.tag()): Promise<Reply> {
    this.write(`${tag} ${text}\r\n`);
    return this.collect(tag);
  }

  async collect(tag: string): Promise<Reply> {
    const untagged: string[] = [];
    for (;;) {
      const r = await this.next();
      if (r === null) throw new Error(`connection closed before ${tag} completed (got ${JSON.stringify(untagged)})`);
      if (r.startsWith(`${tag} `)) {
        await this.fillModel();
        return { untagged, tagged: r };
      }
      this.track(r);
      untagged.push(r);
    }
  }

  /** APPEND with a synchronizing literal. */
  async append(mailbox: string, message: Buffer, flags = '', tag = this.tag()): Promise<Reply> {
    this.write(`${tag} APPEND ${mailbox}${flags === '' ? '' : ` ${flags}`} {${message.length}}\r\n`);
    const cont = await this.next();
    if (cont === null) throw new Error('closed during APPEND');
    if (!cont.startsWith('+')) {
      await this.fillModel();
      return { untagged: [], tagged: cont };
    }
    this.write(Buffer.concat([message, Buffer.from('\r\n')]));
    return this.collect(tag);
  }

  async startTls(): Promise<Reply> {
    const tag = this.tag();
    this.write(`${tag} STARTTLS\r\n`);
    const r = await this.collect(tag);
    if (!r.tagged.startsWith(`${tag} OK`)) return r;
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('close');
    plain.removeAllListeners('error');
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ socket: plain, rejectUnauthorized: false }, () => {
        resolve(s);
      });
      s.once('error', reject);
    });
    this.buf = Buffer.alloc(0);
    this.attach(this.socket);
    return r;
  }

  close(): void {
    this.socket.destroy();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // --- the sequence-number model -----------------------------------------------------------------

  private pendingExists = 0;

  private track(r: string): void {
    if (this.model === null) return;
    let m = /^\* (\d+) EXPUNGE$/.exec(r);
    if (m !== null) {
      const seq = Number(m[1]);
      if (seq < 1 || seq > this.model.length) this.violations.push(`EXPUNGE ${seq} outside 1..${this.model.length}`);
      else this.model.splice(seq - 1, 1);
      if (this.pendingExists > 0) this.pendingExists--;
      return;
    }
    m = /^\* (\d+) EXISTS$/.exec(r);
    if (m !== null) {
      const n = Number(m[1]);
      if (n < this.model.length) this.violations.push(`EXISTS ${n} shrank the mailbox from ${this.model.length}`);
      this.pendingExists = Math.max(this.pendingExists, n);
      while (this.model.length < n) this.model.push(0);
      return;
    }
    m = /^\* (\d+) FETCH \(.*?UID (\d+)/.exec(r);
    if (m !== null) {
      const seq = Number(m[1]);
      const uid = Number(m[2]);
      const known = this.model[seq - 1];
      if (known === undefined) this.violations.push(`FETCH for ${seq} beyond EXISTS ${this.model.length}`);
      else if (known === 0) this.model[seq - 1] = uid;
      else if (known !== uid) this.violations.push(`FETCH says ${seq} is UID ${uid}, the model has ${known}`);
    }
  }

  /** After EXISTS the client learns the new UIDs the way real clients do: FETCH n:m (UID). */
  private async fillModel(): Promise<void> {
    if (this.model === null) return;
    const first = this.model.indexOf(0);
    this.pendingExists = 0;
    if (first < 0) return;
    const tag = this.tag();
    this.write(`${tag} FETCH ${first + 1}:${this.model.length} (UID)\r\n`);
    await this.collect(tag);
  }
}

/** The literal bodies inside a response, in order. */
export function literals(response: string): string[] {
  const out: string[] = [];
  const re = /\{(\d+)\}\r\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const size = Number(m[1]);
    const start = m.index + m[0].length;
    out.push(Buffer.from(response.slice(start), 'utf8').subarray(0, size).toString('utf8'));
  }
  return out;
}
