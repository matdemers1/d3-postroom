// PST-T-20.3 (PST-ADR-016): the account purge on a test clock, against a real database and a real
// blob store. Before the grace period ends nothing goes; after it, every message, held send,
// composer upload and finished outbound message releases its blob reference — the last one deleting
// the wrapped DEK (crypto-shred) and then the file — and the account row goes with everything it
// owns. Another account's copy of the same bytes survives. A restored account is passed by, and one
// with mail still in the outbound queue waits for a later run.
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { DEFAULT_MAILBOXES, InboundState, randomUidValidity, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { createAccountPurger } from '../../src/account-deletion/purge.js';

const baseUrl = process.env['DATABASE_URL'];
const DAY_MS = 24 * 60 * 60 * 1000;

const raw = (subject: string): Buffer =>
  Buffer.from(`From: <a@example.org>\r\nTo: you@d3cloud.io\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.org>\r\n\r\nbody ${subject}\r\n`, 'utf8');

describe.skipIf(baseUrl === undefined)('account purge (PST-T-20.3)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let offsetMs = 0;
  const now = (): Date => new Date(Date.now() + offsetMs);
  const fileOf = (sha: string): string => join(blobRoot, sha.slice(0, 2), sha.slice(2, 4), sha);

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t203');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t203-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  async function account(name: string): Promise<string> {
    const id = (await db.account.create({ data: { displayName: name } })).id;
    for (const mb of DEFAULT_MAILBOXES) {
      await db.mailbox.create({ data: { accountId: id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    return id;
  }

  /** Delivered as smtp-in + the file stage leave it: the spool row holds one reference, each copy another. */
  async function deliver(to: { accountId: string; mailbox: string }[], bytes: Buffer): Promise<string> {
    const put = await blobs.put(bytes);
    await db.$transaction(async (tx) => {
      const inbound = await tx.inboundMessage.create({
        data: { envelopeFrom: 'a@example.org', recipients: [], blobSha256: put.sha256, size: put.size, state: InboundState.filed, filedAt: now() },
      });
      for (const [i, target] of to.entries()) {
        const filed = await fileLocalMessage(tx, { accountId: target.accountId, mailbox: target.mailbox, blobSha256: put.sha256, size: put.size, internalDate: now() });
        if (i === 0) await tx.message.update({ where: { id: filed.id }, data: { inboundMessageId: inbound.id } });
      }
      await tx.blob.update({ where: { sha256: put.sha256 }, data: { refcount: { increment: to.length } } });
    });
    return put.sha256;
  }

  async function outbound(accountId: string, state: 'delivered' | 'deferred'): Promise<string> {
    const put = await blobs.put(raw(`sent ${state}`));
    await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: 'me@d3cloud.io',
        headerFrom: 'me@d3cloud.io',
        blobSha256: put.sha256,
        size: put.size,
        submittedVia: 'webmail',
        recipients: { create: { address: 'x@example.org', domain: 'example.org', state } },
      },
    });
    return put.sha256;
  }

  const scheduleDeletion = (id: string, at: Date) => db.account.update({ where: { id }, data: { disabledAt: at, deletionRequestedAt: at, deleteAfter: new Date(at.getTime() + 7 * DAY_MS) } });

  it('crypto-shreds the mailbox after the grace period, keeps shared bytes, and passes by restored and still-sending accounts', async () => {
    const gone = await account('Leaving');
    const stays = await account('Staying');
    const restored = await account('Restored');
    const sending = await account('Still sending');

    const mine = await deliver([{ accountId: gone, mailbox: 'INBOX' }, { accountId: gone, mailbox: 'Archive' }], raw('only mine'));
    const shared = await deliver([{ accountId: gone, mailbox: 'INBOX' }, { accountId: stays, mailbox: 'INBOX' }], raw('ours'));
    const upload = await blobs.put(Buffer.from('an attachment'));
    await db.composeUpload.create({ data: { accountId: gone, blobSha256: upload.sha256, filename: 'a.txt', contentType: 'text/plain', size: upload.size } });
    const held = await blobs.put(raw('held send'));
    await db.pendingSend.create({
      data: { accountId: gone, kind: 'undo', releaseAt: new Date(now().getTime() + 60_000), envelopeFrom: 'me@d3cloud.io', recipients: ['x@example.org'], heldBlobSha256: held.sha256, size: held.size, messageIdHeader: `<${randomUUID()}@d3cloud.io>` },
    });
    const sent = await outbound(gone, 'delivered');
    const restoredMail = await deliver([{ accountId: restored, mailbox: 'INBOX' }], raw('restored'));
    const queuedMail = await deliver([{ accountId: sending, mailbox: 'INBOX' }], raw('queued'));
    await outbound(sending, 'deferred');

    const at = now();
    for (const id of [gone, restored, sending]) await scheduleDeletion(id, at);
    await db.account.update({ where: { id: restored }, data: { disabledAt: null, deletionRequestedAt: null, deleteAfter: null } });
    const purge = createAccountPurger({ db, blobs, now });

    // Inside the grace period: nothing goes.
    offsetMs = 6 * DAY_MS;
    expect(await purge()).toEqual({ purged: 0, deferred: 0, messages: 0, shredded: 0 });
    expect(await db.account.count({ where: { id: gone } })).toBe(1);

    // After it: a batch size of one exercises every batch boundary.
    offsetMs = 7 * DAY_MS + 60_000;
    const result = await purge({ batchSize: 1 });
    expect(result).toMatchObject({ purged: 1, deferred: 1, messages: 3 });

    expect(await db.account.findUnique({ where: { id: gone } })).toBeNull();
    expect(await db.mailbox.count({ where: { accountId: gone } })).toBe(0);
    expect(await db.address.count({ where: { accountId: gone } })).toBe(0);
    // Crypto-shred: the wrapped DEK of every blob only this account held is gone, and so is its file.
    for (const sha of [mine, upload.sha256, held.sha256, sent]) {
      expect(await db.blob.findUnique({ where: { sha256: sha } })).toBeNull();
      expect(existsSync(fileOf(sha))).toBe(false);
    }
    expect(await db.inboundMessage.count({ where: { blobSha256: mine, blobReleasedAt: null } })).toBe(0);
    // The other account's copy of the same bytes is untouched: one message reference + the spool's.
    expect((await blobs.stat(shared))?.refcount).toBe(2);
    expect((await blobs.getBuffer(shared)).toString('utf8')).toContain('Subject: ours');
    expect(await db.message.count({ where: { mailbox: { accountId: stays } } })).toBe(1);

    // The restored account and the one still sending keep everything.
    expect(await db.message.count({ where: { mailbox: { accountId: restored } } })).toBe(1);
    expect((await blobs.stat(restoredMail))?.refcount).toBe(2);
    expect(await db.message.count({ where: { mailbox: { accountId: sending } } })).toBe(1);
    expect((await blobs.stat(queuedMail))?.refcount).toBe(2);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'account.purge', entityId: gone } });
    expect(audit.actorKind).toBe('system');
    expect(audit.after).toMatchObject({ deleted: true, messages: 3, heldSends: 1, uploads: 1, outbound: 1 });

    // Once its mail has left, the deferred account goes on the next run; a second run is a no-op.
    await db.outboundRecipient.updateMany({ where: { message: { accountId: sending } }, data: { state: 'delivered' } });
    expect(await purge()).toMatchObject({ purged: 1, deferred: 0 });
    expect(await db.blob.findUnique({ where: { sha256: queuedMail } })).toBeNull();
    expect(await purge()).toEqual({ purged: 0, deferred: 0, messages: 0, shredded: 0 });
  });
});
