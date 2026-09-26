// The daemon's pure pieces: configuration, Basic parsing, routing, property updates, filters and
// PUT validation.
import { describe, expect, it } from 'vitest';
import { DavRequestError, NS, el, parseReport, parseXml, type CompFilter } from '@postroom/dav-proto';
import { parseICalendar } from '@postroom/ical';
import { parseVCard } from '@postroom/vcard';
import { parseBasicAuth } from '../../src/auth.js';
import { DEFAULT_TRUSTED_PROXIES, loadConfig, trustedProxyList } from '../../src/config.js';
import { calendarMatches, cardMatches } from '../../src/filters.js';
import { route } from '../../src/paths.js';
import { applyUpdates } from '../../src/proppatch.js';
import { parseSyncToken, syncToken } from '../../src/props.js';
import { validateCalendarObject, validateVCard } from '../../src/validate.js';
import { iosCard, iosEvent } from '../fixtures.js';

function condition(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof DavRequestError) return err.condition ?? String(err.status);
    throw err;
  }
  return 'ok';
}

describe('config', () => {
  it('has safe defaults: port 8008, HTTPS required, private-range proxies', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8008);
    expect(c.requireHttps).toBe(true);
    expect(c.trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES);
    expect(loadConfig({ DAV_REQUIRE_HTTPS: 'false' }).requireHttps).toBe(false);
    expect(() => loadConfig({ DAV_TRUSTED_PROXIES: 'cloudflared' })).toThrow(/DAV_TRUSTED_PROXIES/);
  });

  it('matches trusted proxies by address and CIDR, IPv4-mapped included', () => {
    const t = trustedProxyList(['172.16.0.0/12', '::1/128', '10.1.2.3']);
    expect(t('172.18.0.5')).toBe(true);
    expect(t('::ffff:172.18.0.5')).toBe(true);
    expect(t('::1')).toBe(true);
    expect(t('10.1.2.3')).toBe(true);
    expect(t('10.1.2.4')).toBe(false);
    expect(t('203.0.113.1')).toBe(false);
    expect(t('not-an-ip')).toBe(false);
  });
});

describe('Basic auth', () => {
  it('decodes UTF-8 credentials and splits at the first colon', () => {
    const h = `Basic ${Buffer.from('ada@d3cloud.io:ab:cd é').toString('base64')}`;
    expect(parseBasicAuth(h)).toEqual({ username: 'ada@d3cloud.io', password: 'ab:cd é' });
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer x')).toBeNull();
    expect(parseBasicAuth('Basic !!!')).toBe('malformed');
    expect(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBe('malformed');
    expect(parseBasicAuth(`Basic ${Buffer.from([0x61, 0x3a, 0xff]).toString('base64')}`)).toBe('malformed');
    expect(parseBasicAuth(`Basic ${Buffer.from('a:b\u0000c').toString('base64')}`)).toBe('malformed');
  });
});

describe('routing', () => {
  it('maps the URL space', () => {
    expect(route([])).toEqual({ type: 'dav', accountId: null, target: { type: 'root' } });
    expect(route(['.well-known', 'caldav'])).toEqual({ type: 'well-known' });
    expect(route(['dav', 'principals', 'a'])).toEqual({ type: 'dav', accountId: 'a', target: { type: 'principal' } });
    expect(route(['dav', 'calendars', 'a', 'work', 'x.ics'])).toEqual({ type: 'dav', accountId: 'a', target: { type: 'object', kind: 'calendar', slug: 'work', name: 'x.ics' } });
    expect(route(['dav', 'addressbooks', 'a'])).toEqual({ type: 'dav', accountId: 'a', target: { type: 'home', kind: 'addressbook' } });
    expect(route(['dav', 'calendars', 'a', 'w', 'x', 'deeper']).type).toBe('not-found');
    expect(route(['elsewhere']).type).toBe('not-found');
  });

  it('round-trips sync tokens and refuses anything else', () => {
    const id = '3060806c-3438-4774-85e0-30a7a87371b6';
    expect(parseSyncToken(syncToken(id, 42n))).toEqual({ collectionId: id, seq: 42n });
    expect(parseSyncToken('http://postroom.d3cloud.io/ns/sync/x/1')).toBeNull();
    expect(parseSyncToken(`${syncToken(id, 1n)}0000000000000000000000`)).toBeNull();
  });
});

describe('property updates', () => {
  const base = { displayName: 'Calendar', description: null, color: null, sortOrder: null, components: ['VEVENT', 'VTODO'], deadProps: {} };
  const set = (e: ReturnType<typeof el>): { action: 'set'; prop: ReturnType<typeof el> } => ({ action: 'set', prop: e });

  it('validates colour and order, and keeps unknown properties as dead ones', () => {
    const ok = applyUpdates(base, [set(el(NS.ICAL, 'calendar-color', ['#112233'])), set(el(NS.ICAL, 'calendar-order', ['-3'])), set(el('urn:x', 'mine', ['v']))], 'calendar', false, 'Calendar');
    expect(ok.ok).toBe(true);
    expect(ok.fields).toMatchObject({ color: '#112233', sortOrder: -3 });
    expect(Object.keys(ok.fields.deadProps)).toEqual(['{urn:x}mine']);
    const bad = applyUpdates(base, [set(el(NS.ICAL, 'calendar-color', ['red'])), set(el(NS.DAV, 'displayname', ['X']))], 'calendar', false, 'Calendar');
    expect(bad.ok).toBe(false);
    expect(bad.outcomes.map((o) => o.status)).toEqual([409, 424]);
    expect(bad.fields).toBe(base);
  });

  it('allows supported-calendar-component-set only at creation, and only real components', () => {
    const comps = (...names: string[]) => set(el(NS.CALDAV, 'supported-calendar-component-set', names.map((n) => el(NS.CALDAV, 'comp', [], [{ ns: '', local: 'name', value: n }]))));
    expect(applyUpdates(base, [comps('VEVENT')], 'calendar', true, 'x').fields.components).toEqual(['VEVENT']);
    expect(applyUpdates(base, [comps('VEVENT')], 'calendar', false, 'x').outcomes[0]?.condition).toBe(`{DAV:}cannot-modify-protected-property`);
    expect(applyUpdates(base, [comps('VFREEBUSY')], 'calendar', true, 'x').ok).toBe(false);
  });

  it('bounds dead properties', () => {
    const many = Array.from({ length: 33 }, (_, i) => set(el('urn:x', `p${String(i)}`, ['v'])));
    expect(applyUpdates(base, many, 'calendar', false, 'x').outcomes.some((o) => o.status === 507)).toBe(true);
    expect(applyUpdates(base, [set(el('urn:x', 'big', ['x'.repeat(20_000)]))], 'calendar', false, 'x').outcomes[0]?.status).toBe(507);
  });
});

describe('filters', () => {
  const filterOf = (xml: string): CompFilter => {
    const r = parseReport(parseXml(`<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>${xml}</C:filter></C:calendar-query>`));
    if (r.kind !== 'calendar-query') throw new Error(r.kind);
    return r.filter;
  };
  const cal = parseICalendar(iosEvent('u1', 'Planning', { start: '20260105T090000', end: '20260105T100000', rrule: 'FREQ=DAILY;COUNT=5' }));

  it('matches time ranges through recurrence and a zone', () => {
    // 9 January 09:00 EST = 14:00Z is the fifth and last instance.
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260109T140000Z" end="20260109T141500Z"/></C:comp-filter></C:comp-filter>'))).toBe(true);
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260110T140000Z" end="20260110T141500Z"/></C:comp-filter></C:comp-filter>'))).toBe(false);
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260109T000000Z"/></C:comp-filter></C:comp-filter>'))).toBe(true);
  });

  it('matches properties, parameters and nested components', () => {
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:comp-filter name="VALARM"><C:prop-filter name="ACTION"><C:text-match>display</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:comp-filter>'))).toBe(true);
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="DTSTART"><C:param-filter name="TZID"><C:text-match collation="i;octet">America/New_York</C:text-match></C:param-filter></C:prop-filter></C:comp-filter></C:comp-filter>'))).toBe(true);
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="DTSTART"><C:time-range start="20260105T140000Z" end="20260105T140001Z"/></C:prop-filter></C:comp-filter></C:comp-filter>'))).toBe(true);
    expect(calendarMatches(cal, filterOf('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter>'))).toBe(false);
  });

  it('matches cards by anyof / allof', () => {
    const card = parseVCard(iosCard('c1', 'Ada', 'Lovelace', 'ada@example.com'));
    const filter = (test: 'anyof' | 'allof', ...propFilters: { name: string; value: string }[]) => ({
      test,
      propFilters: propFilters.map((p) => ({ name: p.name, isNotDefined: false, timeRange: null, test: 'anyof' as const, paramFilters: [], textMatches: [{ value: p.value, collation: 'i;unicode-casemap' as const, negate: false, matchType: 'contains' as const }] })),
    });
    expect(cardMatches(card, filter('anyof', { name: 'FN', value: 'ada' }, { name: 'EMAIL', value: 'nobody' }))).toBe(true);
    expect(cardMatches(card, filter('allof', { name: 'FN', value: 'ada' }, { name: 'EMAIL', value: 'nobody' }))).toBe(false);
    expect(cardMatches(card, filter('allof', { name: 'ADR', value: 'london' }))).toBe(true);
    expect(cardMatches(card, { test: 'anyof', propFilters: [] })).toBe(true);
  });
});

describe('PUT validation', () => {
  it('accepts an iOS event and names its UID and component', () => {
    const v = validateCalendarObject(Buffer.from(iosEvent('abc', 'x')), 'text/calendar; charset=utf-8', ['VEVENT'], 1 << 20);
    expect([v.uid, v.componentType]).toEqual(['abc', 'VEVENT']);
  });

  it('names the precondition a bad calendar object fails', () => {
    const cal = (s: string): string => condition(() => validateCalendarObject(Buffer.from(s), 'text/calendar', ['VEVENT', 'VTODO'], 1 << 20));
    expect(cal('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBe(`{${NS.CALDAV}}valid-calendar-object-resource`);
    expect(cal('BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n')).toBe(`{${NS.CALDAV}}valid-calendar-data`);
    expect(cal('BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nUID:x\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n')).toBe(`{${NS.CALDAV}}supported-calendar-component`);
    expect(cal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(`{${NS.CALDAV}}valid-calendar-object-resource`);
    expect(cal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:a\r\nEND:VTODO\r\nEND:VCALENDAR\r\n')).toBe(`{${NS.CALDAV}}valid-calendar-object-resource`);
  });

  it('accepts vCard 3.0 and 4.0, and refuses the rest', () => {
    expect(validateVCard(Buffer.from(iosCard('u', 'A', 'B', 'a@b.c')), 'text/vcard', 1 << 20).uid).toBe('u');
    expect(validateVCard(Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nUID:urn:uuid:1\r\nEND:VCARD\r\n'), undefined, 1 << 20).uid).toBe('urn:uuid:1');
    expect(condition(() => validateVCard(Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nUID:1\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Y\r\nUID:2\r\nEND:VCARD\r\n'), 'text/vcard', 1 << 20))).toBe(`{${NS.CARDDAV}}valid-address-data`);
  });
});
