// PST-T-8.5: the classifier's "contact" signal reads the account's CardDAV cards. A first-time
// human who is in the address book, writing directly, is Priority (PST-REQ-101) — the same person
// not in it is People with the new-sender badge. The worker finds its KEK where its blob store does
// (POSTROOM_KEK), decrypts the cards through @postroom/dav-store's ContactIndex, and sees a card
// the moment it is written (the index is keyed on the address books' sync tokens).
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { exportKekBase64, generateKek } from '@postroom/crypto';
import { contactCardBytes, DavStore, DEFAULT_DAV_LIMITS } from '@postroom/dav-store';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

function message(from: string, to: string, subject: string): Buffer {
  return Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Sat, 26 Sep 2026 12:00:00 +0000\r\nMessage-ID: <${randomUUID()}@example.org>\r\n\r\nhello\r\n`,
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('address-book contacts in the classifier (PST-T-8.5)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let worker: RunningWorker;
  let meId = '';
  const kek = generateKek();
  const previousKek = process.env['POSTROOM_KEK'];

  const rcpt: () => TestRecipient = () => ({ rcpt: 'me@d3cloud.io', address: 'me@d3cloud.io', accountIds: [meId], kind: 'mailbox' });

  const deliver = async (from: string, subject: string) => {
    const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
    const { id } = await spool(db, blobs, { recipients: [rcpt()], envelopeFrom: address, message: message(from, 'me@d3cloud.io', subject) });
    await worker.drain();
    return db.message.findMany({ where: { inboundMessageId: id }, include: { mailbox: { select: { name: true } }, verdict: true } });
  };

  beforeAll(async () => {
    process.env['POSTROOM_KEK'] = exportKekBase64(kek);
    t = await createTestDatabase(baseUrl ?? '', 'pst_t85_worker');
    db = t.db;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    const account = await db.account.create({ data: { displayName: 'me' } });
    meId = account.id;
    await db.address.create({ data: { localPart: 'me', domainId: d.id, kind: AddressKind.primary, accountId: meId } });
    for (const m of DEFAULT_MAILBOXES) await db.mailbox.create({ data: { accountId: meId, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t85-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek });
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs }).handle }, manual: true });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
    if (previousKek === undefined) delete process.env['POSTROOM_KEK'];
    else process.env['POSTROOM_KEK'] = previousKek;
  });

  it('a first-time human is People and badged new; once they are a contact, Priority', async () => {
    const stranger = await deliver('Ruth Stranger <ruth@example.net>', 'first hello');
    expect(stranger[0]).toMatchObject({ mailbox: { name: 'INBOX' }, verdict: { bucket: 'people' } });
    expect(stranger[0]?.verdict?.reasons.some((r) => r.startsWith('new-sender:'))).toBe(true);

    // The account adds a card (as an iPhone or the web would, through the DAV store).
    const store = new DavStore(db, kek, DEFAULT_DAV_LIMITS);
    const [book] = await store.listCollections(meId, 'addressbook');
    if (book === undefined) throw new Error('no default address book');
    const data = contactCardBytes('RUTH', { fn: 'Ruth', given: '', family: '', emails: [{ address: 'Ruth@Example.net', type: null }], tels: [], org: '', note: '' }, new Date());
    const put = await store.putResource({ accountId: meId, context: { requestId: 'test' } }, book, { name: 'ruth.vcf', uid: 'RUTH', componentType: null, data, preconditions: {} });
    expect(put.status).toBe('created');

    // A different sender who is a contact, writing for the first time: Priority.
    const contact = await deliver('Ruth <ruth@example.net>', 'second hello');
    expect(contact[0]).toMatchObject({ flags: ['$Priority'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'priority' } });
    expect(contact[0]?.verdict?.reasons.some((r) => r.includes('contacts'))).toBe(true);
    expect(contact[0]?.verdict?.reasons.some((r) => r.startsWith('new-sender:'))).toBe(false);
  });
});
