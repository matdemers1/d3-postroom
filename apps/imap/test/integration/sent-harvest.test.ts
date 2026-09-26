// PST-T-5.8 (PST-REQ-102): a client filing its own copy into \Sent via IMAP APPEND (rather than
// sending through acceptSubmission) still counts as writing to its To/Cc addresses — the same
// correspondent table upsert, in the same transaction as the APPEND.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { COLLECTED_SLUG, contactOfBytes, DavStore, DEFAULT_DAV_LIMITS } from '@postroom/dav-store';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { denormalise, MailStore } from '../../src/store.js';
import { parseHeaderBlock } from '@postroom/mime';

const baseUrl = process.env['DATABASE_URL'];

function headerBlock(to: string): string {
  return `From: me@d3cloud.io\r\nTo: ${to}\r\nCc: watching@example.net\r\nSubject: hi\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <x@d3cloud.io>\r\n`;
}

function sentMessage(to: string): Buffer {
  return Buffer.from(`${headerBlock(to)}\r\nhello\r\n`, 'latin1');
}

describe.skipIf(baseUrl === undefined)('a Sent APPEND harvests To/Cc into the correspondent table (PST-T-5.8)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let store: MailStore;
  let accountId = '';
  let sentMailboxId = '';

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t58imap');
    db = t.db;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const account = await db.account.create({ data: { displayName: 'me' } });
    await db.address.create({ data: { localPart: 'me', domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    accountId = account.id;
    for (const m of DEFAULT_MAILBOXES) {
      const created = await db.mailbox.create({ data: { accountId, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
      if (m.specialUse === 'sent') sentMailboxId = created.id;
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t58-imap-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    store = new MailStore(db, blobs);
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('appending into \\Sent upserts a correspondent row for To and Cc', async () => {
    const to = 'Alice <alice@example.org>';
    const raw = sentMessage(to);
    const put = await blobs.put(raw);
    const headers = parseHeaderBlock(Buffer.from(headerBlock(to), 'latin1'));
    await store.append(accountId, sentMailboxId, {
      sha256: put.sha256,
      size: put.size,
      flags: [],
      internalDate: new Date(),
      denorm: denormalise(headers),
    });
    const alice = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'alice@example.org' } } });
    const watcher = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'watching@example.net' } } });
    expect(alice).toMatchObject({ count: 1 });
    expect(watcher).toMatchObject({ count: 1 });
  });

  it('appending into INBOX (not \\Sent) does not harvest', async () => {
    const inbox = await db.mailbox.findFirstOrThrow({ where: { accountId, name: 'INBOX' } });
    const to = 'Bob <bob@example.org>';
    const raw = sentMessage(to);
    const put = await blobs.put(raw);
    const headers = parseHeaderBlock(Buffer.from(headerBlock(to), 'latin1'));
    await store.append(accountId, inbox.id, {
      sha256: put.sha256,
      size: put.size,
      flags: [],
      internalDate: new Date(),
      denorm: denormalise(headers),
    });
    const bob = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'bob@example.org' } } });
    expect(bob).toBeNull();
  });
});

describe.skipIf(baseUrl === undefined)('a Sent APPEND harvests contacts too, skipping the list (PST-T-8.8, PST-REQ-138)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let blobRoot = '';
  let store: MailStore;
  let davStore: DavStore;
  let accountId = '';
  let sentMailboxId = '';

  const namesInCollected = async (): Promise<string[]> => {
    const book = await davStore.getCollection(accountId, 'addressbook', COLLECTED_SLUG);
    if (book === null) return [];
    return (await davStore.getResources(book.id)).map((r) => contactOfBytes(r.data).displayName).sort();
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t88imap');
    db = t.db;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const account = await db.account.create({ data: { displayName: 'me' } });
    await db.address.create({ data: { localPart: 'me', domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    accountId = account.id;
    for (const m of DEFAULT_MAILBOXES) {
      const created = await db.mailbox.create({ data: { accountId, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
      if (m.specialUse === 'sent') sentMailboxId = created.id;
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t88-imap-'));
    kek = generateKek();
    blobs = createBlobStore({ root: blobRoot, db, kek });
    store = new MailStore(db, blobs, kek);
    davStore = new DavStore(db, kek, DEFAULT_DAV_LIMITS);
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  function fullMessage(headers: string, body: string): Buffer {
    return Buffer.from(`${headers}\r\n${body}`, 'latin1');
  }

  it('a plain Sent APPEND harvests the humans, never a role/list local part', async () => {
    const headerText = `From: me@d3cloud.io\r\nTo: Bob <bob@example.org>\r\nCc: digest@lists.example.org\r\nSubject: hi\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <plain@d3cloud.io>\r\n`;
    const raw = fullMessage(headerText, 'hello\r\n');
    const put = await blobs.put(raw);
    const headers = parseHeaderBlock(Buffer.from(headerText, 'latin1'));
    await store.append(accountId, sentMailboxId, { sha256: put.sha256, size: put.size, flags: [], internalDate: new Date(), denorm: denormalise(headers) });
    expect(await namesInCollected()).toEqual(['Bob']);
  });

  it('a Reply-All to a list thread harvests the humans but not the list posting address', async () => {
    // Seed the original list message in the account's INBOX, carrying List-Id/List-Post.
    const originalHeaders =
      'From: someone@example.org\r\nTo: the-club@example.org\r\nSubject: club news\r\n' +
      `Date: ${new Date().toUTCString()}\r\nMessage-ID: <orig@example.org>\r\n` +
      'List-Id: The Club <the-club.example.org>\r\nList-Post: <mailto:the-club@example.org>\r\n';
    const originalPut = await blobs.put(fullMessage(originalHeaders, 'hello, club\r\n'));
    await db.$transaction(async (tx) => {
      const filed = await fileLocalMessage(tx, { accountId, mailbox: 'INBOX', blobSha256: originalPut.sha256, size: originalPut.size, internalDate: new Date() });
      await tx.message.update({ where: { id: filed.id }, data: { messageIdHeader: 'orig@example.org' } });
    });

    // The Reply-All: To carries the list address alongside a human, In-Reply-To names the original.
    const replyHeaders =
      'From: me@d3cloud.io\r\nTo: Alice <alice@example.org>, the-club@example.org\r\n' +
      `Subject: Re: club news\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <reply@d3cloud.io>\r\n` +
      'In-Reply-To: <orig@example.org>\r\n';
    const replyPut = await blobs.put(fullMessage(replyHeaders, 'hello back\r\n'));
    const headers = parseHeaderBlock(Buffer.from(replyHeaders, 'latin1'));
    await store.append(accountId, sentMailboxId, { sha256: replyPut.sha256, size: replyPut.size, flags: [], internalDate: new Date(), denorm: denormalise(headers) });

    expect(await namesInCollected()).toEqual(['Alice', 'Bob']);
  });
});
