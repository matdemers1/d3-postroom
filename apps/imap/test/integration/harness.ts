// A real daemon on loopback for the integration tests: a throwaway database, a real blob store, a
// self-signed certificate (openssl), and accounts with app passwords.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword, revokeAppPassword } from '@postroom/credentials';
import { generateKek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { createImapListeners, type ImapListeners, type ImapServerOptions } from '../../src/server.js';

const exec = promisify(execFile);

export const PEPPER = 'test-pepper-imap-0123456789abcdef';
export const WEB_PASSWORD = 'correct horse battery staple';
const OPERATOR = { kind: 'system', label: 'test' } as const;

export interface Account {
  readonly id: string;
  readonly address: string;
  readonly appPassword: string;
  readonly appPasswordId: string;
}

export interface Harness {
  readonly t: TestDatabase;
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly listeners: ImapListeners;
  readonly port: number;
  readonly tlsPort: number;
  readonly tls: { key: Buffer; cert: Buffer };
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  /** Another listener set on the same database (PROXY tests). */
  listenersWith(overrides: Partial<ImapServerOptions>): Promise<{ listeners: ImapListeners; port: number; tlsPort: number }>;
  close(): Promise<void>;
}

export async function hasOpenssl(): Promise<boolean> {
  try {
    await exec('openssl', ['version']);
    return true;
  } catch (err) {
    console.warn(`openssl unavailable, IMAP TLS tests skip: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function startHarness(prefix: string): Promise<Harness> {
  const t = await createTestDatabase(process.env['DATABASE_URL'] ?? '', prefix);
  const db = t.db;
  await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await exec('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
  ]);
  const tls = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
  const blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek: generateKek() });
  const logs: Harness['logs'] = [];
  const base: ImapServerOptions = {
    db,
    blobs,
    pepper: PEPPER,
    tls,
    edgePeers: ['10.255.255.254'],
    throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 10_000 }),
    log: (event, fields = {}) => logs.push({ event, fields }),
  };
  const open: ImapListeners[] = [];
  const start = async (o: ImapServerOptions): Promise<{ listeners: ImapListeners; port: number; tlsPort: number }> => {
    const listeners = createImapListeners(o);
    open.push(listeners);
    const port = (await listeners.listen(listeners.imap, 0, '127.0.0.1')).port;
    const tlsPort = listeners.imaps === null ? 0 : (await listeners.listen(listeners.imaps, 0, '127.0.0.1')).port;
    return { listeners, port, tlsPort };
  };
  const main = await start(base);
  return {
    t,
    db,
    blobs,
    listeners: main.listeners,
    port: main.port,
    tlsPort: main.tlsPort,
    tls,
    logs,
    listenersWith: (overrides) => start({ ...base, ...overrides }),
    close: async () => {
      for (const l of open) await l.close();
      await t.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A person with a primary address, the default mailboxes, and an app password scoped to IMAP. */
export async function makeAccount(h: Harness, scopes: ('imap' | 'smtp')[] = ['imap']): Promise<Account> {
  const login = `u${randomInt(1e9).toString(36)}`;
  const d = await h.db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
  const account = await h.db.account.create({
    // Hashed exactly like a web password. Only the web login may use it.
    data: { displayName: login, passwordHash: await hashAppPassword(WEB_PASSWORD, PEPPER) },
  });
  await h.db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
  for (const m of DEFAULT_MAILBOXES) {
    await h.db.mailbox.create({ data: { accountId: account.id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
  }
  const created = await createAppPassword(h.db, OPERATOR, { accountId: account.id, label: 'Thunderbird', scopes }, { pepper: PEPPER });
  return { id: account.id, address: `${login}@d3cloud.io`, appPassword: created.password, appPasswordId: created.appPassword.id };
}

export async function extraAppPassword(h: Harness, account: Account, scopes: ('imap' | 'smtp')[]): Promise<{ password: string; id: string }> {
  const created = await createAppPassword(h.db, OPERATOR, { accountId: account.id, label: `extra-${scopes.join('-')}`, scopes }, { pepper: PEPPER });
  return { password: created.password, id: created.appPassword.id };
}

export async function revoke(h: Harness, id: string): Promise<void> {
  await revokeAppPassword(h.db, OPERATOR, { id });
}

/** Store a message the way the inbound pipeline does: the blob, then fileLocalMessage. */
export async function seedMessage(h: Harness, accountId: string, mailbox: string, message: Buffer, flags: string[] = [], internalDate = new Date('2026-09-24T12:00:00Z')): Promise<number> {
  const put = await h.blobs.put(message);
  const filed = await h.db.$transaction((tx) =>
    fileLocalMessage(tx, { accountId, mailbox, blobSha256: put.sha256, size: put.size, internalDate, flags }),
  );
  return filed.uid;
}
