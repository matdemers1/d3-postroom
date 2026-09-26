// A real ManageSieve daemon on loopback for the integration tests: a throwaway database, a
// self-signed certificate (openssl), accounts with app passwords, and a scripted client.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createManageSieveServer, type ManageSieveServer, type ManageSieveServerOptions } from '../../src/server.js';

const exec = promisify(execFile);

export const PEPPER = 'test-pepper-managesieve-0123456789';
export const WEB_PASSWORD = 'correct horse battery staple';
const OPERATOR = { kind: 'system', label: 'test' } as const;

export interface Account {
  readonly id: string;
  readonly address: string;
  readonly appPassword: string;
}

export interface Harness {
  readonly t: TestDatabase;
  readonly db: Db;
  readonly server: ManageSieveServer;
  readonly port: number;
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  /** Another server on the same database (PROXY and throttle tests). */
  serverWith(overrides: Partial<ManageSieveServerOptions>): Promise<{ server: ManageSieveServer; port: number }>;
  close(): Promise<void>;
}

export async function startHarness(prefix: string, throttle?: AuthThrottle): Promise<Harness> {
  const t = await createTestDatabase(process.env['DATABASE_URL'] ?? '', prefix);
  const db = t.db;
  await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await exec('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
  ]);
  const tls = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
  const logs: Harness['logs'] = [];
  const base: ManageSieveServerOptions = {
    db,
    pepper: PEPPER,
    tls,
    edgePeers: ['10.255.255.254'],
    throttle: throttle ?? createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 10_000 }),
    log: (event, fields = {}) => logs.push({ event, fields }),
  };
  const open: ManageSieveServer[] = [];
  const start = async (o: ManageSieveServerOptions): Promise<{ server: ManageSieveServer; port: number }> => {
    const server = createManageSieveServer(o);
    open.push(server);
    return { server, port: (await server.listen(0, '127.0.0.1')).port };
  };
  const main = await start(base);
  return {
    t,
    db,
    server: main.server,
    port: main.port,
    logs,
    serverWith: (overrides) => start({ ...base, ...overrides }),
    close: async () => {
      for (const s of open) await s.close();
      await t.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A person with a primary address and an app password with the given scopes. */
export async function makeAccount(h: Harness, scopes: ('imap' | 'smtp' | 'dav' | 'sieve')[] = ['sieve']): Promise<Account> {
  const login = `u${randomInt(1e9).toString(36)}`;
  const d = await h.db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
  const account = await h.db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword(WEB_PASSWORD, PEPPER) } });
  await h.db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
  const created = await createAppPassword(h.db, OPERATOR, { accountId: account.id, label: 'Thunderbird', scopes }, { pepper: PEPPER });
  return { id: account.id, address: `${login}@d3cloud.io`, appPassword: created.password };
}

export const plain = (user: string, password: string): string => Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');

/** One server response: every line up to and including the final OK/NO/BYE, literals inline. */
export interface Reply {
  readonly lines: string[];
  /** The final OK/NO/BYE line. */
  readonly status: string;
}

const FINAL = /^(OK|NO|BYE)\b/;
const LITERAL = /\{(\d+)\}$/;

/** A scripted ManageSieve client: raw lines, STARTTLS, and literals in responses. */
export class SieveClient {
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  closed = false;

  private constructor(private socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  static connect(port: number): Promise<SieveClient> {
    return new Promise((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => {
        s.off('error', reject);
        resolve(new SieveClient(s));
      });
      s.once('error', reject);
    });
  }

  /** Wrap an already-connected socket (a PROXY header was written first). */
  static over(socket: Socket): SieveClient {
    return new SieveClient(socket);
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
    for (;;) {
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) break;
      const head = this.buf.toString('utf8', 0, nl);
      const m = LITERAL.exec(head);
      if (m !== null) {
        const size = Number(m[1]);
        if (this.buf.length < nl + 2 + size) break;
        this.lines.push(`${head}\r\n${this.buf.toString('utf8', nl + 2, nl + 2 + size)}`);
        this.buf = this.buf.subarray(nl + 2 + size);
        continue;
      }
      this.lines.push(head);
      this.buf = this.buf.subarray(nl + 2);
    }
    this.wake?.();
  }

  private async line(timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const l = this.lines.shift();
      if (l !== undefined) return l;
      if (this.closed) throw new Error('connection closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a line');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolve();
        };
      });
    }
  }

  /** Lines until a final OK/NO/BYE. */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line();
      if (FINAL.test(l)) return { lines, status: l };
      lines.push(l);
    }
  }

  /** One raw line (the challenge of AUTHENTICATE without an initial response). */
  next(): Promise<string> {
    return this.line();
  }

  write(data: string | Buffer): void {
    this.socket.write(data);
  }

  async send(command: string): Promise<Reply> {
    this.write(`${command}\r\n`);
    return this.reply();
  }

  /** STARTTLS, the handshake, and the capabilities the server re-issues after it. */
  async startTls(): Promise<Reply> {
    const r = await this.send('STARTTLS');
    if (!r.status.startsWith('OK')) throw new Error(`STARTTLS refused: ${r.status}`);
    const raw = this.socket;
    raw.removeAllListeners('data');
    raw.removeAllListeners('close');
    raw.removeAllListeners('error');
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ socket: raw, rejectUnauthorized: false, servername: 'localhost' }, () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    this.attach(this.socket);
    return this.reply();
  }

  async closeSocket(): Promise<void> {
    this.socket.destroy();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `{n+}` literal of a string, as the Thunderbird add-on sends scripts. */
export const literal = (s: string): string => `{${Buffer.byteLength(s, 'utf8')}+}\r\n${s}`;
