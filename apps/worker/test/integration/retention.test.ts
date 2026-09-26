// PST-T-7.7: retention against a real database and a real blob store.
//   PST-REQ-129  Junk at 30 d moves to Trash (with its clock), then expires; nothing is ever deleted
//                outside Trash and Rejects.
//   PST-REQ-130  After expiry, the blob row (the wrapped DEK) is gone and the file unreadable/gone;
//                a blob shared by two copies stays until the second goes; a crash between the DEK
//                and the file leaves an orphan file that gc removes.
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BlobNotFoundError, createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { InboundState, randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { createRetentionSweeper, DAY_MS, MAILBOX_CHANNEL, type RetentionSweeper } from '../../src/retention/index.js';

const baseUrl = process.env['DATABASE_URL'];

// A LISTEN needs its own connection outside Prisma's pool. The worker does not depend on `pg`
// itself, so borrow @postroom/db's copy (the one its adapter uses).
interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', fn: (n: { channel: string; payload?: string }) => void): unknown;
  end(): Promise<unknown>;
}
const requireFromDb = createRequire(import.meta.resolve('@postroom/db/testing'));
const { Client } = requireFromDb('pg') as { Client: new (opts: { connectionString: string }) => ListenClient };

function raw(subject: string): Buffer {
  return Buffer.from(
    `From: <spam@example.org>\r\nTo: you@d3cloud.io\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.org>\r\n\r\nbody ${subject}\r\n`,
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('retention sweep (PST-T-7.7)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let accountId = '';
  const box: Record<'INBOX' | 'Junk' | 'Trash' | 'Rejects' | 'Archive', string> = { INBOX: '', Junk: '', Trash: '', Rejects: '', Archive: '' };
  let listener: ListenClient;
  const notified: string[] = [];
  // The sweep's clock: tests move it forward by days.
  let offsetMs = 0;
  const now = (): Date => new Date(Date.now() + offsetMs);
  let sweep: RetentionSweeper;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t77');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    accountId = (await db.account.create({ data: { displayName: 'You' } })).id;
    const uses = { INBOX: SpecialUse.inbox, Junk: SpecialUse.junk, Trash: SpecialUse.trash, Rejects: SpecialUse.rejects, Archive: SpecialUse.archive } as const;
    for (const name of Object.keys(box) as (keyof typeof box)[]) {
      box[name] = (await db.mailbox.create({ data: { accountId, name, specialUse: uses[name], uidvalidity: randomUidValidity(randomInt) } })).id;
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t77-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    sweep = createRetentionSweeper({ db, blobs, now });
    listener = new Client({ connectionString: t.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === MAILBOX_CHANNEL && n.payload !== undefined) notified.push(n.payload);
    });
    await listener.query(`LISTEN ${MAILBOX_CHANNEL}`);
  }, 120_000);

  afterAll(async () => {
    await listener.end();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  // Each test starts from empty mailboxes, so a sweep's counts are that test's alone.
  beforeEach(async () => {
    offsetMs = 0;
    notified.length = 0;
    await db.$executeRaw`DELETE FROM message`;
    await db.$executeRaw`DELETE FROM inbound_message`;
    await db.$executeRaw`DELETE FROM blob`;
    await db.$executeRaw`DELETE FROM retention_policy`;
  });

  /**
   * Deliver a message the way smtp-in + the worker's file stage leave it: the spool row holds one
   * reference (filed, with a copy recorded in its pipeline marker), each Message copy holds another.
   */
  async function deliver(mailboxes: (keyof typeof box)[], subject: string, receivedAt: Date): Promise<{ sha: string; inboundId: string; messageIds: string[] }> {
    const put = await blobs.put(raw(subject));
    const inboundId = randomUUID();
    const messageIds: string[] = [];
    await db.$transaction(async (tx) => {
      await tx.inboundMessage.create({
        data: {
          id: inboundId,
          receivedAt,
          envelopeFrom: 'spam@example.org',
          recipients: [],
          blobSha256: put.sha256,
          size: put.size,
          state: InboundState.filed,
          filedAt: receivedAt,
          verdicts: { pipeline: { stages: { file: { at: receivedAt.toISOString(), result: { bucket: 'junk', copies: mailboxes.map((m) => ({ mailbox: m })), created: mailboxes.length } } } } },
        },
      });
      for (const mailbox of mailboxes) {
        const filed = await fileLocalMessage(tx, { accountId, mailbox, blobSha256: put.sha256, size: put.size, internalDate: receivedAt });
        await tx.message.update({ where: { id: filed.id }, data: { receivedAt, inboundMessageId: mailboxes.indexOf(mailbox) === 0 ? inboundId : null } });
        messageIds.push(filed.id);
      }
      await tx.blob.update({ where: { sha256: put.sha256 }, data: { refcount: { increment: mailboxes.length } } });
    });
    return { sha: put.sha256, inboundId, messageIds };
  }

  const nth = (ids: readonly string[], i: number): string => {
    const id = ids[i];
    if (id === undefined) throw new Error(`no message ${i}`);
    return id;
  };
  const daysAgo = (d: number): Date => new Date(Date.now() - d * DAY_MS);
  const fileOf = (sha: string): string => join(blobRoot, sha.slice(0, 2), sha.slice(2, 4), sha);
  const mailbox = (id: string) => db.mailbox.findUniqueOrThrow({ where: { id } });

  it('moves Junk at 31 days to Trash with its clock, and leaves Junk at 29 days alone', async () => {
    const old = await deliver(['Junk'], 'old junk', daysAgo(31));
    const young = await deliver(['Junk'], 'young junk', daysAgo(29));
    const junkBefore = await mailbox(box.Junk);
    const trashBefore = await mailbox(box.Trash);

    const r = await sweep({ skipGc: true });
    expect(r.moved).toBe(1);
    expect(r.expunged).toBe(0);

    const moved = await db.message.findUniqueOrThrow({ where: { id: nth(old.messageIds, 0) } });
    expect(moved.mailboxId).toBe(box.Trash);
    expect(moved.trashedAt).not.toBeNull();
    expect(Math.abs((moved.trashedAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(moved.uid).toBe(trashBefore.uidnext);
    const junkAfter = await mailbox(box.Junk);
    const trashAfter = await mailbox(box.Trash);
    expect(trashAfter.uidnext).toBe(trashBefore.uidnext + 1);
    expect(moved.modseq).toBe(trashAfter.highestModseq);
    expect(junkAfter.highestModseq).toBeGreaterThan(junkBefore.highestModseq);
    // QRESYNC: the Junk UID vanished at the new modseq.
    const vanished = await db.expungedMessage.findMany({ where: { mailboxId: box.Junk } });
    expect(vanished.map((v) => v.modseq)).toContain(junkAfter.highestModseq);
    // The blob is untouched: its reference moved with the row.
    expect((await blobs.stat(old.sha))?.refcount).toBe(2);
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(young.messageIds, 0) } })).toMatchObject({ mailboxId: box.Junk, trashedAt: null });
    // Audited as SYSTEM with its count.
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'retention.move-to-trash', entityId: box.Junk }, orderBy: { at: 'desc' } });
    expect(audit.actorKind).toBe('system');
    expect(audit.after).toMatchObject({ count: 1, trashMailboxId: box.Trash });
    await expect.poll(() => notified.includes(box.Junk) && notified.includes(box.Trash)).toBe(true);

    // Idempotent: a second run moves nothing more.
    expect((await sweep({ skipGc: true })).moved).toBe(0);
  });

  it('expires a Trash message 31 days after it entered Trash: DEK row gone, file gone, unreadable', async () => {
    const m = await deliver(['Junk'], 'to be shredded', daysAgo(31));
    await sweep({ skipGc: true });
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(m.messageIds, 0) } })).toMatchObject({ mailboxId: box.Trash });
    expect(existsSync(fileOf(m.sha))).toBe(true);

    // 29 days in Trash: still there.
    offsetMs = 29 * DAY_MS;
    expect((await sweep({ skipGc: true })).expunged).toBe(0);
    expect(await db.message.findUnique({ where: { id: nth(m.messageIds, 0) } })).not.toBeNull();

    const trashBefore = await mailbox(box.Trash);
    notified.length = 0;
    offsetMs = 31 * DAY_MS;
    const r = await sweep({ skipGc: true });
    expect(r.expunged).toBe(1);
    expect(r.spoolReleased).toBe(1);
    expect(r.shredded).toBe(1);

    expect(await db.message.findUnique({ where: { id: nth(m.messageIds, 0) } })).toBeNull();
    // The wrapped DEK went with the row, in the expunge's transaction.
    expect(await db.blob.findUnique({ where: { sha256: m.sha } })).toBeNull();
    expect(existsSync(fileOf(m.sha))).toBe(false);
    await expect(blobs.getBuffer(m.sha)).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: m.inboundId } })).toMatchObject({ blobReleasedAt: expect.any(Date) as Date });

    // IMAP sees it: modseq bump, a VANISHED record, and a notify on Trash.
    const trashAfter = await mailbox(box.Trash);
    expect(trashAfter.highestModseq).toBeGreaterThan(trashBefore.highestModseq);
    const gone = await db.expungedMessage.findMany({ where: { mailboxId: box.Trash, modseq: trashAfter.highestModseq } });
    expect(gone).toHaveLength(1);
    await expect.poll(() => notified.includes(box.Trash)).toBe(true);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'retention.expunge', entityId: box.Trash }, orderBy: { at: 'desc' } });
    expect(audit.actorKind).toBe('system');
    expect(audit.before).toMatchObject({ count: 1 });
    expect(audit.after).toMatchObject({ blobsShredded: 1, spoolReferencesReleased: 1 });
  });

  it('keeps a blob shared by two copies until the second copy goes', async () => {
    const m = await deliver(['Junk', 'Archive'], 'shared', daysAgo(31));
    expect((await blobs.stat(m.sha))?.refcount).toBe(3);
    await sweep({ skipGc: true });
    offsetMs = 31 * DAY_MS;
    const r = await sweep({ skipGc: true });
    expect(r.expunged).toBe(1);
    expect(r.shredded).toBe(0);
    // The Archive copy (no policy) is untouched and still readable.
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(m.messageIds, 1) } })).toMatchObject({ mailboxId: box.Archive });
    expect((await blobs.stat(m.sha))?.refcount).toBe(2);
    expect((await blobs.getBuffer(m.sha)).toString('utf8')).toContain('body shared');

    // The user expunges the Archive copy themselves (the IMAP path: one reference released).
    await db.$transaction(async (tx) => {
      await tx.message.delete({ where: { id: nth(m.messageIds, 1) } });
      await blobs.release(m.sha, tx);
    });
    expect((await blobs.stat(m.sha))?.refcount).toBe(1);
    // Within the grace period (counted from receipt) the spool row keeps its reference...
    offsetMs = 0;
    expect((await sweep({ skipGc: true, spoolGraceMs: 40 * DAY_MS })).spoolReleased).toBe(0);
    expect(await blobs.stat(m.sha)).not.toBeNull();
    // ...after it, the last reference goes and the blob is shredded.
    const later = await sweep({ skipGc: true });
    expect(later.spoolReleased).toBe(1);
    expect(later.shredded).toBe(1);
    expect(await db.blob.findUnique({ where: { sha256: m.sha } })).toBeNull();
    expect(existsSync(fileOf(m.sha))).toBe(false);
  });

  it('a crash between DEK destruction and file deletion leaves an unreadable file that gc removes', async () => {
    const m = await deliver(['Junk'], 'crash between', daysAgo(31));
    await sweep({ skipGc: true });
    // The process "dies" after the commit, before the unlink: reap never runs.
    const crashing = createRetentionSweeper({
      db,
      now,
      blobs: {
        release: (sha, tx) => blobs.release(sha, tx),
        reap: () => Promise.reject(new Error('killed before unlink')),
        gc: (o) => blobs.gc(o),
      },
    });
    offsetMs = 31 * DAY_MS;
    const r = await crashing({ skipGc: true });
    expect(r.shredded).toBe(1);
    expect(await db.blob.findUnique({ where: { sha256: m.sha } })).toBeNull();
    expect(existsSync(fileOf(m.sha))).toBe(true);
    // Ciphertext with no DEK: unreadable.
    await expect(blobs.getBuffer(m.sha)).rejects.toBeInstanceOf(BlobNotFoundError);
    // The orphan GC pass (part of every sweep) removes it.
    const next = await sweep({ gcOlderThanMs: 0 });
    expect(next.gc?.orphans).toBeGreaterThanOrEqual(1);
    expect(existsSync(fileOf(m.sha))).toBe(false);
  });

  it('expires Rejects by received date (14 days) and never deletes anywhere but Trash and Rejects', async () => {
    const rejected = await deliver(['Rejects'], 'rejected', daysAgo(15));
    await db.inboundMessage.update({ where: { id: rejected.inboundId }, data: { state: InboundState.rejected } });
    const inbox = await deliver(['INBOX'], 'ancient inbox', daysAgo(3650));
    const archive = await deliver(['Archive'], 'ancient archive', daysAgo(3650));
    const junk = await deliver(['Junk'], 'fresh junk', daysAgo(1));

    offsetMs = 400 * DAY_MS;
    const r = await sweep({ skipGc: true });
    expect(r.expunged).toBe(1);
    expect(await db.message.findUnique({ where: { id: nth(rejected.messageIds, 0) } })).toBeNull();
    expect(await db.blob.findUnique({ where: { sha256: rejected.sha } })).toBeNull();
    // Mailboxes without a policy keep everything, however old.
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(inbox.messageIds, 0) } })).toMatchObject({ mailboxId: box.INBOX });
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(archive.messageIds, 0) } })).toMatchObject({ mailboxId: box.Archive });
    // Junk went to Trash — not deleted — even at 400 days: Trash's clock starts now.
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(junk.messageIds, 0) } })).toMatchObject({ mailboxId: box.Trash });
    expect(r.moved).toBeGreaterThanOrEqual(1);
    // Every expunge audit row names Trash or Rejects, nothing else.
    const expunges = await db.auditEvent.findMany({ where: { action: 'retention.expunge' } });
    expect(expunges.length).toBeGreaterThan(0);
    for (const e of expunges) expect([box.Trash, box.Rejects]).toContain(e.entityId);
  });

  it('a policy row overrides the default: INBOX at 7 days moves to Trash, Junk with days null is kept', async () => {
    await db.retentionPolicy.create({ data: { accountId, mailboxId: box.INBOX, days: 7 } });
    await db.retentionPolicy.create({ data: { accountId, mailboxId: box.Junk, days: null } });
    const inbox = await deliver(['INBOX'], 'week old', daysAgo(8));
    const junk = await deliver(['Junk'], 'kept junk', daysAgo(90));
    await sweep({ skipGc: true });
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(inbox.messageIds, 0) } })).toMatchObject({ mailboxId: box.Trash });
    expect(await db.message.findUniqueOrThrow({ where: { id: nth(junk.messageIds, 0) } })).toMatchObject({ mailboxId: box.Junk });
  });

  it('stamps the Trash clock on any move into Trash (the trigger) and clears it on the way out', async () => {
    const m = await deliver(['INBOX'], 'moved by a client', daysAgo(1));
    const id = nth(m.messageIds, 0);
    // An IMAP MOVE re-homes the row with a plain UPDATE of mailbox_id.
    await db.$executeRaw`UPDATE message SET mailbox_id = ${box.Trash}::uuid, uid = 900000 WHERE id = ${id}::uuid`;
    const inTrash = await db.message.findUniqueOrThrow({ where: { id } });
    expect(inTrash.trashedAt).not.toBeNull();
    await db.$executeRaw`UPDATE message SET mailbox_id = ${box.INBOX}::uuid, uid = 900001 WHERE id = ${id}::uuid`;
    expect((await db.message.findUniqueOrThrow({ where: { id } })).trashedAt).toBeNull();
    // An insert straight into Trash (COPY, APPEND, the webmail's move) is stamped too.
    const copy = await db.$transaction(async (tx) => {
      await tx.blob.update({ where: { sha256: m.sha }, data: { refcount: { increment: 1 } } });
      return fileLocalMessage(tx, { accountId, mailbox: 'Trash', blobSha256: m.sha, size: 10, internalDate: new Date() });
    });
    expect((await db.message.findUniqueOrThrow({ where: { id: copy.id } })).trashedAt).not.toBeNull();
  });
});
