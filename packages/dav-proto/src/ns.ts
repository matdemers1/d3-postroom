// The namespaces the DAV daemon speaks, and Clark notation (`{ns}local`) as the one way to name a
// property in code.

export const NS = {
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CARDDAV: 'urn:ietf:params:xml:ns:carddav',
  /** CalendarServer extensions: getctag, which iOS and macOS use to skip unchanged collections. */
  CS: 'http://calendarserver.org/ns/',
  /** Apple's calendar-color and calendar-order. */
  ICAL: 'http://apple.com/ns/ical/',
  XML: 'http://www.w3.org/XML/1998/namespace',
  XMLNS: 'http://www.w3.org/2000/xmlns/',
} as const;

/** The prefixes the serializer uses for well-known namespaces; anything else gets `x0`, `x1`, … */
export const PREFERRED_PREFIXES: Readonly<Record<string, string>> = {
  [NS.DAV]: 'd',
  [NS.CALDAV]: 'cal',
  [NS.CARDDAV]: 'card',
  [NS.CS]: 'cs',
  [NS.ICAL]: 'ical',
};

/** `{ns}local`; a name in no namespace is `{}local`. */
export function clark(ns: string, local: string): string {
  return `{${ns}}${local}`;
}

/** The inverse of {@link clark}; null when the string is not in Clark notation. */
export function parseClark(name: string): { ns: string; local: string } | null {
  if (!name.startsWith('{')) return null;
  const close = name.indexOf('}');
  if (close < 0 || close === name.length - 1) return null;
  return { ns: name.slice(1, close), local: name.slice(close + 1) };
}
