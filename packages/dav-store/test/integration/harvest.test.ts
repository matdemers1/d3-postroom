// PST-T-8.5 against a real database: the contact index follows every write (its cache is keyed on
// the address books' sync tokens), and the harvest fills "Collected" through the same audited,
// sync-token-advancing write path a CardDAV PUT takes — once per address, never the account's own,
// never a no-reply address.
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { parseVCard, serializeVCard } from '@postroom/vcard';
import { buildContactCard, COLLECTED_SLUG, contactOf, ContactIndex, DavStore, DEFAULT_DAV_LIMITS, harvestRecipients } from '../../src/index.js';

const baseUrl = process.env['DATABASE_URL'];
const CONTEXT = { requestId: 'test-harvest', ip: '127.0.0.1', userAgent: 'vitest' };

describe.skipIf(baseUrl === undefined)('contacts index and harvest (PST-REQ-138)', () => {
  let t: TestDatabase;
  let db: Db;
  let store: DavStore;
  let index: ContactIndex;
  const kek = generateKek();

  const account = async (): Promise<{ id: string; address: string }> => {
    const login = `u${randomInt(1e9).toString(36)}`;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const a = await db.account.create({ data: { displayName: login } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: a.id } });
    return { id: a.id, address: `${login}@d3cloud.io` };
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t85_store');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    store = new DavStore(db, kek, DEFAULT_DAV_LIMITS);
    index = new ContactIndex(db, kek);
  }, 120_000);

  afterAll(async () => {
    await t.drop();
  });

  it('the index sees a card the moment it is written, and forgets it when deleted', async () => {
    const me = await account();
    const [contacts] = await store.listCollections(me.id, 'addressbook');
    if (contacts === undefined) throw new Error('the default Contacts address book is missing');
    expect(await index.emails(me.id)).toEqual(new Set());
    const card = buildContactCard('C1', { fn: 'Carol', given: '', family: '', emails: [{ address: 'Carol@Example.org', type: null }], tels: [], org: '', note: '' }, new Date());
    const put = await store.putResource({ accountId: me.id, context: CONTEXT }, contacts, { name: 'c1.vcf', uid: 'C1', componentType: null, data: Buffer.from(serializeVCard(card)), preconditions: {} });
    expect(put.status).toBe('created');
    expect(await index.emails(me.id)).toEqual(new Set(['carol@example.org']));
    expect(await index.lookup(me.id, 'carol@EXAMPLE.org')).toMatchObject({ name: 'Carol', addressBookId: contacts.id, resourceName: 'c1.vcf' });
    expect(await store.deleteResource({ accountId: me.id, context: CONTEXT }, contacts, 'c1.vcf', {})).toBe('deleted');
    expect(await index.emails(me.id)).toEqual(new Set());
  });

  it('adds new recipients to Collected, once, audited and sync-visible', async () => {
    const me = await account();
    const recipients = [
      { name: 'Alice Example', address: 'alice@example.org' },
      { name: '', address: 'Bob@Example.net' },
      { name: 'Me', address: me.address.toUpperCase() },
      { name: 'Robot', address: 'no-reply@shop.example' },
      { name: 'Alice again', address: 'ALICE@example.org' },
    ];
    const first = await harvestRecipients(db, store, index, { accountId: me.id, recipients, context: CONTEXT, now: new Date() });
    expect(first.added).toEqual(['alice@example.org', 'Bob@Example.net']);

    const book = await store.getCollection(me.id, 'addressbook', COLLECTED_SLUG);
    expect(book).toMatchObject({ displayName: 'Collected' });
    if (book === null) return;
    const cards = await store.getResources(book.id);
    expect(cards.map((c) => contactOf(parseVCard(c.data))).map((v) => [v.displayName, v.given, v.family, v.emails.map((e) => e.address)])).toEqual([
      ['Alice Example', 'Alice', 'Example', ['alice@example.org']],
      ['Bob@Example.net', '', '', ['Bob@Example.net']],
    ]);
    // A DAV client's sync-collection reads exactly this change log.
    expect((await store.changesBetween(book.id, 0n, (await store.currentSeq(book.id)) ?? 0n)).map((c) => c.deleted)).toEqual([false, false]);
    const audits = await db.auditEvent.findMany({ where: { requestId: CONTEXT.requestId, action: { in: ['dav.collection.create', 'dav.resource.create'] } } });
    expect(audits.length).toBeGreaterThanOrEqual(3);

    // Again: nothing new — the index already knows them.
    const second = await harvestRecipients(db, store, index, { accountId: me.id, recipients, context: CONTEXT, now: new Date() });
    expect(second.added).toEqual([]);
    // Even a stale view (a second index, or a replay racing the first) cannot duplicate a card.
    const racing = await harvestRecipients(db, store, { emails: () => Promise.resolve(new Set<string>()) } as unknown as ContactIndex, { accountId: me.id, recipients, context: CONTEXT, now: new Date() });
    expect(racing.added).toEqual([]);
    expect(await store.listResources(book.id)).toHaveLength(2);
  });

  it('never harvests someone already in another address book', async () => {
    const me = await account();
    const [contacts] = await store.listCollections(me.id, 'addressbook');
    if (contacts === undefined) throw new Error('no Contacts');
    const card = buildContactCard('D1', { fn: 'Dana', given: '', family: '', emails: [{ address: 'dana@example.org', type: null }], tels: [], org: '', note: '' }, new Date());
    await store.putResource({ accountId: me.id, context: CONTEXT }, contacts, { name: 'd1.vcf', uid: 'D1', componentType: null, data: Buffer.from(serializeVCard(card)), preconditions: {} });
    const result = await harvestRecipients(db, store, index, { accountId: me.id, recipients: [{ name: 'Dana', address: 'DANA@example.org' }], context: CONTEXT, now: new Date() });
    expect(result.added).toEqual([]);
    expect(await store.getCollection(me.id, 'addressbook', COLLECTED_SLUG)).toBeNull();
  });
});
