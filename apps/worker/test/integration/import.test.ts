// PST-T-10.2, PST-REQ-152: "Interrupted import resumes without duplicates."
//
// The SOURCE is our own IMAP daemon (apps/imap's test harness: a real server on an ephemeral TLS
// port, with a self-signed certificate) holding one account with three folders — INBOX, Sent
// (\Sent) and a nested non-ASCII folder — of N messages each, with assorted flags and internal
// dates, one message big enough to be streamed rather than buffered, and one without a
// Message-ID. The DESTINATION is a second database with its own blob store, as another Postroom.
//
//   · a crash mid-folder (a fault after K messages; the job left 'running' as a dead worker
//     leaves it) and a second worker taking the job over once the lease expires → exactly N
//     messages per folder, flags, internal dates and bytes (sha256) identical to the source;
//   · UIDVALIDITY changes between the crash and the resume → the folder restarts and the
//     messages already filed are counted as duplicates, never filed twice;
//   · a wrong password → a clear failure, no retry; certificate not trusted, wrong pin, and a
//     CA-trusted certificate for another name → refused; a cancel mid-run stops it;
//   · afterwards the password is nowhere: not in a setting, the job row, the audit log or a log line.
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { DEFAULT_MAILBOXES, randomUidValidity, seed, SpecialUse, type Db, type Job } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { claim, complete, enqueue } from '@postroom/queue';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOpenssl, makeAccount, seedMessage, startHarness, type Account, type Harness } from '../../../imap/test/integration/harness.js';
import {
  IMPORT_QUEUE,
  importSecretKey,
  readImportState,
  runImportJob,
  sealImportSecret,
  writeImportState,
  type ImportDeps,
  type ImportState,
} from '../../src/import/index.js';

const baseUrl = process.env['DATABASE_URL'];
const N = 6;
const NESTED = 'Projects/Ünïcode';
const LEASE_MS = 60_000;

interface Seeded {
  folder: string;
  messageId: string | null;
  flags: string[];
  internalDate: Date;
  sha256: string;
}

function message(folder: string, i: number, opts: { big?: boolean; noMessageId?: boolean } = {}): Buffer {
  const lines = [
    `From: sender${String(i)}@example.org`,
    'To: someone@example.net',
    `Subject: ${folder} message ${String(i)}`,
    `Date: Tue, 22 Sep 2026 10:0${String(i % 10)}:00 +0000`,
    ...(opts.noMessageId === true ? [] : [`Message-ID: <m${String(i)}.${folder.replace(/[^a-z]/gi, '')}@example.org>`]),
    '',
    `Body of ${folder} ${String(i)}.`,
  ];
  if (opts.big === true) {
    // ~300 KB of body: far over the reader's 16 KiB streaming threshold.
    for (let n = 0; n < 4000; n++) lines.push(`line ${String(n)} ${'x'.repeat(64)}`);
  }
  lines.push('');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const FLAG_SETS = [[], ['\\Seen'], ['\\Seen', '\\Flagged'], ['\\Answered', '\\Seen'], ['$Forwarded'], ['\\Draft']];

describe.skipIf(baseUrl === undefined)('IMAP import (PST-T-10.2, PST-REQ-152)', () => {
  let h: Harness;
  let source: Account;
  let fingerprint = '';
  let dst: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let kek: Kek;
  const seeded: Seeded[] = [];
  const logs: string[] = [];
  let openssl = true;

  const deps = (extra: Partial<ImportDeps> = {}): ImportDeps => ({
    db,
    blobs,
    kek: () => kek,
    log: (event, fields = {}) => logs.push(JSON.stringify({ event, ...fields })),
    leaseMs: LEASE_MS,
    batchSize: 4,
    ...extra,
  });

  /** A destination account with the default mailboxes — its \Sent one renamed, to prove mapping by special use. */
  const destination = async (): Promise<string> => {
    const account = await db.account.create({ data: { displayName: `dst${String(randomInt(1e9))}` } });
    for (const m of DEFAULT_MAILBOXES) {
      await db.mailbox.create({
        data: { accountId: account.id, name: m.specialUse === SpecialUse.sent ? 'Sent Items' : m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) },
      });
    }
    return account.id;
  };

  /** What POST /api/import writes (apps/api/src/import/store.ts): job, state, sealed secret, one transaction. */
  const startImport = async (accountId: string, o: { password?: string; pin?: string | null; folders?: string[] | null; port?: number } = {}): Promise<string> => {
    const now = new Date().toISOString();
    return db.$transaction(async (tx) => {
      const job = await enqueue(tx, IMPORT_QUEUE, { accountId }, { maxAttempts: 5 });
      if (job === null) throw new Error('not enqueued');
      const state: ImportState = {
        accountId,
        host: '127.0.0.1',
        port: o.port ?? h.tlsPort,
        username: source.address,
        trustFingerprint: o.pin === undefined ? fingerprint : o.pin,
        folders: o.folders ?? null,
        status: 'pending',
        error: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
        progress: [],
      };
      await writeImportState(tx, job.id, state);
      await tx.setting.create({ data: { key: importSecretKey(job.id), value: { sealed: sealImportSecret(kek, job.id, o.password ?? source.appPassword) } } });
      return job.id;
    });
  };

  /** One worker's attempt: claim (optionally as if the clock were later, so a dead worker's lease is stale), run, complete. */
  const attempt = async (workerId: string, d: ImportDeps, at?: Date): Promise<{ job: Job; error: unknown }> => {
    const job = await claim(db, IMPORT_QUEUE, { workerId, leaseMs: LEASE_MS, ...(at === undefined ? {} : { now: at }) });
    if (job === null) throw new Error('no import job to claim');
    try {
      await runImportJob(d, job);
      await complete(db, job);
      return { job, error: null };
    } catch (error) {
      // A crash: the job stays 'running' with this worker's lease, exactly as a killed process leaves it.
      return { job, error };
    }
  };

  const mailboxMessages = async (accountId: string, name: string) => {
    const mb = await db.mailbox.findUniqueOrThrow({ where: { accountId_name: { accountId, name } } });
    return db.message.findMany({ where: { mailboxId: mb.id }, orderBy: { uid: 'asc' } });
  };

  /** Exactly the source's messages, once each, with their flags, internal dates and bytes. */
  const expectExactCopy = async (accountId: string): Promise<void> => {
    for (const [folder, target] of [['INBOX', 'INBOX'], ['Sent', 'Sent Items'], [NESTED, NESTED]] as const) {
      const rows = await mailboxMessages(accountId, target);
      const expected = seeded.filter((s) => s.folder === folder);
      expect(rows).toHaveLength(N);
      expect(new Set(rows.map((r) => r.blobSha256)).size).toBe(N);
      for (const s of expected) {
        const row = rows.find((r) => r.blobSha256 === s.sha256);
        expect(row, `${folder}: ${s.messageId ?? '(no Message-ID)'}`).toBeDefined();
        if (row === undefined) continue;
        expect([...row.flags].sort()).toEqual([...s.flags].sort());
        expect(row.internalDate.toISOString()).toBe(s.internalDate.toISOString());
        expect(row.messageIdHeader).toBe(s.messageId);
        const bytes = await blobs.getBuffer(row.blobSha256);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(s.sha256);
      }
    }
  };

  const expectNoSecretAnywhere = async (password: string): Promise<void> => {
    const settings = await db.setting.findMany({ where: { key: { startsWith: 'import-' } } });
    expect(settings.filter((s) => s.key.startsWith('import-secret.'))).toEqual([]);
    const haystacks = [
      JSON.stringify(settings),
      JSON.stringify(await db.job.findMany({ where: { queue: IMPORT_QUEUE } })),
      JSON.stringify(await db.auditEvent.findMany()),
      logs.join('\n'),
    ];
    for (const hay of haystacks) expect(hay.includes(password)).toBe(false);
  };

  beforeAll(async () => {
    openssl = await hasOpenssl();
    if (!openssl) return;
    h = await startHarness('pst_t102_import_src');
    source = await makeAccount(h);
    fingerprint = new X509Certificate(h.tls.cert).fingerprint256;
    for (const folder of ['INBOX', 'Sent', NESTED]) {
      for (let i = 1; i <= N; i++) {
        const raw = message(folder, i, { big: i === 2, noMessageId: i === 5 });
        const flags = FLAG_SETS[(i - 1) % FLAG_SETS.length] ?? [];
        const internalDate = new Date(Date.UTC(2025, i, 3 + i, 8, i, 7));
        await seedMessage(h, source.id, folder, raw, flags, internalDate);
        seeded.push({
          folder,
          messageId: i === 5 ? null : `m${String(i)}.${folder.replace(/[^a-z]/gi, '')}@example.org`,
          flags,
          internalDate,
          sha256: createHash('sha256').update(raw).digest('hex'),
        });
      }
    }
    dst = await createTestDatabase(baseUrl ?? '', 'pst_t102_import_dst');
    db = dst.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-import-blobs-'));
    kek = generateKek();
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
  }, 60_000);

  afterAll(async () => {
    if (!openssl) return;
    await h.close();
    await dst.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('a crash mid-folder, then another worker after the lease expires: exactly N per folder, flags, dates and bytes identical', async () => {
    if (!openssl) return;
    const accountId = await destination();
    const id = await startImport(accountId);

    // Crash after the 3rd message filed in Sent: Sent part-way through.
    let sentFiled = 0;
    const crashing = deps({
      faults: {
        afterMessage: ({ folder }) => {
          if (folder === 'Sent' && ++sentFiled === 3) throw new Error('simulated crash');
        },
      },
    });
    const first = await attempt('worker-1', crashing);
    expect(String(first.error)).toContain('simulated crash');
    const mid = await readImportState(db, id);
    expect(mid?.status).toBe('running');
    const midSent = mid?.progress.find((p) => p.source === 'Sent');
    expect(midSent?.imported).toBe(3);
    expect(midSent?.done).toBe(false);
    expect((await mailboxMessages(accountId, 'Sent Items')).length).toBe(3);

    // The dead worker's lease runs out; a second worker claims the job and resumes it.
    const second = await attempt('worker-2', deps(), new Date(Date.now() + LEASE_MS + 1_000));
    expect(second.error).toBeNull();
    expect(second.job.id).toBe(id);

    const done = await readImportState(db, id);
    expect(done?.status).toBe('done');
    expect(done?.error).toBeNull();
    for (const f of ['INBOX', 'Sent']) {
      const p = done?.progress.find((x) => x.source === f);
      expect(p).toMatchObject({ imported: N, duplicates: 0, total: N, done: true });
    }
    const nested = done?.progress.find((x) => x.display === NESTED);
    expect(nested).toMatchObject({ target: NESTED, imported: N, total: N, done: true });
    expect(done?.progress.find((x) => x.source === 'Sent')?.target).toBe('Sent Items');
    await expectExactCopy(accountId);

    const audit = await db.auditEvent.findMany({ where: { entityId: id } });
    expect(audit.map((a) => a.action)).toEqual(['import.done']);
    await expectNoSecretAnywhere(source.appPassword);

    // Running the finished job again changes nothing.
    await db.job.update({ where: { id }, data: { status: 'pending', runAt: new Date() } });
    const again = await attempt('worker-3', deps());
    expect(again.error).toBeNull();
    await expectExactCopy(accountId);
  });

  it('UIDVALIDITY changes before the resume: the folder restarts and what was filed counts as duplicates, never twice', async () => {
    if (!openssl) return;
    const accountId = await destination();
    const id = await startImport(accountId, { folders: ['INBOX'] });
    let filed = 0;
    const first = await attempt(
      'worker-a',
      deps({
        faults: {
          afterMessage: () => {
            if (++filed === 4) throw new Error('simulated crash');
          },
        },
      }),
    );
    expect(String(first.error)).toContain('simulated crash');
    expect((await mailboxMessages(accountId, 'INBOX')).length).toBe(4);
    const before = (await readImportState(db, id))?.progress.find((p) => p.source === 'INBOX');
    expect(before?.lastUid).toBe(4);

    // The source rebuilt its mailbox: every UID it knew is void now.
    const srcInbox = await h.db.mailbox.findUniqueOrThrow({ where: { accountId_name: { accountId: source.id, name: 'INBOX' } } });
    await h.db.mailbox.update({ where: { id: srcInbox.id }, data: { uidvalidity: srcInbox.uidvalidity + 1 } });

    const second = await attempt('worker-b', deps(), new Date(Date.now() + LEASE_MS + 1_000));
    expect(second.error).toBeNull();
    const state = await readImportState(db, id);
    expect(state?.status).toBe('done');
    const inbox = state?.progress.find((p) => p.source === 'INBOX');
    expect(inbox).toMatchObject({ uidvalidity: srcInbox.uidvalidity + 1, imported: N - 4, duplicates: 4, done: true });
    expect(state?.progress).toHaveLength(1);
    const rows = await mailboxMessages(accountId, 'INBOX');
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((r) => r.blobSha256)).size).toBe(N);
    expect(logs.some((l) => l.includes('import-uidvalidity-changed'))).toBe(true);

    // A whole second import of the same folder files nothing new.
    const id2 = await startImport(accountId, { folders: ['INBOX'] });
    expect((await attempt('worker-c', deps())).error).toBeNull();
    expect((await readImportState(db, id2))?.progress[0]).toMatchObject({ imported: 0, duplicates: N });
    expect(await mailboxMessages(accountId, 'INBOX')).toHaveLength(N);
    await h.db.mailbox.update({ where: { id: srcInbox.id }, data: { uidvalidity: srcInbox.uidvalidity } });
  });

  it('a wrong password fails clearly, once, and leaves no secret behind', async () => {
    if (!openssl) return;
    const accountId = await destination();
    const wrong = 'not-the-password-7f3a9c';
    const id = await startImport(accountId, { password: wrong });
    const run = await attempt('worker-p', deps());
    expect(run.error).toBeNull();
    const state = await readImportState(db, id);
    expect(state?.status).toBe('failed');
    expect(state?.error).toMatch(/refused the username or password/);
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('done');
    await expectNoSecretAnywhere(wrong);
  });

  it('refuses an untrusted certificate, a wrong pin, and a CA-trusted certificate for another name', async () => {
    if (!openssl) return;
    const accountId = await destination();

    const unpinned = await startImport(accountId, { pin: null });
    expect((await attempt('worker-t1', deps())).error).toBeNull();
    const s1 = await readImportState(db, unpinned);
    expect(s1?.status).toBe('failed');
    expect(s1?.error).toMatch(/not trusted/);

    const wrongPin = await startImport(accountId, { pin: 'AB:'.repeat(31) + 'AB' });
    expect((await attempt('worker-t2', deps())).error).toBeNull();
    const s2 = await readImportState(db, wrongPin);
    expect(s2?.status).toBe('failed');
    expect(s2?.error).toMatch(/does not match the pinned fingerprint/);

    // Trusting its CA is not enough: the certificate says CN=localhost and we dialled 127.0.0.1.
    const byCa = await startImport(accountId, { pin: null });
    expect((await attempt('worker-t3', deps({ tlsCa: h.tls.cert }))).error).toBeNull();
    const s3 = await readImportState(db, byCa);
    expect(s3?.status).toBe('failed');
    expect(s3?.error).toMatch(/not for that name/);

    expect(await db.message.count({ where: { mailbox: { accountId } } })).toBe(0);
    await expectNoSecretAnywhere(source.appPassword);
  });

  it('a cancel mid-run stops it: what was filed stays, the rest is not fetched, the secret is wiped', async () => {
    if (!openssl) return;
    const accountId = await destination();
    const id = await startImport(accountId, { folders: ['INBOX'] });
    let n = 0;
    const run = await attempt(
      'worker-x',
      deps({
        faults: {
          afterMessage: async () => {
            if (++n === 2) await db.setting.create({ data: { key: `import-cancel.${id}`, value: { at: new Date().toISOString() } } });
          },
        },
      }),
    );
    expect(run.error).toBeNull();
    const state = await readImportState(db, id);
    expect(state?.status).toBe('cancelled');
    expect((await mailboxMessages(accountId, 'INBOX')).length).toBe(2);
    expect(await db.setting.count({ where: { key: { in: [importSecretKey(id), `import-cancel.${id}`] } } })).toBe(0);
    expect((await db.auditEvent.findMany({ where: { entityId: id } })).map((a) => a.action)).toEqual(['import.cancelled']);
  });
});
