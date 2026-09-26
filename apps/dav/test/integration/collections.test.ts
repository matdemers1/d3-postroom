// Collections and the rest of the server's contract: default Calendar + Contacts for every account
// (the migration's trigger), MKCALENDAR / extended MKCOL / PROPPATCH / DELETE, an audit row for
// every mutation (PST-REQ-009), data encrypted at rest, Depth: infinity refused, body size limits,
// and XML that tries XXE refused.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS } from '@postroom/dav-proto';
import { IOS_PROPFIND_CALENDAR_HOME, iosCard, iosEvent } from '../fixtures.js';
import { TEST_CONFIG, client, makeAccount, prop, responses, startHarness, type Account, type Client, type Harness } from './harness.js';

let h: Harness;
let account: Account;
let c: Client;
let home = '';

beforeAll(async () => {
  h = await startHarness('pst_dav_collections');
  account = await makeAccount(h);
  c = client(h.base, account);
  home = `/dav/calendars/${account.id}/`;
});
afterAll(async () => {
  await h.close();
});

describe('default collections', () => {
  it('every person account starts with Calendar and Contacts; the seeded operator too, and its seed audit says so', async () => {
    const mine = await h.db.davCollection.findMany({ where: { accountId: account.id }, orderBy: { kind: 'asc' } });
    expect(mine.map((m) => [m.kind, m.slug, m.displayName, m.components])).toEqual([
      ['calendar', 'calendar', 'Calendar', ['VEVENT', 'VTODO']],
      ['addressbook', 'contacts', 'Contacts', []],
    ]);
    const operator = await h.db.account.findFirstOrThrow({ where: { isAdmin: true } });
    expect(await h.db.davCollection.count({ where: { accountId: operator.id } })).toBe(2);
    const seedAudit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'seed', entityId: operator.id } });
    expect(JSON.stringify(seedAudit.after)).toContain('davCollections');
  });

  it('a service account gets none', async () => {
    const svc = await h.db.account.create({ data: { displayName: 'svc', kind: 'service' } });
    expect(await h.db.davCollection.count({ where: { accountId: svc.id } })).toBe(0);
  });
});

describe('MKCALENDAR, PROPPATCH, DELETE', () => {
  it('creates a calendar with the properties iOS sends, and lists it in the home', async () => {
    const id = randomUUID().toUpperCase();
    const href = `${home}${id}/`;
    const mk = await c.request('MKCALENDAR', href, {
      body: `<?xml version="1.0" encoding="UTF-8"?>
<B:mkcalendar xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:D="http://apple.com/ns/ical/">
  <A:set><A:prop>
    <A:displayname>Work</A:displayname>
    <D:calendar-color symbolic-color="custom">#FF2968FF</D:calendar-color>
    <D:calendar-order>2</D:calendar-order>
    <B:calendar-timezone><![CDATA[BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n]]></B:calendar-timezone>
    <B:supported-calendar-component-set><B:comp name="VEVENT"/></B:supported-calendar-component-set>
  </A:prop></A:set>
</B:mkcalendar>`,
    });
    expect(mk.status).toBe(201);
    const again = await c.request('MKCALENDAR', href);
    expect(again.status).toBe(403);
    expect(again.text).toContain('resource-must-be-null');

    const list = responses((await c.request('PROPFIND', home, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '1' } })).xml);
    const work = list.byHref.get(href);
    expect(prop(work, NS.DAV, 'displayname')).toBe('Work');
    expect(prop(work, NS.ICAL, 'calendar-color')).toBe('#FF2968FF');
    expect(prop(work, NS.ICAL, 'calendar-order')).toBe('2');
    // Kept as a dead property and handed back as sent.
    expect(prop(work, NS.CALDAV, 'calendar-timezone')).toContain('TZID:America/New_York');

    const patch = await c.request('PROPPATCH', href, {
      body: `<A:propertyupdate xmlns:A="DAV:" xmlns:D="http://apple.com/ns/ical/"><A:set><A:prop><A:displayname>Work (renamed)</A:displayname><D:calendar-color>#44A703FF</D:calendar-color></A:prop></A:set><A:remove><A:prop><D:calendar-order/></A:prop></A:remove></A:propertyupdate>`,
    });
    expect(patch.status).toBe(207);
    expect(responses(patch.xml).list[0]?.props.get(`{${NS.DAV}}displayname`)?.status).toBe(200);
    const after = responses((await c.request('PROPFIND', href, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '0' } })).xml).byHref.get(href);
    expect(prop(after, NS.DAV, 'displayname')).toBe('Work (renamed)');
    expect(prop(after, NS.ICAL, 'calendar-color')).toBe('#44A703FF');
    expect(after?.props.get(`{${NS.ICAL}}calendar-order`)?.status).toBe(404);

    // Atomic: a protected property fails with 403 and takes the valid update down with it (424).
    const bad = await c.request('PROPPATCH', href, {
      body: `<A:propertyupdate xmlns:A="DAV:"><A:set><A:prop><A:displayname>Nope</A:displayname><A:getetag>"x"</A:getetag></A:prop></A:set></A:propertyupdate>`,
    });
    const view = responses(bad.xml).list[0];
    expect(view?.props.get(`{${NS.DAV}}getetag`)?.status).toBe(403);
    expect(view?.props.get(`{${NS.DAV}}displayname`)?.status).toBe(424);
    expect(bad.text).toContain('cannot-modify-protected-property');
    expect(prop(responses((await c.request('PROPFIND', href, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '0' } })).xml).byHref.get(href), NS.DAV, 'displayname')).toBe('Work (renamed)');

    // An event in it, then the calendar goes, and everything in it with it.
    const ev = randomUUID();
    expect((await c.request('PUT', `${href}${ev}.ics`, { body: iosEvent(ev, 'Review'), headers: { 'Content-Type': 'text/calendar' } })).status).toBe(201);
    expect((await c.request('DELETE', href)).status).toBe(204);
    expect((await c.request('PROPFIND', href, { body: IOS_PROPFIND_CALENDAR_HOME, headers: { Depth: '0' } })).status).toBe(404);
    expect(await h.db.davResource.count({ where: { uid: ev } })).toBe(0);
  });

  it('creates an address book with extended MKCOL, and refuses plain collections and the wrong home', async () => {
    const books = `/dav/addressbooks/${account.id}/`;
    const mkcol = (kind: string): string =>
      `<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:K="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:resourcetype><D:collection/>${kind}</D:resourcetype><D:displayname>Work contacts</D:displayname></D:prop></D:set></D:mkcol>`;
    expect((await c.request('MKCOL', `${books}work/`, { body: mkcol('<C:addressbook/>') })).status).toBe(201);
    expect((await c.request('MKCOL', `${books}work/`, { body: mkcol('<C:addressbook/>') })).status).toBe(405);
    expect((await c.request('MKCOL', `${books}plain/`)).status).toBe(403);
    expect((await c.request('MKCOL', `${books}cal/`, { body: mkcol('<K:calendar/>') })).status).toBe(403);
    expect((await c.request('MKCALENDAR', `${books}cal2/`)).status).toBe(403);
    const id = randomUUID();
    expect((await c.request('PUT', `${books}work/${id}.vcf`, { body: iosCard(id, 'Rosalind', 'Franklin', 'rf@example.com'), headers: { 'Content-Type': 'text/vcard' } })).status).toBe(201);
  });

  it('refuses to delete a home or a principal, and to PUT a collection', async () => {
    expect((await c.request('DELETE', home)).status).toBe(403);
    expect((await c.request('DELETE', `/dav/principals/${account.id}/`)).status).toBe(403);
    expect((await c.request('PUT', `${home}calendar/`, { body: 'x', headers: { 'Content-Type': 'text/calendar' } })).status).toBe(405);
  });

  it('caps the collections per account', async () => {
    const a = await makeAccount(h);
    const cc = client(h.base, a);
    const statuses: number[] = [];
    for (let i = 0; i < TEST_CONFIG.maxCollectionsPerAccount; i++) statuses.push((await cc.request('MKCALENDAR', `/dav/calendars/${a.id}/c${String(i)}/`)).status);
    // Two defaults already exist, so the cap is reached two early.
    expect(statuses.filter((s) => s === 201)).toHaveLength(TEST_CONFIG.maxCollectionsPerAccount - 2);
    expect(statuses.slice(-2)).toEqual([507, 507]);
  });
});

describe('every mutation is audited', () => {
  it('writes one audit row per create, update and delete, naming the actor and never the data', async () => {
    const a = await makeAccount(h);
    const cc = client(h.base, a);
    const cal = `/dav/calendars/${a.id}/calendar/`;
    const id = randomUUID();
    const put = await cc.request('PUT', `${cal}${id}.ics`, { body: iosEvent(id, 'Secret meeting'), headers: { 'Content-Type': 'text/calendar' } });
    const edit = await cc.request('PUT', `${cal}${id}.ics`, { body: iosEvent(id, 'Secret meeting 2'), headers: { 'Content-Type': 'text/calendar', 'If-Match': put.headers.get('etag') ?? '' } });
    await cc.request('DELETE', `${cal}${id}.ics`, { headers: { 'If-Match': edit.headers.get('etag') ?? '' } });
    await cc.request('MKCALENDAR', `/dav/calendars/${a.id}/extra/`);
    await cc.request('PROPPATCH', `/dav/calendars/${a.id}/extra/`, { body: '<A:propertyupdate xmlns:A="DAV:"><A:set><A:prop><A:displayname>Extra</A:displayname></A:prop></A:set></A:propertyupdate>' });
    await cc.request('DELETE', `/dav/calendars/${a.id}/extra/`);
    const rows = await h.db.auditEvent.findMany({ where: { actorAccountId: a.id, action: { startsWith: 'dav.' } }, orderBy: { at: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['dav.resource.create', 'dav.resource.update', 'dav.resource.delete', 'dav.collection.create', 'dav.collection.update', 'dav.collection.delete']);
    expect(rows.every((r) => r.actorKind === 'account' && r.ip === '203.0.113.7' && r.requestId !== null && (r.userAgent ?? '').startsWith('iOS/'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Secret meeting');
    // A refused write changes nothing and writes nothing.
    const before = await h.db.auditEvent.count({ where: { actorAccountId: a.id } });
    await cc.request('PUT', `${cal}x.ics`, { body: 'nope', headers: { 'Content-Type': 'text/calendar' } });
    expect(await h.db.auditEvent.count({ where: { actorAccountId: a.id } })).toBe(before);
  });
});

describe('at rest', () => {
  it('stores calendar data encrypted under a per-resource key, and a copied ciphertext does not decrypt', async () => {
    const cal = `${home}calendar/`;
    const a = randomUUID();
    const b = randomUUID();
    await c.request('PUT', `${cal}${a}.ics`, { body: iosEvent(a, 'Confidential appointment'), headers: { 'Content-Type': 'text/calendar' } });
    await c.request('PUT', `${cal}${b}.ics`, { body: iosEvent(b, 'Other'), headers: { 'Content-Type': 'text/calendar' } });
    const rowA = await h.db.davResource.findFirstOrThrow({ where: { uid: a } });
    const rowB = await h.db.davResource.findFirstOrThrow({ where: { uid: b } });
    expect(Buffer.from(rowA.data).includes(Buffer.from('Confidential'))).toBe(false);
    expect(Buffer.from(rowA.data).includes(Buffer.from('BEGIN:VCALENDAR'))).toBe(false);
    expect(Buffer.from(rowA.wrappedDek).equals(Buffer.from(rowB.wrappedDek))).toBe(false);
    // Move A's ciphertext onto B's row: the AAD binds it to A's id, so B no longer opens.
    await h.db.davResource.update({ where: { id: rowB.id }, data: { data: rowA.data, wrappedDek: rowA.wrappedDek } });
    expect((await c.request('GET', `${cal}${b}.ics`)).status).toBe(500);
    expect(h.logs.some((l) => l.event === 'request-error')).toBe(true);
    await h.db.davResource.delete({ where: { id: rowB.id } });
  });
});

describe('limits and hostile bodies', () => {
  it('refuses PROPFIND Depth: infinity (and a missing Depth) with propfind-finite-depth', async () => {
    for (const headers of [{ Depth: 'infinity' }, {}]) {
      const r = await c.request('PROPFIND', home, { body: IOS_PROPFIND_CALENDAR_HOME, headers });
      expect(r.status).toBe(403);
      expect(r.xml?.children[0]).toMatchObject({ ns: NS.DAV, local: 'propfind-finite-depth' });
    }
  });

  it('refuses an oversized XML body (413) and an oversized resource (max-resource-size)', async () => {
    const big = `<A:propfind xmlns:A="DAV:"><A:prop>${'<A:displayname/>'.repeat(10_000)}</A:prop></A:propfind>`;
    expect((await c.request('PROPFIND', home, { body: big, headers: { Depth: '0' } })).status).toBe(413);
    const id = randomUUID();
    const huge = iosEvent(id, 'x'.repeat(TEST_CONFIG.maxResourceBytes));
    const r = await c.request('PUT', `${home}calendar/${id}.ics`, { body: huge, headers: { 'Content-Type': 'text/calendar' } });
    expect(r.status).toBe(403);
    expect(r.text).toContain('max-resource-size');
    // The limit holds for a chunked body with no Content-Length too.
    const chunked = await fetch(`${h.base}${home}calendar/${id}.ics`, {
      method: 'PUT',
      headers: { 'X-Forwarded-Proto': 'https', Authorization: `Basic ${Buffer.from(`${account.address}:${account.appPassword}`).toString('base64')}`, 'Content-Type': 'text/calendar' },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 40; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    expect(chunked.status).toBe(403);
    expect(await h.db.davResource.count({ where: { uid: id } })).toBe(0);
  });

  it('refuses XXE and billion laughs as malformed XML, and compressed bodies', async () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><A:propfind xmlns:A="DAV:"><A:prop><A:displayname>&x;</A:displayname></A:prop></A:propfind>';
    const r = await c.request('PROPFIND', home, { body: xxe, headers: { Depth: '0' } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('root:');
    const lol = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><A:propfind xmlns:A="DAV:"><A:prop>&b;</A:prop></A:propfind>';
    expect((await c.request('PROPFIND', home, { body: lol, headers: { Depth: '0' } })).status).toBe(400);
    expect((await c.request('REPORT', `${home}calendar/`, { body: '<x/>', headers: { 'Content-Encoding': 'gzip', Depth: '1' } })).status).toBe(415);
    expect((await c.request('REPORT', `${home}calendar/`, { body: '<D:expand-property xmlns:D="DAV:"/>', headers: { Depth: '0' } })).text).toContain('supported-report');
  });
});
