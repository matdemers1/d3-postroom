// PST-REQ-132 — iOS Calendar's actual request sequence, replayed: well-known → PROPFIND principal →
// calendar-home-set → PROPFIND home Depth 1 → sync-collection → PUT a new event (If-None-Match: *)
// → multiget → edit (If-Match) → DELETE → incremental sync shows the tombstone. Create, edit and
// delete from "the other side" (another client) show up in the phone's next incremental sync.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS } from '@postroom/dav-proto';
import {
  IOS_PROPFIND_CALDAV_PRINCIPAL,
  IOS_PROPFIND_CALENDAR_HOME,
  IOS_PROPFIND_PRINCIPAL,
  iosEvent,
  iosSyncCollection,
  macosCalendarMultiget,
} from '../fixtures.js';
import { client, makeAccount, prop, propHrefs, responses, startHarness, type Account, type Client, type Harness } from './harness.js';

let h: Harness;
let account: Account;
let phone: Client;
let mac: Client;

beforeAll(async () => {
  h = await startHarness('pst_dav_ios_cal');
  account = await makeAccount(h);
  phone = client(h.base, account);
  mac = client(h.base, account, { 'User-Agent': 'macOS/26.0 (25A354) CalendarAgent/1000' });
});
afterAll(async () => {
  await h.close();
});

describe('iOS Calendar, end to end', () => {
  const uid = randomUUID().toUpperCase();
  let calendarHref = '';
  let eventHref = '';
  let token0 = '';
  let etag1 = '';

  it('discovers the principal and the calendar home', async () => {
    const wk = await phone.request('PROPFIND', '/.well-known/caldav', { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' }, auth: false });
    expect(wk.status).toBe(301);
    expect(wk.headers.get('location')).toBe('/dav/');

    const unauth = await phone.request('PROPFIND', '/dav/', { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' }, auth: false });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toMatch(/^Basic realm="Postroom"/);

    const root = await phone.request('PROPFIND', '/dav/', { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' } });
    expect(root.status).toBe(207);
    const principal = propHrefs(responses(root.xml).byHref.get('/dav/'), NS.DAV, 'current-user-principal')[0];
    expect(principal).toBe(`/dav/principals/${account.id}/`);

    const options = await phone.request('OPTIONS', principal ?? '');
    expect(options.headers.get('dav')).toContain('calendar-access');
    expect(options.headers.get('allow')).toContain('REPORT');

    const p = await phone.request('PROPFIND', principal ?? '', { body: IOS_PROPFIND_CALDAV_PRINCIPAL, headers: { Depth: '0' } });
    const view = responses(p.xml).byHref.get(principal ?? '');
    expect(propHrefs(view, NS.CALDAV, 'calendar-home-set')).toEqual([`/dav/calendars/${account.id}/`]);
    expect(propHrefs(view, NS.CALDAV, 'calendar-user-address-set')).toContain(`mailto:${account.address}`);
    expect(prop(view, NS.DAV, 'displayname')).toMatch(/^User /);
    // Asked for, not implemented: 404 in its own propstat, never an error.
    expect(view?.props.get(`{${NS.CALDAV}}schedule-inbox-URL`)?.status).toBe(404);
  });

  it('lists the default calendar in the home with getctag, sync-token and components', async () => {
    const home = `/dav/calendars/${account.id}/`;
    const r = await phone.request('PROPFIND', home, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '1' } });
    expect(r.status).toBe(207);
    const { list } = responses(r.xml);
    expect(list.map((v) => v.href)).toEqual([home, `${home}calendar/`]);
    const cal = list[1];
    calendarHref = cal?.href ?? '';
    expect(cal?.props.get(`{${NS.DAV}}resourcetype`)?.el.children.map((c) => (typeof c === 'string' ? c : c.local))).toEqual(['collection', 'calendar']);
    expect(prop(cal, NS.DAV, 'displayname')).toBe('Calendar');
    expect(prop(cal, NS.CS, 'getctag')).toMatch(/^http:\/\/postroom\.d3cloud\.io\/ns\/sync\//);
    expect(prop(cal, NS.DAV, 'sync-token')).toBe(prop(cal, NS.CS, 'getctag'));
    const comps = cal?.props.get(`{${NS.CALDAV}}supported-calendar-component-set`)?.el;
    expect(comps?.children.map((c) => (typeof c === 'string' ? '' : c.attrs[0]?.value))).toEqual(['VEVENT', 'VTODO']);
    const privs = cal?.props.get(`{${NS.DAV}}current-user-privilege-set`)?.el;
    expect(JSON.stringify(privs)).toContain('"write-content"');
    expect(cal?.props.get(`{http://me.com/_namespace/}bulk-requests`)?.status).toBe(404);
  });

  it('syncs an empty calendar, then creates an event with If-None-Match: *', async () => {
    const initial = await phone.request('REPORT', calendarHref, { body: iosSyncCollection(''), headers: { Depth: '1' } });
    expect(initial.status).toBe(207);
    const first = responses(initial.xml);
    expect(first.list).toEqual([]);
    token0 = first.syncToken ?? '';
    expect(token0).not.toBe('');

    eventHref = `${calendarHref}${uid}.ics`;
    const body = iosEvent(uid, 'Dentist');
    const put = await phone.request('PUT', eventHref, { body, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' } });
    expect(put.status).toBe(201);
    etag1 = put.headers.get('etag') ?? '';
    expect(etag1).toMatch(/^"[A-Za-z0-9_-]+"$/);

    // The same create again must not overwrite: the resource exists now.
    const again = await phone.request('PUT', eventHref, { body, headers: { 'Content-Type': 'text/calendar', 'If-None-Match': '*' } });
    expect(again.status).toBe(412);
  });

  it('shows the new event to the other device in an incremental sync, and multiget returns the exact bytes', async () => {
    const sync = await mac.request('REPORT', calendarHref, { body: iosSyncCollection(token0), headers: { Depth: '1' } });
    const view = responses(sync.xml);
    expect(view.list.map((v) => v.href)).toEqual([eventHref]);
    expect(prop(view.list[0], NS.DAV, 'getetag')).toBe(etag1);
    expect(prop(view.list[0], NS.DAV, 'getcontenttype')).toBe('text/calendar; charset=utf-8; component=vevent');
    expect(view.syncToken).not.toBe(token0);

    const mg = await mac.request('REPORT', calendarHref, { body: macosCalendarMultiget([eventHref]), headers: { Depth: '1' } });
    const got = responses(mg.xml).byHref.get(eventHref);
    expect(prop(got, NS.CALDAV, 'calendar-data')).toBe(iosEvent(uid, 'Dentist'));

    const get = await phone.request('GET', eventHref);
    expect(get.status).toBe(200);
    expect(get.text).toBe(iosEvent(uid, 'Dentist'));
    expect(get.headers.get('etag')).toBe(etag1);
    expect(get.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect((await phone.request('GET', eventHref, { headers: { 'If-None-Match': etag1 } })).status).toBe(304);
  });

  it('edits with If-Match, refuses a stale ETag with 412, and deletes', async () => {
    const before = responses((await phone.request('REPORT', calendarHref, { body: iosSyncCollection(''), headers: { Depth: '1' } })).xml).syncToken ?? '';

    // Edited on the Mac.
    const edit = await mac.request('PUT', eventHref, { body: iosEvent(uid, 'Dentist (moved)', { start: '20261002T090000', end: '20261002T100000', sequence: 1 }), headers: { 'Content-Type': 'text/calendar', 'If-Match': etag1 } });
    expect(edit.status).toBe(204);
    const etag2 = edit.headers.get('etag') ?? '';
    expect(etag2).not.toBe(etag1);

    // The phone, still holding the old ETag, loses the race rather than clobbering the edit.
    const stale = await phone.request('PUT', eventHref, { body: iosEvent(uid, 'Dentist (phone)'), headers: { 'Content-Type': 'text/calendar', 'If-Match': etag1 } });
    expect(stale.status).toBe(412);
    expect((await phone.request('DELETE', eventHref, { headers: { 'If-Match': etag1 } })).status).toBe(412);

    // The phone's next incremental sync shows the modification with its new ETag.
    const sync = responses((await phone.request('REPORT', calendarHref, { body: iosSyncCollection(before), headers: { Depth: '1' } })).xml);
    expect(sync.list.map((v) => [v.href, prop(v, NS.DAV, 'getetag')])).toEqual([[eventHref, etag2]]);
    const afterEdit = sync.syncToken ?? '';

    // Deleted on the phone, with the current ETag.
    expect((await phone.request('DELETE', eventHref, { headers: { 'If-Match': etag2 } })).status).toBe(204);
    expect((await phone.request('GET', eventHref)).status).toBe(404);
    expect((await phone.request('DELETE', eventHref)).status).toBe(404);

    // The Mac's incremental sync shows the tombstone: a response with a bare 404 status.
    const tomb = responses((await mac.request('REPORT', calendarHref, { body: iosSyncCollection(afterEdit), headers: { Depth: '1' } })).xml);
    expect(tomb.list).toHaveLength(1);
    expect(tomb.list[0]?.href).toBe(eventHref);
    expect(tomb.list[0]?.status).toBe(404);
    expect(tomb.list[0]?.props.size).toBe(0);

    // From the token that included the delete there is nothing left to report.
    const quiet = responses((await mac.request('REPORT', calendarHref, { body: iosSyncCollection(tomb.syncToken ?? ''), headers: { Depth: '1' } })).xml);
    expect(quiet.list).toEqual([]);
    expect(quiet.syncToken).toBe(tomb.syncToken);

    // From the very first token, create + edit + delete collapse into the one tombstone.
    const full = responses((await mac.request('REPORT', calendarHref, { body: iosSyncCollection(token0), headers: { Depth: '1' } })).xml);
    expect(full.list.map((v) => [v.href, v.status])).toEqual([[eventHref, 404]]);
  });

  it('refuses a sync token that is not valid for this collection', async () => {
    const bad = await phone.request('REPORT', calendarHref, { body: iosSyncCollection('http://postroom.d3cloud.io/ns/sync/not-a-token'), headers: { Depth: '1' } });
    expect(bad.status).toBe(403);
    expect(bad.text).toContain('valid-sync-token');
    const current = responses((await phone.request('REPORT', calendarHref, { body: iosSyncCollection(''), headers: { Depth: '1' } })).xml).syncToken ?? '';
    const future = current.replace(/\/(\d+)$/, (_, n: string) => `/${String(Number(n) + 5)}`);
    expect((await phone.request('REPORT', calendarHref, { body: iosSyncCollection(future), headers: { Depth: '1' } })).status).toBe(403);
    const other = await makeAccount(h);
    const otherCal = `/dav/calendars/${other.id}/calendar/`;
    const otherToken = responses((await client(h.base, other).request('REPORT', otherCal, { body: iosSyncCollection(''), headers: { Depth: '1' } })).xml).syncToken ?? '';
    expect((await phone.request('REPORT', calendarHref, { body: iosSyncCollection(otherToken), headers: { Depth: '1' } })).status).toBe(403);
  });

  it('changes getctag with every member change', async () => {
    const ctag = async (): Promise<string | undefined> =>
      prop(responses((await phone.request('PROPFIND', calendarHref, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '0' } })).xml).byHref.get(calendarHref), NS.CS, 'getctag');
    const a = await ctag();
    const id = randomUUID();
    expect((await phone.request('PUT', `${calendarHref}${id}.ics`, { body: iosEvent(id, 'Lunch'), headers: { 'Content-Type': 'text/calendar', 'If-None-Match': '*' } })).status).toBe(201);
    const b = await ctag();
    expect(b).not.toBe(a);
    expect(await ctag()).toBe(b);
  });
});
