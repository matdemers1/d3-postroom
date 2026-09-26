// Request bodies as iOS, macOS and DAVx5 actually send them, and the HTTP helpers.
import { describe, expect, it } from 'vitest';
import {
  DavRequestError,
  NS,
  davError,
  decodePath,
  encodeSegment,
  evaluatePreconditions,
  hrefOf,
  hrefPath,
  multistatus,
  parseDepth,
  parseEtagList,
  parseMkcol,
  parsePropfind,
  parseProppatch,
  parseReport,
  parseUtcDateTime,
  parseXml,
  serializeXml,
  textMatches,
} from '../../src/index.js';

function status(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof DavRequestError) return `${String(err.status)}${err.condition === undefined ? '' : ` ${err.condition}`}`;
    throw err;
  }
  return 'ok';
}

describe('PROPFIND / PROPPATCH / MKCALENDAR bodies', () => {
  it('reads the iOS principal PROPFIND', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/><A:principal-URL/><A:resourcetype/></A:prop></A:propfind>`;
    const req = parsePropfind(parseXml(body));
    expect(req.kind === 'prop' && req.props.map((p) => p.local)).toEqual(['current-user-principal', 'principal-URL', 'resourcetype']);
  });

  it('treats an empty body as allprop and reads propname', () => {
    expect(parsePropfind(null)).toEqual({ kind: 'allprop', include: [] });
    expect(parsePropfind(parseXml('<propfind xmlns="DAV:"><propname/></propfind>'))).toEqual({ kind: 'propname' });
    expect(status(() => parsePropfind(parseXml('<propfind xmlns="DAV:"><prop/><allprop/></propfind>')))).toBe('400');
    expect(status(() => parsePropfind(parseXml('<x xmlns="DAV:"/>')))).toBe('400');
  });

  it('reads PROPPATCH set and remove in order', () => {
    const body = `<A:propertyupdate xmlns:A="DAV:" xmlns:B="http://apple.com/ns/ical/"><A:set><A:prop><A:displayname>Work</A:displayname><B:calendar-color>#FF2968FF</B:calendar-color></A:prop></A:set><A:remove><A:prop><B:calendar-order/></A:prop></A:remove></A:propertyupdate>`;
    expect(parseProppatch(parseXml(body)).map((u) => `${u.action} ${u.prop.local}`)).toEqual(['set displayname', 'set calendar-color', 'remove calendar-order']);
  });

  it('reads MKCALENDAR and extended MKCOL', () => {
    const mkcal = `<B:mkcalendar xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav"><A:set><A:prop><A:displayname>Home</A:displayname><B:supported-calendar-component-set><B:comp name="VEVENT"/></B:supported-calendar-component-set></A:prop></A:set></B:mkcalendar>`;
    expect(parseMkcol(parseXml(mkcal), 'MKCALENDAR').map((p) => p.local)).toEqual(['displayname', 'supported-calendar-component-set']);
    const mkcol = `<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:set><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype></D:prop></D:set></D:mkcol>`;
    expect(parseMkcol(parseXml(mkcol), 'MKCOL').map((p) => p.local)).toEqual(['resourcetype']);
    expect(parseMkcol(null, 'MKCALENDAR')).toEqual([]);
  });
});

describe('REPORT bodies', () => {
  it('reads the iOS sync-collection, initial and incremental', () => {
    const initial = parseReport(parseXml('<A:sync-collection xmlns:A="DAV:"><A:sync-token/><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>'));
    expect(initial).toMatchObject({ kind: 'sync-collection', syncToken: '', level: '1', limit: null });
    const next = parseReport(parseXml('<sync-collection xmlns="DAV:"><sync-token>http://postroom/ns/sync/x/4</sync-token><sync-level>1</sync-level><prop><getetag/></prop></sync-collection>'));
    expect(next).toMatchObject({ syncToken: 'http://postroom/ns/sync/x/4' });
  });

  it('reads the macOS calendar-multiget', () => {
    const body = `<B:calendar-multiget xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav"><A:prop><A:getetag/><B:calendar-data/></A:prop><A:href>/dav/calendars/x/calendar/a.ics</A:href><A:href>/dav/calendars/x/calendar/b%20c.ics</A:href></B:calendar-multiget>`;
    expect(parseReport(parseXml(body))).toMatchObject({ kind: 'calendar-multiget', hrefs: ['/dav/calendars/x/calendar/a.ics', '/dav/calendars/x/calendar/b%20c.ics'] });
  });

  it('reads a calendar-query with a time-range, prop-filter and text-match', () => {
    const body = `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260101T000000Z" end="20260201T000000Z"/><C:prop-filter name="SUMMARY"><C:text-match negate-condition="yes">standup</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    const r = parseReport(parseXml(body));
    if (r.kind !== 'calendar-query') throw new Error(r.kind);
    const vevent = r.filter.compFilters[0];
    expect(vevent?.timeRange).toEqual({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 1) });
    expect(vevent?.propFilters[0]?.textMatches[0]).toEqual({ value: 'standup', collation: 'i;ascii-casemap', negate: true, matchType: 'contains' });
  });

  it('refuses invalid calendar-query filters with CALDAV preconditions', () => {
    const q = (filter: string): string => `<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>${filter}</C:filter></C:calendar-query>`;
    const valid = `403 {${NS.CALDAV}}valid-filter`;
    expect(status(() => parseReport(parseXml(q('<C:comp-filter name="VEVENT"/>'))))).toBe(valid);
    expect(status(() => parseReport(parseXml(q(''))))).toBe(valid);
    expect(status(() => parseReport(parseXml(q('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260101"/></C:comp-filter></C:comp-filter>'))))).toBe(valid);
    expect(status(() => parseReport(parseXml(q('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260201T000000Z" end="20260101T000000Z"/></C:comp-filter></C:comp-filter>'))))).toBe(valid);
    expect(
      status(() => parseReport(parseXml(q('<C:comp-filter name="VCALENDAR"><C:prop-filter name="X"><C:text-match collation="i;klingon">a</C:text-match></C:prop-filter></C:comp-filter>')))),
    ).toBe(`403 {${NS.CALDAV}}supported-collation`);
  });

  it('reads an addressbook-query with test, match-type and a limit', () => {
    const body = `<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/></D:prop><C:filter test="allof"><C:prop-filter name="EMAIL"><C:text-match match-type="ends-with">@d3cloud.io</C:text-match></C:prop-filter></C:filter><C:limit><C:nresults>5</C:nresults></C:limit></C:addressbook-query>`;
    const r = parseReport(parseXml(body));
    expect(r).toMatchObject({ kind: 'addressbook-query', limit: 5, filter: { test: 'allof', propFilters: [{ name: 'EMAIL', textMatches: [{ matchType: 'ends-with', collation: 'i;unicode-casemap' }] }] } });
  });

  it('names an unknown report instead of guessing', () => {
    expect(parseReport(parseXml('<D:expand-property xmlns:D="DAV:"/>'))).toEqual({ kind: 'unsupported', name: '{DAV:}expand-property' });
  });
});

describe('HTTP helpers', () => {
  it('parses Depth', () => {
    expect(parseDepth('0', 'infinity')).toBe(0);
    expect(parseDepth(' 1 ', 'infinity')).toBe(1);
    expect(parseDepth(undefined, 'infinity')).toBe('infinity');
    expect(parseDepth('Infinity', 0)).toBe('infinity');
    expect(status(() => parseDepth('2', 0))).toBe('400');
  });

  it('evaluates If-Match and If-None-Match', () => {
    expect(evaluatePreconditions({ ifNoneMatch: '*' }, null, 'PUT')).toBeNull();
    expect(evaluatePreconditions({ ifNoneMatch: '*' }, 'abc', 'PUT')).toBe(412);
    expect(evaluatePreconditions({ ifMatch: '"abc"' }, 'abc', 'PUT')).toBeNull();
    expect(evaluatePreconditions({ ifMatch: '"old", "abc"' }, 'abc', 'PUT')).toBeNull();
    expect(evaluatePreconditions({ ifMatch: '"old"' }, 'abc', 'PUT')).toBe(412);
    expect(evaluatePreconditions({ ifMatch: 'W/"abc"' }, 'abc', 'PUT')).toBe(412);
    expect(evaluatePreconditions({ ifMatch: '*' }, null, 'DELETE')).toBe(412);
    expect(evaluatePreconditions({ ifNoneMatch: 'W/"abc"' }, 'abc', 'GET')).toBe(304);
    expect(status(() => parseEtagList('abc'))).toBe('400');
    expect(parseEtagList('"a", W/"b"')).toEqual([{ weak: false, opaque: 'a' }, { weak: true, opaque: 'b' }]);
  });

  it('encodes and decodes hrefs, refusing traversal and encoded slashes', () => {
    expect(encodeSegment('a b/ç.ics')).toBe('a%20b%2F%C3%A7.ics');
    expect(hrefOf(['dav', 'calendars', 'x', 'my cal'], true)).toBe('/dav/calendars/x/my%20cal/');
    expect(decodePath('/dav/calendars/x/my%20cal/')).toEqual({ segments: ['dav', 'calendars', 'x', 'my cal'], trailingSlash: true });
    expect(decodePath('//dav//x')).toEqual({ segments: ['dav', 'x'], trailingSlash: false });
    expect(status(() => decodePath('/dav/../etc'))).toBe('400');
    expect(status(() => decodePath('/dav/%2e%2e/etc'))).toBe('400');
    expect(status(() => decodePath('/dav/a%2Fb'))).toBe('400');
    expect(status(() => decodePath('/dav/a%00b'))).toBe('400');
    expect(status(() => decodePath('/dav/%zz'))).toBe('400');
    expect(status(() => decodePath('/dav/%C3%28'))).toBe('400');
    expect(hrefPath('https://dav.d3cloud.io/dav/x/?q=1')).toBe('/dav/x/');
    expect(hrefPath('/dav/x#frag')).toBe('/dav/x');
    expect(hrefPath('mailto:x')).toBeNull();
  });

  it('matches text under each collation', () => {
    const tm = { value: 'STRASSE', collation: 'i;unicode-casemap', negate: false, matchType: 'contains' } as const;
    expect(textMatches('Hauptstraße 1', tm)).toBe(true);
    expect(textMatches('Hauptstraße 1', { ...tm, collation: 'i;ascii-casemap' })).toBe(false);
    expect(textMatches('abc', { ...tm, value: 'ABC', collation: 'i;octet' })).toBe(false);
    expect(textMatches('abc', { ...tm, value: 'b', matchType: 'equals' })).toBe(false);
    expect(textMatches('abc', { ...tm, value: 'b', negate: true })).toBe(false);
    expect(parseUtcDateTime('20260301T120000Z')).toBe(Date.UTC(2026, 2, 1, 12));
    expect(status(() => parseUtcDateTime('20260230T000000Z'))).toBe('403');
  });

  it('builds multistatus bodies with a sync-token and tombstones', () => {
    const xml = serializeXml(
      multistatus(
        [
          { href: '/c/a.ics', propstats: [{ status: 200, props: [{ ns: NS.DAV, local: 'getetag', attrs: [], children: ['"1"'] }] }, { status: 404, props: [] }] },
          { href: '/c/gone.ics', status: 404 },
        ],
        'http://postroom/ns/sync/c/2',
      ),
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>/c/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/c/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:sync-token>http://postroom/ns/sync/c/2</d:sync-token></d:multistatus>',
    );
    expect(serializeXml(davError('{DAV:}valid-sync-token'), { declaration: false })).toBe('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>');
  });
});
