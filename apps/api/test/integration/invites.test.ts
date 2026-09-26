// PST-T-8.4 against a real database: iMIP invitations in the webmail (PST-REQ-134). doneWhen —
// Accept/Maybe/Decline sends an RFC 6047 METHOD:REPLY to the ORGANIZER through the existing send
// path with only the replying ATTENDEE and its PARTSTAT, and adds or updates the event in the user's
// default calendar (visible over CalDAV); a CANCEL marks it cancelled; the outbound REPLY is
// captured and checked against RFC 5546.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { DavStore, DEFAULT_DAV_LIMITS } from '@postroom/dav-store';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { getProperties, getProperty, parseICalendar } from '@postroom/ical';
import { collectMessage, parseMessage } from '@postroom/mime';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { InviteRemoveResult, InviteRespondResult, InviteView } from '../../src/invites/schemas.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const ORGANIZER = 'priya@example.com';

interface IcsOpts {
  sequence?: number;
  status?: string;
  /** The ORGANIZER's mailto value (after `mailto:`), raw — default the genuine organizer. */
  organizer?: string;
}

function foldedIcs(uid: string, method: 'REQUEST' | 'CANCEL', attendee: string, opts: IcsOpts = {}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'X-LIC-LOCATION:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/New_York:20261005T140000',
    'DTEND;TZID=America/New_York:20261005T150000',
    'DTSTAMP:20260928T120000Z',
    `ORGANIZER;CN=Priya Patel:mailto:${opts.organizer ?? ORGANIZER}`,
    `UID:${uid}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Reader:mailto:${attendee}`,
    `SEQUENCE:${String(opts.sequence ?? 0)}`,
    `STATUS:${opts.status ?? 'CONFIRMED'}`,
    'SUMMARY:Quarterly Planning Sync',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];
  return lines.join('\r\n');
}

function inviteMessage(to: string, uid: string, method: 'REQUEST' | 'CANCEL', opts: IcsOpts = {}): Buffer {
  const ics = foldedIcs(uid, method, to, opts);
  const head = ['From: Priya Patel <priya@example.com>', `To: ${to}`, `Subject: ${method === 'CANCEL' ? 'Cancelled: ' : ''}Quarterly Planning Sync`, 'Date: Mon, 28 Sep 2026 12:00:00 +0000', `Message-ID: <${randomUUID()}@example.com>`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="inv"'];
  const body = ['--inv', 'Content-Type: text/plain; charset=utf-8', '', 'See the attached invitation.', '', '--inv', `Content-Type: text/calendar; method=${method}; charset=UTF-8`, 'Content-Transfer-Encoding: 8bit', '', ics, '--inv--', ''];
  return Buffer.from([...head, '', ...body].join('\r\n'));
}

describe.skipIf(!baseUrl)('iMIP invitations (PST-T-8.4)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let store: DavStore;
  let blobs: BlobStore;
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
    await db.mailbox.create({ data: { accountId: id, name: 'INBOX', specialUse: SpecialUse.inbox, uidvalidity: randomUidValidity(randomInt) } });
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret) };
  };

  /** DMARC as smtp-in/the worker store it in message_verdict.auth; `null` files no verdict at all. */
  type Auth = { dmarc: 'pass' | 'fail'; fromDomain: string } | null;

  const file = async (me: Person, raw: Buffer, auth: Auth = null): Promise<string> => {
    const put = await blobs.put(raw);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date() }));
    if (auth !== null) {
      await db.messageVerdict.create({
        data: {
          messageId: filed.id,
          bucket: 'people',
          reasons: ['test'],
          auth: {
            spf: { result: auth.dmarc },
            dkim: [{ result: auth.dmarc, domain: auth.fromDomain }],
            dmarc: { result: auth.dmarc, fromDomain: auth.fromDomain, fromDomains: [auth.fromDomain] },
          },
        },
      });
    }
    return filed.id;
  };
  const GENUINE: Auth = { dmarc: 'pass', fromDomain: 'example.com' };

  const get = (who: Person, path: string) => request(app).get(path).set('cookie', who.cookie);
  const post = (who: Person, path: string, body?: unknown) => {
    const r = request(app).post(path).set(CSRF).set('cookie', who.cookie);
    return body === undefined ? r.send() : r.send(body as object);
  };

  const defaultCalendar = async (accountId: string) => {
    const c = await store.getCollection(accountId, 'calendar', 'calendar');
    if (c === null) throw new Error('no default calendar');
    return c;
  };

  /** The text/calendar part of a raw blob (transfer-decoded), or null. */
  const calendarPartOf = async (raw: Buffer): Promise<Buffer | null> => {
    const { Readable } = await import('node:stream');
    let partId: string | null = null;
    const chunks: Buffer[] = [];
    for await (const event of parseMessage(Readable.from([raw]))) {
      if (event.type === 'headers' && event.part.kind === 'leaf' && event.part.contentType === 'text/calendar' && partId === null) partId = event.part.id;
      else if (partId !== null && event.type === 'body' && event.part.id === partId) chunks.push(event.chunk);
      else if (partId !== null && event.type === 'end-part' && event.part.id === partId) break;
    }
    return partId === null ? null : Buffer.concat(chunks);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t84_invites');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t84-blobs-'));
    const kek = kekFromBase64(KEK_BASE64);
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    store = new DavStore(db, kek, DEFAULT_DAV_LIMITS);
    blobs = createBlobStore({ root: blobRoot, db, kek });
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
    const me = await person();
    const id = await file(me, inviteMessage(me.address, randomUUID(), 'REQUEST'));
    expect((await request(app).get(`/api/messages/${id}/invite`)).status).toBe(401);
    expect((await request(app).post(`/api/messages/${id}/invite/respond`).set('cookie', me.cookie).send({ partstat: 'ACCEPTED' })).status).toBe(403);
  });

  it('doneWhen: Accept sends an RFC 5546 REPLY to the organizer and files the event in the default calendar, visible over CalDAV', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const messageId = await file(me, inviteMessage(me.address, uid, 'REQUEST'));

    const before = await store.currentSeq((await defaultCalendar(me.id)).id);

    const view1 = InviteView.parse((await get(me, `/api/messages/${messageId}/invite`)).body);
    expect(view1).toMatchObject({ method: 'REQUEST', uid, summary: 'Quarterly Planning Sync', organizer: { email: ORGANIZER, cn: 'Priya Patel' }, cancelled: false, inCalendar: false });
    expect(view1.you).toMatchObject({ email: me.address, partstat: 'NEEDS-ACTION' });

    const respond = await post(me, `/api/messages/${messageId}/invite/respond`, { partstat: 'ACCEPTED' });
    expect(respond.status).toBe(200);
    expect(InviteRespondResult.parse(respond.body)).toMatchObject({ ok: true, partstat: 'ACCEPTED', calendarName: `${uid}.ics` });

    // Exactly one outbound message, to the organizer only, from this account.
    const outboundRows = await db.outboundMessage.findMany({ where: { accountId: me.id }, include: { recipients: true } });
    expect(outboundRows).toHaveLength(1);
    const outbound = outboundRows[0];
    if (outbound === undefined) throw new Error('no outbound message');
    expect(outbound.envelopeFrom).toBe(me.address);
    expect(outbound.recipients.map((r) => r.address)).toEqual([ORGANIZER]);
    expect(await db.job.count({ where: { queue: 'outbound', payload: { path: ['messageId'], equals: outbound.id } } })).toBe(1);

    // The REPLY itself, captured and checked against RFC 5546 §3.2.3: METHOD:REPLY, the same UID,
    // ORGANIZER unchanged, and exactly one ATTENDEE (the replier) with PARTSTAT=ACCEPTED.
    const raw = await (async () => {
      const stream = await blobs.get(outbound.blobSha256);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
      return Buffer.concat(chunks);
    })();
    const calendarPart = await calendarPartOf(raw);
    if (calendarPart === null) throw new Error('no text/calendar part in the outbound reply');
    const parsedReply = parseICalendar(calendarPart);
    expect(getProperty(parsedReply, 'METHOD')?.value).toBe('REPLY');
    const [vevent] = parsedReply.components;
    if (vevent === undefined) throw new Error('no VEVENT in the reply');
    expect(getProperty(vevent, 'UID')?.value).toBe(uid);
    expect(getProperty(vevent, 'ORGANIZER')?.value).toBe(`mailto:${ORGANIZER}`);
    const attendees = getProperties(vevent, 'ATTENDEE');
    expect(attendees).toHaveLength(1);
    expect(attendees[0]?.value).toBe(`mailto:${me.address}`);
    expect(attendees[0]?.params['PARTSTAT']).toEqual(['ACCEPTED']);
    // The message summary also finds it, exactly as the reading pane's InviteCard would.
    const summary = await collectMessage(await blobs.get(outbound.blobSha256));
    expect(summary.attachments.some((a) => a.contentType === 'text/calendar')).toBe(true);

    // Filed into the default calendar, and a CalDAV client's sync-collection would see it.
    const calendar = await defaultCalendar(me.id);
    const [resource] = await store.getResources(calendar.id, [`${uid}.ics`]);
    if (resource === undefined) throw new Error('event not filed in the default calendar');
    const stored = parseICalendar(resource.data);
    const storedEvent = stored.components.find((c) => c.name === 'VEVENT');
    if (storedEvent === undefined) throw new Error('no VEVENT stored');
    expect(getProperty(storedEvent, 'UID')?.value).toBe(uid);
    const storedAttendee = getProperties(storedEvent, 'ATTENDEE').find((a) => a.value === `mailto:${me.address}`);
    expect(storedAttendee?.params['PARTSTAT']).toEqual(['ACCEPTED']);
    const after = await store.currentSeq(calendar.id);
    expect((after ?? 0n) > (before ?? 0n)).toBe(true);
    const changes = await store.changesBetween(calendar.id, before ?? 0n, after ?? 0n);
    expect(changes.map((c) => c.name)).toEqual([`${uid}.ics`]);

    // The invite view now reports the caller's own PARTSTAT and that it is in the calendar.
    const view2 = InviteView.parse((await get(me, `/api/messages/${messageId}/invite`)).body);
    expect(view2).toMatchObject({ inCalendar: true, you: { email: me.address, partstat: 'ACCEPTED' } });

    // Idempotent: responding ACCEPTED again does not error and does not create a second resource.
    const again = await post(me, `/api/messages/${messageId}/invite/respond`, { partstat: 'ACCEPTED' });
    expect(again.status).toBe(200);
    expect((await store.listResources(calendar.id)).filter((r) => r.name === `${uid}.ics`)).toHaveLength(1);
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(2);

    // Changing the answer updates the same calendar object, and queues a new REPLY.
    const decline = await post(me, `/api/messages/${messageId}/invite/respond`, { partstat: 'DECLINED' });
    expect(decline.status).toBe(200);
    const [resource2] = await store.getResources(calendar.id, [`${uid}.ics`]);
    const stored2 = parseICalendar(resource2?.data ?? Buffer.alloc(0));
    const stored2Event = stored2.components.find((c) => c.name === 'VEVENT') ?? { name: '', properties: [], components: [] };
    const attendee2 = getProperties(stored2Event, 'ATTENDEE').find((a) => a.value === `mailto:${me.address}`);
    expect(attendee2?.params['PARTSTAT']).toEqual(['DECLINED']);
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(3);
  });

  it('doneWhen: a CANCEL marks the calendar event cancelled', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const requestId = await file(me, inviteMessage(me.address, uid, 'REQUEST'));
    expect((await post(me, `/api/messages/${requestId}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(200);

    const cancelId = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 1, status: 'CANCELLED' }), GENUINE);
    const view = InviteView.parse((await get(me, `/api/messages/${cancelId}/invite`)).body);
    expect(view).toMatchObject({ method: 'CANCEL', uid, cancelled: true });

    // Accept/Maybe/Decline is not offered for a CANCEL.
    expect((await post(me, `/api/messages/${cancelId}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(409);

    const removed = await post(me, `/api/messages/${cancelId}/invite/remove`);
    expect(removed.status).toBe(200);
    expect(InviteRemoveResult.parse(removed.body)).toEqual({ ok: true, removed: true });

    const calendar = await defaultCalendar(me.id);
    const [resource] = await store.getResources(calendar.id, [`${uid}.ics`]);
    const stored = parseICalendar(resource?.data ?? Buffer.alloc(0));
    const storedVevent = stored.components.find((c) => c.name === 'VEVENT') ?? { name: '', properties: [], components: [] };
    expect(getProperty(storedVevent, 'STATUS')?.value).toBe('CANCELLED');

    // Removing again is a no-op, not an error (idempotent).
    const again = await post(me, `/api/messages/${cancelId}/invite/remove`);
    expect(again.status).toBe(200);
  });

  it('a message that is not the caller’s own answers 404, never leaking whether it exists', async () => {
    const me = await person();
    const other = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const id = await file(me, inviteMessage(me.address, uid, 'REQUEST'));
    expect((await get(other, `/api/messages/${id}/invite`)).status).toBe(404);
    expect((await post(other, `/api/messages/${id}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(404);
  });

  it('a message with no calendar part answers 404', async () => {
    const me = await person();
    const raw = Buffer.from(['From: a@example.org', 'To: ' + me.address, 'Subject: hi', 'Date: Mon, 28 Sep 2026 12:00:00 +0000', `Message-ID: <${randomUUID()}@example.org>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'hello', ''].join('\r\n'));
    const id = await file(me, raw);
    expect((await get(me, `/api/messages/${id}/invite`)).status).toBe(404);
  });

  it('none of the caller’s addresses invited: respond is refused, not silently accepted', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const id = await file(me, inviteMessage('someone.else@d3cloud.io', uid, 'REQUEST'));
    const respond = await post(me, `/api/messages/${id}/invite/respond`, { partstat: 'ACCEPTED' });
    expect(respond.status).toBe(403);
    expect(respond.body).toMatchObject({ error: 'not_invited' });
  });

  // --- The verifier's refutation (PST-T-8.4 retry) ---------------------------------------------

  it('an ORGANIZER smuggling CRLF + RCPT TO is not replyable: nothing is queued, nothing reaches a header', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const poc = 'evil%40attacker.example%0d%0aRCPT%20TO:%3cvictim%40external.example%3e';
    const id = await file(me, inviteMessage(me.address, uid, 'REQUEST', { organizer: poc }));
    const view = InviteView.parse((await get(me, `/api/messages/${id}/invite`)).body);
    expect(view.organizer).toEqual({ email: null, cn: 'Priya Patel' });
    const respond = await post(me, `/api/messages/${id}/invite/respond`, { partstat: 'ACCEPTED' });
    expect(respond.status).toBe(409);
    expect(respond.body).toMatchObject({ error: 'invalid_organizer', message: 'Can’t reply: the organizer address is invalid.' });
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(0);
    expect(await db.outboundRecipient.count({ where: { address: { contains: 'victim' } } })).toBe(0);
    const calendar = await defaultCalendar(me.id);
    expect((await store.listResources(calendar.id)).filter((r) => r.name === `${uid}.ics`)).toHaveLength(0);
  });

  it('a CANCEL naming a different organizer is refused, and the event stays', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const requestId = await file(me, inviteMessage(me.address, uid, 'REQUEST'));
    expect((await post(me, `/api/messages/${requestId}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(200);
    // Authenticated for example.com, but not from the organizer of record.
    const cancelId = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 1, organizer: 'mallory@example.com' }), GENUINE);
    const removed = await post(me, `/api/messages/${cancelId}/invite/remove`);
    expect(removed.status).toBe(403);
    expect(removed.body).toMatchObject({ error: 'cancel_organizer_mismatch' });
    expect((removed.body as { message: string }).message).toMatch(/does not come from the organizer/);
    const [resource] = await store.getResources((await defaultCalendar(me.id)).id, [`${uid}.ics`]);
    const vevent = parseICalendar(resource?.data ?? Buffer.alloc(0)).components.find((c) => c.name === 'VEVENT');
    expect(vevent === undefined ? undefined : getProperty(vevent, 'STATUS')?.value).toBe('CONFIRMED');
  });

  it('a spoofed CANCEL (DMARC fail, or no verdict at all) is refused, and the event stays', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const requestId = await file(me, inviteMessage(me.address, uid, 'REQUEST'));
    expect((await post(me, `/api/messages/${requestId}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(200);
    const spoofed = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 1 }), { dmarc: 'fail', fromDomain: 'example.com' });
    const r1 = await post(me, `/api/messages/${spoofed}/invite/remove`);
    expect(r1.status).toBe(403);
    expect(r1.body).toMatchObject({ error: 'cancel_unauthenticated' });
    const unverdicted = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 1 }));
    const r2 = await post(me, `/api/messages/${unverdicted}/invite/remove`);
    expect(r2.status).toBe(403);
    expect(r2.body).toMatchObject({ error: 'cancel_unauthenticated' });
    const [resource] = await store.getResources((await defaultCalendar(me.id)).id, [`${uid}.ics`]);
    const vevent = parseICalendar(resource?.data ?? Buffer.alloc(0)).components.find((c) => c.name === 'VEVENT');
    expect(vevent === undefined ? undefined : getProperty(vevent, 'STATUS')?.value).toBe('CONFIRMED');

    // The genuine one still cancels.
    const genuine = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 1 }), GENUINE);
    const r3 = await post(me, `/api/messages/${genuine}/invite/remove`);
    expect(r3.status).toBe(200);
    expect(r3.body).toEqual({ ok: true, removed: true });
  });

  it('a CANCEL older than the stored event (lower SEQUENCE) is refused', async () => {
    const me = await person();
    const uid = `evt-${randomUUID()}@google.com`;
    const requestId = await file(me, inviteMessage(me.address, uid, 'REQUEST', { sequence: 3 }));
    expect((await post(me, `/api/messages/${requestId}/invite/respond`, { partstat: 'ACCEPTED' })).status).toBe(200);
    const stale = await file(me, inviteMessage(me.address, uid, 'CANCEL', { sequence: 2 }), GENUINE);
    const removed = await post(me, `/api/messages/${stale}/invite/remove`);
    expect(removed.status).toBe(409);
    expect(removed.body).toMatchObject({ error: 'cancel_stale' });
  });

  it('the reply is held to the composer’s recipient cap (PST-REQ-043): over it, refused 429 like a composed message', async () => {
    const capped = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, SUBMISSION_CAP_HOURLY: '1', SUBMISSION_CAP_DAILY: '1' }, config: baseConfig(clock) });
    const me = await person();
    const first = await file(me, inviteMessage(me.address, `evt-${randomUUID()}@google.com`, 'REQUEST'));
    const second = await file(me, inviteMessage(me.address, `evt-${randomUUID()}@google.com`, 'REQUEST'));
    const respond = (id: string) => request(capped).post(`/api/messages/${id}/invite/respond`).set(CSRF).set('cookie', me.cookie).send({ partstat: 'ACCEPTED' });
    expect((await respond(first)).status).toBe(200);
    const over = await respond(second);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'recipient_cap' });
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(1);
    // The composer, on the same app and the same account, is refused the same way.
    const composed = await request(capped).post('/api/compose/send').set(CSRF).set('cookie', me.cookie).send({ from: me.address, to: ['someone@example.org'], subject: 'hi', text: 'hello' });
    expect(composed.status).toBe(429);
    expect(composed.body).toMatchObject({ error: 'recipient_cap' });
  });
});
