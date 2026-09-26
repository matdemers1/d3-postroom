// Request bodies and resources as iOS 26 (dataaccessd), macOS Calendar and Contacts actually send
// them: namespace prefixes A:/B:/C:/D:/E:, Apple's property wish-lists, CRLF iCalendar with a
// VTIMEZONE and a VALARM, vCard 3.0 with grouped item1.ADR / X-ABADR.

const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`;

/** iOS's first PROPFIND at the well-known URL and the context root. */
export const IOS_PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop>
    <A:current-user-principal/>
    <A:principal-URL/>
    <A:resourcetype/>
  </A:prop>
</A:propfind>`;

/** iOS Calendar's principal PROPFIND. */
export const IOS_PROPFIND_CALDAV_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:C="http://calendarserver.org/ns/">
  <A:prop>
    <B:calendar-home-set/>
    <B:calendar-user-address-set/>
    <A:current-user-principal/>
    <A:displayname/>
    <C:dropbox-home-URL/>
    <C:email-address-set/>
    <C:notification-URL/>
    <A:principal-collection-set/>
    <A:principal-URL/>
    <A:resource-id/>
    <B:schedule-inbox-URL/>
    <B:schedule-outbox-URL/>
    <A:supported-report-set/>
  </A:prop>
</A:propfind>`;

/** iOS Contacts' principal PROPFIND. */
export const IOS_PROPFIND_CARDDAV_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav">
  <A:prop>
    <B:addressbook-home-set/>
    <A:current-user-principal/>
    <A:displayname/>
    <A:principal-URL/>
    <A:resource-id/>
  </A:prop>
</A:propfind>`;

/** iOS Calendar's Depth: 1 PROPFIND on the calendar home. */
export const IOS_PROPFIND_CALENDAR_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:C="http://calendarserver.org/ns/" xmlns:D="http://apple.com/ns/ical/" xmlns:E="http://me.com/_namespace/">
  <A:prop>
    <A:add-member/>
    <C:allowed-sharing-modes/>
    <D:autoprovisioned/>
    <E:bulk-requests/>
    <D:calendar-color/>
    <B:calendar-description/>
    <B:calendar-free-busy-set/>
    <D:calendar-order/>
    <B:calendar-timezone/>
    <A:current-user-privilege-set/>
    <B:default-alarm-vevent-date/>
    <B:default-alarm-vevent-datetime/>
    <A:displayname/>
    <C:getctag/>
    <D:language-code/>
    <D:location-code/>
    <A:owner/>
    <C:pre-publish-url/>
    <C:publish-url/>
    <C:push-transports/>
    <C:pushkey/>
    <A:quota-available-bytes/>
    <A:quota-used-bytes/>
    <D:refreshrate/>
    <A:resource-id/>
    <A:resourcetype/>
    <B:schedule-calendar-transp/>
    <B:schedule-default-calendar-URL/>
    <C:source/>
    <C:subscribed-strip-alarms/>
    <C:subscribed-strip-attachments/>
    <C:subscribed-strip-todos/>
    <B:supported-calendar-component-set/>
    <B:supported-calendar-component-sets/>
    <A:supported-report-set/>
    <A:sync-token/>
  </A:prop>
</A:propfind>`;

/** iOS Contacts' Depth: 1 PROPFIND on the address book home. */
export const IOS_PROPFIND_ADDRESSBOOK_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav" xmlns:C="http://calendarserver.org/ns/" xmlns:D="http://me.com/_namespace/">
  <A:prop>
    <D:bulk-requests/>
    <A:current-user-privilege-set/>
    <A:displayname/>
    <C:getctag/>
    <B:max-image-size/>
    <B:max-resource-size/>
    <C:me-card/>
    <A:owner/>
    <C:push-transports/>
    <C:pushkey/>
    <A:quota-available-bytes/>
    <A:quota-used-bytes/>
    <A:resource-id/>
    <A:resourcetype/>
    <A:supported-report-set/>
    <A:sync-token/>
  </A:prop>
</A:propfind>`;

/** iOS's sync-collection REPORT; `token` empty for the initial sync. */
export function iosSyncCollection(token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<A:sync-collection xmlns:A="DAV:">
  <A:sync-token>${token}</A:sync-token>
  <A:sync-level>1</A:sync-level>
  <A:prop>
    <A:getcontenttype/>
    <A:getetag/>
  </A:prop>
</A:sync-collection>`;
}

/** macOS Calendar's calendar-multiget. */
export function macosCalendarMultiget(hrefs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<B:calendar-multiget xmlns:B="urn:ietf:params:xml:ns:caldav">
  <A:prop xmlns:A="DAV:">
    <A:getcontenttype/>
    <A:getetag/>
    <B:calendar-data/>
  </A:prop>
${hrefs.map((h) => `  <A:href xmlns:A="DAV:">${h}</A:href>`).join('\n')}
</B:calendar-multiget>`;
}

/** iOS Contacts' addressbook-multiget. */
export function iosAddressbookMultiget(hrefs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<B:addressbook-multiget xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav">
  <A:prop>
    <A:getetag/>
    <B:address-data/>
  </A:prop>
${hrefs.map((h) => `  <A:href>${h}</A:href>`).join('\n')}
</B:addressbook-multiget>`;
}

export function calendarQuery(start: string, end: string): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

const NY_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'DTSTART:20070311T020000',
  'TZNAME:EDT',
  'TZOFFSETTO:-0400',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'DTSTART:20071104T020000',
  'TZNAME:EST',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** An event as iOS Calendar PUTs it. */
export function iosEvent(uid: string, summary: string, opts: { start?: string; end?: string; rrule?: string; exdate?: string; sequence?: number } = {}): string {
  return crlf([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
    'CALSCALE:GREGORIAN',
    ...NY_TZ,
    'BEGIN:VEVENT',
    'CREATED:20260926T120000Z',
    `UID:${uid}`,
    `DTEND;TZID=America/New_York:${opts.end ?? '20261001T100000'}`,
    'TRANSP:OPAQUE',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    `SUMMARY:${summary}`,
    'LAST-MODIFIED:20260926T120000Z',
    'DTSTAMP:20260926T120000Z',
    `DTSTART;TZID=America/New_York:${opts.start ?? '20261001T090000'}`,
    ...(opts.rrule === undefined ? [] : [`RRULE:${opts.rrule}`]),
    ...(opts.exdate === undefined ? [] : [`EXDATE;TZID=America/New_York:${opts.exdate}`]),
    `SEQUENCE:${String(opts.sequence ?? 0)}`,
    'BEGIN:VALARM',
    `X-WR-ALARMUID:${uid}-alarm`,
    `UID:${uid}-alarm`,
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

export function vtodo(uid: string): string {
  return crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 26.0//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260926T120000Z', 'SUMMARY:Buy milk', 'DUE;VALUE=DATE:20261002', 'END:VTODO', 'END:VCALENDAR']);
}

/** A contact as iOS Contacts PUTs it (vCard 3.0). */
export function iosCard(uid: string, given: string, family: string, email: string): string {
  return crlf([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
    `N:${family};${given};;;`,
    `FN:${given} ${family}`,
    'ORG:Analytical Engines;',
    `EMAIL;type=INTERNET;type=HOME;type=pref:${email}`,
    'TEL;type=CELL;type=VOICE;type=pref:+1 555 0100',
    "item1.ADR;type=HOME;type=pref:;;12 St James's Square;London;;SW1Y 4JH;United Kingdom",
    'item1.X-ABADR:gb',
    `UID:${uid}`,
    'REV:2026-09-26T12:00:00Z',
    'END:VCARD',
  ]);
}
