// Response bodies: DAV:multistatus (RFC 4918 §13), DAV:error (§16), and the sync-collection
// additions (RFC 6578 §6: a sync-token after the responses, and a removed member as a response with
// a bare 404 status).
import { NS, parseClark } from './ns.js';
import { el, type XmlElement } from './xml.js';

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  207: 'Multi-Status',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  424: 'Failed Dependency',
  500: 'Internal Server Error',
  507: 'Insufficient Storage',
};

/** `HTTP/1.1 404 Not Found`. */
export function statusLine(code: number): string {
  return `HTTP/1.1 ${String(code)} ${REASONS[code] ?? 'Unknown'}`;
}

export interface PropStat {
  readonly status: number;
  /** Property elements: with a value for 200, empty (name only) for anything else. */
  readonly props: XmlElement[];
  /** A precondition element, for a 403/409. */
  readonly error?: XmlElement;
}

export interface MultiStatusResponse {
  readonly href: string;
  /** Either propstats (PROPFIND, PROPPATCH, REPORT) … */
  readonly propstats?: PropStat[];
  /** … or a status for the whole resource (a missing multiget href, a sync tombstone). */
  readonly status?: number;
  readonly error?: XmlElement;
}

/** An element in Clark notation, empty (`{DAV:}getetag` → `<d:getetag/>`). */
export function emptyElement(name: string): XmlElement {
  const c = parseClark(name);
  return c === null ? el('', name) : el(c.ns, c.local);
}

/** `<d:href>…</d:href>`. */
export function hrefElement(href: string): XmlElement {
  return el(NS.DAV, 'href', [href]);
}

/** `<d:error><condition/></d:error>`; the condition may carry children (e.g. no-uid-conflict's href). */
export function davError(condition: XmlElement | string): XmlElement {
  return el(NS.DAV, 'error', [typeof condition === 'string' ? emptyElement(condition) : condition]);
}

function responseElement(r: MultiStatusResponse): XmlElement {
  const children: XmlElement[] = [hrefElement(r.href)];
  if (r.status !== undefined) children.push(el(NS.DAV, 'status', [statusLine(r.status)]));
  for (const ps of r.propstats ?? []) {
    const kids: XmlElement[] = [el(NS.DAV, 'prop', ps.props), el(NS.DAV, 'status', [statusLine(ps.status)])];
    if (ps.error !== undefined) kids.push(el(NS.DAV, 'error', [ps.error]));
    children.push(el(NS.DAV, 'propstat', kids));
  }
  if (r.error !== undefined) children.push(el(NS.DAV, 'error', [r.error]));
  return el(NS.DAV, 'response', children);
}

/**
 * `<d:multistatus>`. Propstats with no props are dropped (RFC 4918 requires at least one prop in a
 * propstat's prop), so callers can group without checking.
 */
export function multistatus(responses: MultiStatusResponse[], syncToken?: string): XmlElement {
  const kids = responses.map((r) =>
    responseElement({ ...r, ...(r.propstats === undefined ? {} : { propstats: r.propstats.filter((p) => p.props.length > 0) }) }),
  );
  if (syncToken !== undefined) kids.push(el(NS.DAV, 'sync-token', [syncToken]));
  return el(NS.DAV, 'multistatus', kids);
}

/**
 * Group per-property outcomes into propstats by status, in first-seen order: the usual shape of a
 * PROPFIND answer (found props under 200, unknown ones under 404).
 */
export function groupPropstats(results: readonly { status: number; prop: XmlElement }[]): PropStat[] {
  const byStatus = new Map<number, XmlElement[]>();
  for (const r of results) {
    const list = byStatus.get(r.status);
    if (list === undefined) byStatus.set(r.status, [r.prop]);
    else list.push(r.prop);
  }
  return [...byStatus].map(([status, props]) => ({ status, props }));
}
