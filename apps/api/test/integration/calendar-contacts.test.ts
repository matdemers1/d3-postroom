// PST-T-8.5 against a real database: the webmail's calendar and contacts API, and contact
// auto-harvest. doneWhen — "Weekly recurrence renders; edits sync to iPhone; replies add contacts":
//
//   · a weekly BYDAY=MO,WE COUNT=6 event lists as exactly its six instances in the next month;
//   · every web edit is a change in the DAV store's sync log — what an iPhone's sync-collection
//     reads (apps/dav answers sync-collection from DavStore.currentSeq/changesBetween, used here);
//   · sending (and so replying) through /api/compose/send adds new recipients to "Collected".
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { kekFromBase64 } from '@postroom/crypto';
import { COLLECTED_SLUG, contactOf, DavStore, DEFAULT_DAV_LIMITS, type Change, type Collection } from '@postroom/dav-store';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { parseICalendar } from '@postroom/ical';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { parseVCard } from '@postroom/vcard';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { CalendarList, EventDetail, EventInstanceList, EventSaved } from '../../src/calendar/schemas.js';
import { AddressBookList, Contact, ContactList, ContactLookup, ContactSaved } from '../../src/contacts/schemas.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const OCTOBER = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', tz: 'America/New_York' };

const WEEKLY = {
  summary: 'Standup',
  location: 'Room 1',
  start: '2026-10-05T09:00',
  end: '2026-10-05T09:30',
  timezone: 'America/New_York',
  recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'], count: 6 },
};

describe.skipIf(!baseUrl)('calendar and contacts API (PST-T-8.5)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let store: DavStore;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    address: string;
    cookie: string;
  }

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}` });
    for (const [name, specialUse] of [
      ['INBOX', SpecialUse.inbox],
      ['Sent', SpecialUse.sent],
      ['Drafts', SpecialUse.drafts],
    ] as const) {
      await db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret) };
  };

  const get = (who: Person, path: string) => request(app).get(path).set('cookie', who.cookie);
  const send = (who: Person, method: 'post' | 'put' | 'delete', path: string, body?: unknown, etag?: string) => {
    let r = request(app)[method](path).set(CSRF).set('cookie', who.cookie);
    if (etag !== undefined) r = r.set('if-match', `"${etag}"`);
    return body === undefined ? r : r.send(body as object);
  };

  const collection = async (who: Person, kind: 'calendar' | 'addressbook', id: string): Promise<Collection> => {
    const c = (await store.listCollections(who.id, kind)).find((x) => x.id === id);
    if (c === undefined) throw new Error('collection not found');
    return c;
  };

  /** What a DAV client's sync-collection reports since `seq`: the changed resources, in order. */
  const syncSince = async (collectionId: string, seq: bigint): Promise<{ changes: Change[]; seq: bigint }> => {
    const now = (await store.currentSeq(collectionId)) ?? 0n;
    return { changes: await store.changesBetween(collectionId, seq, now), seq: now };
  };

  const calendarOf = async (who: Person): Promise<string> => {
    const res = await get(who, '/api/calendar/calendars');
    expect(res.status).toBe(200);
    const list = CalendarList.parse(res.body);
    const cal = list.calendars.find((c) => c.canHoldEvents);
    if (cal === undefined) throw new Error('no event calendar');
    return cal.id;
  };

  const instances = async (who: Person, range = OCTOBER) => {
    const res = await get(who, `/api/calendar/events?${new URLSearchParams(range).toString()}`);
    expect(res.status).toBe(200);
    return EventInstanceList.parse(res.body).instances;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t85');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t85-blobs-'));
    const kek = kekFromBase64(KEK_BASE64);
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    store = new DavStore(db, kek, DEFAULT_DAV_LIMITS);
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('needs a session and the CSRF header', async () => {
    expect((await request(app).get('/api/calendar/calendars')).status).toBe(401);
    expect((await request(app).get('/api/contacts')).status).toBe(401);
    const me = await person();
    const calendarId = await calendarOf(me);
    expect((await request(app).post(`/api/calendar/calendars/${calendarId}/events`).set('cookie', me.cookie).send(WEEKLY)).status).toBe(403);
  });

  it('doneWhen: a weekly MO,WE ×6 event lists as its six instances, and the DAV sync log reports it', async () => {
    const me = await person();
    const calendarId = await calendarOf(me);
    const before = (await store.currentSeq(calendarId)) ?? 0n;

    const created = await send(me, 'post', `/api/calendar/calendars/${calendarId}/events`, WEEKLY);
    expect(created.status).toBe(201);
    const saved = EventSaved.parse(created.body);
    expect(created.headers['etag']).toBe(`"${saved.etag}"`);

    const list = await instances(me);
    expect(list.map((i) => i.start)).toEqual([
      '2026-10-05T13:00:00.000Z',
      '2026-10-07T13:00:00.000Z',
      '2026-10-12T13:00:00.000Z',
      '2026-10-14T13:00:00.000Z',
      '2026-10-19T13:00:00.000Z',
      '2026-10-21T13:00:00.000Z',
    ]);
    expect(list.map((i) => new Date(i.start).getUTCDay())).toEqual([1, 3, 1, 3, 1, 3]);
    expect(list.every((i) => i.name === saved.name && i.recurring && !i.override && i.summary === 'Standup')).toBe(true);

    // What an iPhone's sync-collection sees: one new resource, and its bytes are the event.
    const sync = await syncSince(calendarId, before);
    expect(sync.changes).toEqual([{ name: saved.name, deleted: false, seq: before + 1n }]);
    const [resource] = await store.getResources(calendarId, [saved.name]);
    expect(resource?.etag).toBe(saved.etag);
    const stored = parseICalendar(resource?.data ?? Buffer.alloc(0));
    expect(stored.components[0]?.properties.find((p) => p.name === 'RRULE')?.value).toBe('FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE');

    // The audit row is the store's own.
    const audit = await db.auditEvent.findFirst({ where: { action: 'dav.resource.create', entityId: resource?.id ?? '' } });
    expect(audit).not.toBeNull();
  });

  it('editing one instance writes an override; every edit is a sync change; stale or missing If-Match is refused', async () => {
    const me = await person();
    const calendarId = await calendarOf(me);
    const saved = EventSaved.parse((await send(me, 'post', `/api/calendar/calendars/${calendarId}/events`, WEEKLY)).body);
    let seq = (await store.currentSeq(calendarId)) ?? 0n;
    const path = `/api/calendar/calendars/${calendarId}/events/${encodeURIComponent(saved.name)}`;

    const moveBody = { summary: 'Standup (moved)', start: '2026-10-13T10:00', end: '2026-10-13T11:00', timezone: 'America/New_York' };
    expect((await send(me, 'put', `${path}/instances/20261012T090000`, moveBody)).status).toBe(428);
    expect((await send(me, 'put', `${path}/instances/20261012T090000`, moveBody, 'stale')).status).toBe(412);
    expect((await send(me, 'put', `${path}/instances/20261013T090000`, moveBody, saved.etag)).status).toBe(404);

    const moved = await send(me, 'put', `${path}/instances/20261012T090000`, moveBody, saved.etag);
    expect(moved.status).toBe(200);
    const afterMove = EventSaved.parse(moved.body);
    let sync = await syncSince(calendarId, seq);
    expect(sync.changes.map((c) => [c.name, c.deleted])).toEqual([[saved.name, false]]);
    seq = sync.seq;

    const list = await instances(me);
    expect(list).toHaveLength(6);
    const override = list.find((i) => i.override);
    expect(override).toMatchObject({ recurrenceId: '20261012T090000', start: '2026-10-13T14:00:00.000Z', end: '2026-10-13T15:00:00.000Z', summary: 'Standup (moved)' });

    const detail = EventDetail.parse((await get(me, path)).body);
    expect(detail).toMatchObject({ etag: afterMove.etag, summary: 'Standup', overrides: ['20261012T090000'], recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'], count: 6, editable: true } });

    // Delete one instance: an EXDATE.
    const cut = await send(me, 'delete', `${path}/instances/20261019T090000`, undefined, afterMove.etag);
    expect(cut.status).toBe(200);
    const afterCut = EventSaved.parse(cut.body);
    expect((await instances(me)).map((i) => i.recurrenceId)).not.toContain('20261019T090000');
    sync = await syncSince(calendarId, seq);
    expect(sync.changes).toHaveLength(1);
    seq = sync.seq;

    // Edit the series (rename, keep the rule): the override stays.
    const renamed = await send(me, 'put', path, { ...WEEKLY, summary: 'Team standup', recurrence: undefined }, afterCut.etag);
    expect(renamed.status).toBe(200);
    const afterRename = EventSaved.parse(renamed.body);
    expect((await instances(me)).filter((i) => i.summary === 'Team standup')).toHaveLength(4);

    // Delete the whole event: the sync log reports a deletion.
    expect((await send(me, 'delete', path, undefined, afterCut.etag)).status).toBe(412);
    expect((await send(me, 'delete', path, undefined, afterRename.etag)).status).toBe(204);
    sync = await syncSince(calendarId, seq);
    expect(sync.changes.map((c) => [c.name, c.deleted])).toEqual([
      [saved.name, false],
      [saved.name, true],
    ]);
    expect(await instances(me)).toEqual([]);
  });

  it('an event made by a DAV client is listed and editable on the web, keeping what the web does not own', async () => {
    const me = await person();
    const calendarId = await calendarOf(me);
    const cal = await collection(me, 'calendar', calendarId);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
      'BEGIN:VEVENT',
      'UID:PHONE-EVENT-1',
      'DTSTAMP:20260901T000000Z',
      'DTSTART;VALUE=DATE:20261010',
      'DTEND;VALUE=DATE:20261011',
      'SUMMARY:Birthday',
      'RRULE:FREQ=YEARLY',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const put = await store.putResource({ accountId: me.id, context: { requestId: 'phone' } }, cal, { name: 'phone.ics', uid: 'PHONE-EVENT-1', componentType: 'VEVENT', data: Buffer.from(ics), preconditions: {} });
    if (put.status !== 'created') throw new Error(put.status);
    const [birthday] = await instances(me);
    expect(birthday).toMatchObject({ allDay: true, startDay: '2026-10-10', endDay: '2026-10-11', summary: 'Birthday' });
    const edited = await send(me, 'put', `/api/calendar/calendars/${calendarId}/events/phone.ics`, { summary: 'Birthday!', allDay: true, start: '2026-10-10', end: '2026-10-11' }, put.etag);
    expect(edited.status).toBe(200);
    const [resource] = await store.getResources(calendarId, ['phone.ics']);
    const text = resource?.data.toString('utf8') ?? '';
    expect(text).toContain('SUMMARY:Birthday!');
    expect(text).toContain('BEGIN:VALARM');
    expect(text).toContain('RRULE:FREQ=YEARLY');
  });

  it('validates ranges and bodies, and another account’s calendar is not found', async () => {
    const me = await person();
    const other = await person();
    const calendarId = await calendarOf(me);
    expect((await get(me, `/api/calendar/events?${new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2028-10-01T00:00:00Z' }).toString()}`)).status).toBe(400);
    expect((await get(me, `/api/calendar/events?${new URLSearchParams({ ...OCTOBER, tz: 'Mars/Base' }).toString()}`)).status).toBe(400);
    expect((await send(me, 'post', `/api/calendar/calendars/${calendarId}/events`, { ...WEEKLY, end: '2026-10-05T08:00' })).status).toBe(400);
    expect((await send(other, 'post', `/api/calendar/calendars/${calendarId}/events`, WEEKLY)).status).toBe(404);
  });

  it('contacts: create, read, search, look up, edit with If-Match, delete — each a sync change', async () => {
    const me = await person();
    const books = AddressBookList.parse((await get(me, '/api/contacts/address-books')).body).addressBooks;
    const contacts = books.find((b) => b.slug === 'contacts');
    if (contacts === undefined) throw new Error('no Contacts');
    let seq = (await store.currentSeq(contacts.id)) ?? 0n;

    expect((await send(me, 'post', `/api/contacts/address-books/${contacts.id}/cards`, {})).status).toBe(400);
    const created = await send(me, 'post', `/api/contacts/address-books/${contacts.id}/cards`, {
      given: 'Grace',
      family: 'Hopper',
      emails: [{ address: 'grace@navy.example', type: 'work' }],
      tels: [{ value: '+1 555 0199', type: 'cell' }],
      org: 'US Navy',
      note: 'COBOL',
    });
    expect(created.status).toBe(201);
    const saved = ContactSaved.parse(created.body);
    let sync = await syncSince(contacts.id, seq);
    expect(sync.changes.map((c) => [c.name, c.deleted])).toEqual([[saved.name, false]]);
    seq = sync.seq;

    const path = `/api/contacts/address-books/${contacts.id}/cards/${encodeURIComponent(saved.name)}`;
    const detail = Contact.parse((await get(me, path)).body);
    expect(detail).toMatchObject({ displayName: 'Grace Hopper', given: 'Grace', family: 'Hopper', emails: [{ address: 'grace@navy.example', type: 'work' }], tels: [{ value: '+1 555 0199', type: 'cell' }], org: 'US Navy', note: 'COBOL' });

    expect(ContactList.parse((await get(me, '/api/contacts?q=hopp')).body).contacts.map((c) => c.displayName)).toEqual(['Grace Hopper']);
    expect(ContactList.parse((await get(me, '/api/contacts?q=nobody')).body).contacts).toEqual([]);
    expect(ContactLookup.parse((await get(me, '/api/contacts/lookup?address=GRACE@navy.example')).body).contact).toEqual({ addressBookId: contacts.id, name: saved.name, displayName: 'Grace Hopper' });
    expect(ContactLookup.parse((await get(me, '/api/contacts/lookup?address=who@example.org')).body).contact).toBeNull();

    const edit = { fn: 'Rear Admiral Grace Hopper', given: 'Grace', family: 'Hopper', emails: [{ address: 'grace@navy.example', type: 'work' }, { address: 'amazing.grace@example.org', type: 'home' }], tels: [], org: 'US Navy', note: '' };
    expect((await send(me, 'put', path, edit)).status).toBe(428);
    expect((await send(me, 'put', path, edit, 'stale')).status).toBe(412);
    const updated = await send(me, 'put', path, edit, saved.etag);
    expect(updated.status).toBe(200);
    const afterEdit = ContactSaved.parse(updated.body);
    expect(Contact.parse((await get(me, path)).body)).toMatchObject({ displayName: 'Rear Admiral Grace Hopper', emails: [{ address: 'grace@navy.example' }, { address: 'amazing.grace@example.org' }], tels: [] });
    sync = await syncSince(contacts.id, seq);
    expect(sync.changes.map((c) => [c.name, c.deleted])).toEqual([[saved.name, false]]);
    seq = sync.seq;

    expect((await send(me, 'delete', path, undefined, saved.etag)).status).toBe(412);
    expect((await send(me, 'delete', path, undefined, afterEdit.etag)).status).toBe(204);
    sync = await syncSince(contacts.id, seq);
    expect(sync.changes.map((c) => [c.name, c.deleted])).toEqual([[saved.name, true]]);
    expect(ContactList.parse((await get(me, '/api/contacts')).body).contacts).toEqual([]);

    const other = await person();
    expect((await get(other, path)).status).toBe(404);
  });

  it('a card written by an iPhone keeps its photo when edited on the web', async () => {
    const me = await person();
    const [book] = await store.listCollections(me.id, 'addressbook');
    if (book === undefined) throw new Error('no book');
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Lin;Mei;;;\r\nFN:Mei Lin\r\nEMAIL;type=INTERNET:mei@example.org\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ\r\nUID:PHONE-CARD\r\nEND:VCARD\r\n';
    const put = await store.putResource({ accountId: me.id, context: { requestId: 'phone' } }, book, { name: 'phone.vcf', uid: 'PHONE-CARD', componentType: null, data: Buffer.from(vcf), preconditions: {} });
    if (put.status !== 'created') throw new Error(put.status);
    const res = await send(me, 'put', `/api/contacts/address-books/${book.id}/cards/phone.vcf`, { fn: 'Mei Lin', emails: [{ address: 'mei@example.org', type: null }], tels: [{ value: '555', type: null }] }, put.etag);
    expect(res.status).toBe(200);
    const [stored] = await store.getResources(book.id, ['phone.vcf']);
    const view = contactOf(parseVCard(stored?.data ?? Buffer.alloc(0)));
    expect(view).toMatchObject({ hasPhoto: true, tels: [{ value: '555' }] });
  });

  it('harvest: sending to two new people adds both to Collected, once; never the sender, never no-reply', async () => {
    const me = await person();
    const body = {
      from: me.address,
      to: ['Alice Example <alice@example.org>', me.address],
      cc: ['bob@example.net', 'noreply@shop.example'],
      subject: 'Hello',
      text: 'Hi both',
    };
    const first = await send(me, 'post', '/api/compose/send', body);
    expect(first.status).toBe(201);
    const collected = await store.getCollection(me.id, 'addressbook', COLLECTED_SLUG);
    expect(collected).toMatchObject({ displayName: 'Collected' });
    if (collected === null) return;
    const names = async () =>
      (await store.getResources(collected.id)).map((r) => contactOf(parseVCard(r.data))).map((v) => [v.displayName, v.emails.map((e) => e.address)]);
    expect(await names()).toEqual([
      ['Alice Example', ['alice@example.org']],
      ['bob@example.net', ['bob@example.net']],
    ]);
    // The same store path: audited, and a CardDAV client's sync sees both.
    expect((await syncSince(collected.id, 0n)).changes).toHaveLength(2);

    // A reply to one of them (and a Bcc'd stranger): nothing duplicated, and Bcc is never harvested.
    const reply = await send(me, 'post', '/api/compose/send', { from: me.address, to: ['alice@example.org'], bcc: ['secret@example.org'], subject: 'Re: Hello', text: 'again', inReplyTo: '<x@example.org>' });
    expect(reply.status).toBe(201);
    expect(await names()).toHaveLength(2);

    // The web lists Collected like any address book.
    const books = AddressBookList.parse((await get(me, '/api/contacts/address-books')).body).addressBooks;
    expect(books.find((b) => b.slug === COLLECTED_SLUG)).toMatchObject({ displayName: 'Collected', count: 2 });
  });

  it('replying to someone new adds them', async () => {
    const me = await person();
    const res = await send(me, 'post', '/api/compose/send', { from: me.address, to: ['Carol New <carol@example.com>'], subject: 'Re: your note', text: 'Thanks!', inReplyTo: '<note-1@example.com>', references: ['<note-1@example.com>'] });
    expect(res.status).toBe(201);
    expect(ContactLookup.parse((await get(me, '/api/contacts/lookup?address=carol@example.com')).body).contact).toMatchObject({ displayName: 'Carol New' });
  });
});
