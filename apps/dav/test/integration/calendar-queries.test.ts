// PST-REQ-132 — REPORTs beyond sync: macOS Calendar's calendar-multiget across several hrefs, and
// calendar-query time ranges against a recurring event (RRULE + EXDATE, in a zone with DST), a
// one-off, and a to-do. Plus the CalDAV preconditions a PUT can fail.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS } from '@postroom/dav-proto';
import { calendarQuery, iosEvent, macosCalendarMultiget, vtodo } from '../fixtures.js';
import { client, makeAccount, prop, responses, startHarness, type Account, type Client, type Harness } from './harness.js';

let h: Harness;
let account: Account;
let mac: Client;
let cal = '';
const ics = { 'Content-Type': 'text/calendar; charset=utf-8' };

const standup = randomUUID();
const dentist = randomUUID();
const todo = randomUUID();

beforeAll(async () => {
  h = await startHarness('pst_dav_queries');
  account = await makeAccount(h);
  mac = client(h.base, account, { 'User-Agent': 'macOS/26.0 (25A354) CalendarAgent/1000' });
  cal = `/dav/calendars/${account.id}/calendar/`;
  // Every Monday 09:00 New York from 2 March 2026, except 16 March.
  const weekly = iosEvent(standup, 'Standup', { start: '20260302T090000', end: '20260302T093000', rrule: 'FREQ=WEEKLY;BYDAY=MO', exdate: '20260316T090000' });
  expect((await mac.request('PUT', `${cal}${standup}.ics`, { body: weekly, headers: ics })).status).toBe(201);
  expect((await mac.request('PUT', `${cal}${dentist}.ics`, { body: iosEvent(dentist, 'Dentist', { start: '20260505T140000', end: '20260505T150000' }), headers: ics })).status).toBe(201);
  expect((await mac.request('PUT', `${cal}${todo}.ics`, { body: vtodo(todo), headers: ics })).status).toBe(201);
});
afterAll(async () => {
  await h.close();
});

async function query(start: string, end: string): Promise<string[]> {
  const r = await mac.request('REPORT', cal, { body: calendarQuery(start, end), headers: { Depth: '1' } });
  expect(r.status).toBe(207);
  return responses(r.xml)
    .list.map((v) => v.href.slice(cal.length).replace(/\.ics$/, ''))
    .sort();
}

describe('calendar-multiget (macOS Calendar)', () => {
  it('returns every requested object with its data, and 404 for what is not there or not in this calendar', async () => {
    const other = await makeAccount(h);
    const hrefs = [`${cal}${standup}.ics`, `${cal}${dentist}.ics`, `${cal}nope.ics`, `/dav/calendars/${other.id}/calendar/x.ics`, `https://dav.d3cloud.io${cal}${todo}.ics`];
    const r = responses((await mac.request('REPORT', cal, { body: macosCalendarMultiget(hrefs), headers: { Depth: '1' } })).xml);
    expect(r.list.map((v) => v.href)).toEqual(hrefs);
    expect(prop(r.byHref.get(hrefs[0] ?? ''), NS.CALDAV, 'calendar-data')).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(prop(r.byHref.get(hrefs[1] ?? ''), NS.CALDAV, 'calendar-data')).toContain('SUMMARY:Dentist');
    expect(r.byHref.get(hrefs[2] ?? '')?.status).toBe(404);
    expect(r.byHref.get(hrefs[3] ?? '')?.status).toBe(404);
    expect(prop(r.byHref.get(hrefs[4] ?? ''), NS.CALDAV, 'calendar-data')).toContain('BEGIN:VTODO');
    expect(prop(r.byHref.get(hrefs[4] ?? ''), NS.DAV, 'getcontenttype')).toBe('text/calendar; charset=utf-8; component=vtodo');
  });
});

describe('calendar-query with a time range', () => {
  it('matches a recurring event by any instance in range', async () => {
    // Monday 23 March 2026, 13:00–14:00 UTC is 09:00–10:00 EDT: the standup's instance.
    expect(await query('20260323T130000Z', '20260323T140000Z')).toEqual([standup]);
    // Late June, far from DTSTART: still an instance every Monday.
    expect(await query('20260622T000000Z', '20260623T000000Z')).toEqual([standup]);
  });

  it('honours EXDATE, DTSTART and the instance times', async () => {
    // 16 March is excluded; 9 March is the week before (EST→EDT on the 8th: 09:00 EDT = 13:00Z).
    expect(await query('20260316T000000Z', '20260317T000000Z')).toEqual([]);
    expect(await query('20260309T130000Z', '20260309T133000Z')).toEqual([standup]);
    // Before the first instance, and between instances on a Monday.
    expect(await query('20260201T000000Z', '20260302T000000Z')).toEqual([]);
    expect(await query('20260323T150000Z', '20260323T160000Z')).toEqual([]);
  });

  it('matches one-off events and leaves to-dos out of a VEVENT filter', async () => {
    expect(await query('20260505T180000Z', '20260505T183000Z')).toEqual([dentist]);
    expect(await query('20260501T000000Z', '20260601T000000Z')).toEqual([dentist, standup].sort());
    // Thursday to Saturday: no Monday, and the to-do (no DTSTART) is not a VEVENT.
    expect(await query('20261001T000000Z', '20261003T000000Z')).toEqual([]);
  });

  it('filters VTODO by DUE and by is-not-defined', async () => {
    const body = (inner: string): string =>
      `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR">${inner}</C:comp-filter></C:filter></C:calendar-query>`;
    const hrefs = async (inner: string): Promise<string[]> =>
      responses((await mac.request('REPORT', cal, { body: body(inner), headers: { Depth: '1' } })).xml)
        .list.map((v) => v.href.slice(cal.length).replace(/\.ics$/, ''))
        .sort();
    expect(await hrefs('<C:comp-filter name="VTODO"><C:time-range start="20261001T000000Z" end="20261003T000000Z"/></C:comp-filter>')).toEqual([todo]);
    expect(await hrefs('<C:comp-filter name="VTODO"><C:time-range start="20261101T000000Z" end="20261103T000000Z"/></C:comp-filter>')).toEqual([]);
    expect(await hrefs('<C:comp-filter name="VEVENT"><C:is-not-defined/></C:comp-filter>')).toEqual([todo]);
    expect(await hrefs('<C:comp-filter name="VEVENT"><C:prop-filter name="SUMMARY"><C:text-match>STAND</C:text-match></C:prop-filter></C:comp-filter>')).toEqual([standup]);
    expect(await hrefs('<C:comp-filter name="VEVENT"><C:prop-filter name="RRULE"><C:is-not-defined/></C:prop-filter></C:comp-filter>')).toEqual([dentist]);
  });

  it('refuses invalid filters with CALDAV:valid-filter', async () => {
    const bad = await mac.request('REPORT', cal, { body: calendarQuery('2026-03-01', '20260401T000000Z'), headers: { Depth: '1' } });
    expect(bad.status).toBe(403);
    expect(bad.text).toContain('valid-filter');
  });
});

describe('PUT preconditions', () => {
  it('refuses a UID that already lives at another href (no-uid-conflict)', async () => {
    const r = await mac.request('PUT', `${cal}copy.ics`, { body: iosEvent(dentist, 'Copy'), headers: ics });
    expect(r.status).toBe(403);
    expect(r.xml?.children[0]).toMatchObject({ ns: NS.CALDAV, local: 'no-uid-conflict' });
    expect(r.text).toContain(`${cal}${dentist}.ics`);
  });

  it('refuses a component the calendar does not support, METHOD, mixed UIDs and non-iCalendar', async () => {
    const mk = await mac.request('MKCALENDAR', `/dav/calendars/${account.id}/events-only/`, {
      body: '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Events</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>',
    });
    expect(mk.status).toBe(201);
    const id = randomUUID();
    const t = await mac.request('PUT', `/dav/calendars/${account.id}/events-only/${id}.ics`, { body: vtodo(id), headers: ics });
    expect(t.status).toBe(403);
    expect(t.text).toContain('supported-calendar-component');

    const withMethod = iosEvent(id, 'Invite').replace('CALSCALE:GREGORIAN', 'METHOD:REQUEST');
    expect((await mac.request('PUT', `${cal}m.ics`, { body: withMethod, headers: ics })).text).toContain('valid-calendar-object-resource');
    const twoUids = iosEvent(id, 'A').replace('END:VCALENDAR\r\n', `BEGIN:VEVENT\r\nUID:other\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    expect((await mac.request('PUT', `${cal}u.ics`, { body: twoUids, headers: ics })).text).toContain('valid-calendar-object-resource');
    expect((await mac.request('PUT', `${cal}junk.ics`, { body: 'not a calendar', headers: ics })).text).toContain('valid-calendar-data');
    expect((await mac.request('PUT', `${cal}x.ics`, { body: iosEvent(id, 'A'), headers: { 'Content-Type': 'text/plain' } })).text).toContain('supported-calendar-data');
    expect((await mac.request('PUT', `/dav/calendars/${account.id}/no-such/x.ics`, { body: iosEvent(id, 'A'), headers: ics })).status).toBe(409);
  });
});
