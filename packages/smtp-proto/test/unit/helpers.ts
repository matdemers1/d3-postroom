import { duplexPair, type Duplex, type Readable } from 'node:stream';
import {
  ReplyParser,
  Replies,
  createServerSession,
  reply,
  type ServerHooks,
  type ServerSession,
  type ServerSessionOptions,
  type SmtpReply,
} from '../../src/index.js';

/** Collects replies from the client end of a pair, remembering which socket read each came in. */
export class ReplyCollector {
  readonly all: { reply: SmtpReply; read: number }[] = [];
  private readonly parser = new ReplyParser();
  private reads = 0;
  private cursor = 0;
  private waiter: (() => void) | null = null;
  ended = false;

  constructor(socket: Duplex) {
    socket.on('data', (chunk: Buffer) => {
      const read = this.reads++;
      for (const r of this.parser.push(chunk)) this.all.push({ reply: r, read });
      this.wake();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake();
    });
    socket.on('close', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async next(): Promise<SmtpReply> {
    for (;;) {
      const entry = this.all[this.cursor];
      if (entry) {
        this.cursor++;
        return entry.reply;
      }
      if (this.ended) throw new Error('connection ended before the next reply');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async take(n: number): Promise<SmtpReply[]> {
    const out: SmtpReply[] = [];
    for (let i = 0; i < n; i++) out.push(await this.next());
    return out;
  }

  /** Resolves once the server has closed the connection. */
  async closed(): Promise<void> {
    while (!this.ended) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

export async function drain(body: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

export const defaultHooks: ServerHooks = {
  onRcpt: () => Replies.rcptOk,
  onData: async (body) => {
    await drain(body);
    return reply(250, '2.0.0', 'Queued');
  },
};

export interface Harness {
  readonly session: ServerSession;
  readonly client: Duplex;
  readonly server: Duplex;
  readonly replies: ReplyCollector;
  send(text: string | Buffer): void;
}

export async function startSession(
  options: Partial<Omit<ServerSessionOptions, 'hooks'>> & { hooks?: Partial<ServerHooks> } = {},
): Promise<Harness> {
  const [server, client] = duplexPair();
  const { hooks, ...rest } = options;
  const session = createServerSession(server, {
    hostname: 'mx.test',
    maxSize: 10_000_000,
    ...rest,
    hooks: { ...defaultHooks, ...hooks },
  });
  const replies = new ReplyCollector(client);
  const greeting = await replies.next();
  if (greeting.code !== 220) throw new Error(`unexpected greeting ${String(greeting.code)}`);
  return {
    session,
    client,
    server,
    replies,
    send: (text) => {
      client.write(typeof text === 'string' ? Buffer.from(text, 'latin1') : text);
    },
  };
}
