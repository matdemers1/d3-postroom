// The daemons under attack, booted in-process exactly as their main.ts wires them — smtp-in with
// its real durable acceptance, submission with real DKIM keys and a real spool, IMAP with the real
// store — on ephemeral loopback ports, over a throwaway database and blob store per test file.
//
// Nothing here weakens a daemon for convenience. The only substitutions are the ones every
// integration harness in the repo makes: DNS answers are stubbed (no network), the auth throttle's
// tarpit does not actually sleep, and the certificate is self-signed.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpfDns } from '@postroom/auth-checks';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createImapListeners, type ImapListeners, type ImapServerOptions } from '../../../../../apps/imap/src/server.js';
import { MAX_MESSAGE_SIZE } from '../../../../../apps/smtp-in/src/config.js';
import { createAcceptMessage } from '../../../../../apps/smtp-in/src/data.js';
import { createSmtpInServer, type SmtpInOptions, type SmtpInServer } from '../../../../../apps/smtp-in/src/server.js';
import { ensureDkimKeys } from '../../../../../apps/submission/src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners, type SubmissionOptions } from '../../../../../apps/submission/src/server.js';

const exec = promisify(execFile);

export const DATABASE_URL = process.env['DATABASE_URL'];
export const PEPPER = 'adversarial-pepper-0123456789abcdef';
/** Every account's web (account) password. Protocols must never accept it (PST-REQ-027). */
export const ACCOUNT_PASSWORD = 'correct horse battery staple';
export const DOMAIN = 'd3cloud.io';
/** The edge's WireGuard peer in production; loopback is never it unless a test says so. */
export const EDGE_PEER = '10.77.0.1';

const OPERATOR = { kind: 'system', label: 'adversarial-suite' } as const;

export interface Account {
  readonly id: string;
  readonly login: string;
  readonly address: string;
  /** App password scoped to IMAP only. */
  readonly imapPassword: string;
  readonly imapPasswordId: string;
  /** App password scoped to SMTP submission only. */
  readonly smtpPassword: string;
  readonly smtpPasswordId: string;
}

export type LogEntry = { event: string; fields: Record<string, unknown> };

const noDns: SpfDns = {
  txt: () => Promise.resolve({ records: [], void: true }),
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

export class World {
  readonly logs: LogEntry[] = [];
  private readonly closers: (() => Promise<void>)[] = [];

  private constructor(
    readonly t: TestDatabase,
    readonly dir: string,
    readonly tls: { key: Buffer; cert: Buffer },
    readonly kek: Kek,
    readonly blobs: BlobStore,
    readonly operatorId: string,
  ) {}

  get db(): Db {
    return this.t.db;
  }

  static async create(prefix: string): Promise<World> {
    const t = await createTestDatabase(DATABASE_URL ?? '', prefix);
    const { operatorId, domainId } = await seed(t.db, { operatorName: 'Operator', domain: DOMAIN });
    // RFC 5321 §4.5.1: postmaster must exist; it belongs to the operator.
    await t.db.address.create({ data: { localPart: 'postmaster', domainId, kind: AddressKind.service, accountId: operatorId } });
    const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    const tls = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
    const kek = generateKek();
    const blobs = createBlobStore({ root: join(dir, 'blobs'), db: t.db, kek, logger: { warn: () => undefined } });
    return new World(t, dir, tls, kek, blobs, operatorId);
  }

  log = (event: string, fields: Record<string, unknown> = {}): void => {
    this.logs.push({ event, fields });
  };

  /** A person: primary address, default mailboxes, an IMAP-only and an SMTP-only app password. */
  async account(): Promise<Account> {
    const login = `u${randomInt(1e9).toString(36)}`;
    const domain = await this.db.domain.findUniqueOrThrow({ where: { name: DOMAIN } });
    const account = await this.db.account.create({
      data: { displayName: login, passwordHash: await hashAppPassword(ACCOUNT_PASSWORD, PEPPER) },
    });
    await this.db.address.create({ data: { localPart: login, domainId: domain.id, kind: AddressKind.primary, accountId: account.id } });
    for (const m of DEFAULT_MAILBOXES) {
      await this.db.mailbox.create({ data: { accountId: account.id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    const imap = await createAppPassword(this.db, OPERATOR, { accountId: account.id, label: 'imap', scopes: ['imap'] }, { pepper: PEPPER });
    const smtp = await createAppPassword(this.db, OPERATOR, { accountId: account.id, label: 'smtp', scopes: ['smtp'] }, { pepper: PEPPER });
    return {
      id: account.id,
      login,
      address: `${login}@${DOMAIN}`,
      imapPassword: imap.password,
      imapPasswordId: imap.appPassword.id,
      smtpPassword: smtp.password,
      smtpPasswordId: smtp.appPassword.id,
    };
  }

  /** A throttle that never sleeps (the tarpit's delay is not what these tests measure). */
  throttle(overrides: { sourceCeiling?: number } = {}): AuthThrottle {
    return createAuthThrottle({ db: this.db, sleep: () => Promise.resolve(), sourceCeiling: overrides.sourceCeiling ?? 100_000 });
  }

  /** smtp-in (port 25) with real durable acceptance into this world's blob store. */
  async smtpIn(overrides: Partial<SmtpInOptions> = {}): Promise<{ server: SmtpInServer; port: number }> {
    const accept = createAcceptMessage({
      db: this.db,
      blobs: this.blobs,
      dns: { txt: () => Promise.resolve([]) },
      trustedArcSealers: [],
      log: this.log,
    });
    const server = createSmtpInServer({
      db: this.db,
      hostname: 'mx.d3cloud.io',
      maxSize: MAX_MESSAGE_SIZE,
      edgePeers: [EDGE_PEER],
      proxyTimeoutMs: 1_000,
      maxConnectionsPerIp: 100,
      maxRecipientsPerMessage: 100,
      maxRecipientsPerSession: 500,
      maxErrors: 10,
      idleTimeoutMs: 30_000,
      spfDns: noDns,
      dkimDns: { txt: () => Promise.resolve([]) },
      reverseLookup: () => Promise.resolve(null),
      greylist: () => Promise.resolve('pass'),
      acceptMessage: accept,
      tls: this.tls,
      log: this.log,
      ...overrides,
    });
    const port = (await server.listen(0, '127.0.0.1')).port;
    this.closers.push(() => server.close());
    return { server, port };
  }

  /** Submission: 587 (STARTTLS) and 465 (implicit TLS), with DKIM keys for the domain. */
  async submission(overrides: Partial<SubmissionOptions> = {}): Promise<{ listeners: SubmissionListeners; port587: number; port465: number }> {
    await ensureDkimKeys(this.db, this.kek, DOMAIN);
    const listeners = createSubmissionListeners({
      db: this.db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 50,
      pepper: PEPPER,
      storage: () => ({ blobs: this.blobs, kek: this.kek }),
      tls: this.tls,
      throttle: this.throttle(),
      log: this.log,
      idleTimeoutMs: 30_000,
      ...overrides,
    });
    const listen = async (server: NonNullable<SubmissionListeners['submissions']> | SubmissionListeners['submission']): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    const port587 = await listen(listeners.submission);
    const port465 = listeners.submissions === null ? 0 : await listen(listeners.submissions);
    this.closers.push(() => listeners.close());
    return { listeners, port587, port465 };
  }

  /** IMAP: 143 (STARTTLS, LOGINDISABLED until TLS) and 993 (implicit TLS). */
  async imap(overrides: Partial<ImapServerOptions> = {}): Promise<{ listeners: ImapListeners; port: number; tlsPort: number }> {
    const listeners = createImapListeners({
      db: this.db,
      blobs: this.blobs,
      pepper: PEPPER,
      tls: this.tls,
      edgePeers: [EDGE_PEER],
      proxyTimeoutMs: 1_000,
      throttle: this.throttle(),
      log: this.log,
      ...overrides,
    });
    const port = (await listeners.listen(listeners.imap, 0, '127.0.0.1')).port;
    const tlsPort = listeners.imaps === null ? 0 : (await listeners.listen(listeners.imaps, 0, '127.0.0.1')).port;
    this.closers.push(() => listeners.close());
    return { listeners, port, tlsPort };
  }

  async close(): Promise<void> {
    for (const c of this.closers.reverse()) await c();
    await this.t.drop();
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Poll until `fn` is true (the server logs after the socket closes). */
export async function eventually(fn: () => boolean | Promise<boolean>, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
