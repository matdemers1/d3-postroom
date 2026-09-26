// HTTP-level helpers for WebDAV: the Depth header, entity tags and conditional requests
// (RFC 9110 §13), and hrefs — percent-encoding path segments and decoding a request path safely.
import { DavRequestError } from './errors.js';
import { NS, clark } from './ns.js';

export type Depth = 0 | 1 | 'infinity';

/**
 * The Depth header (RFC 4918 §10.2). Absent → `fallback` (PROPFIND's default is infinity, which the
 * caller then refuses). Anything other than 0, 1 or infinity is a 400.
 */
export function parseDepth(header: string | undefined, fallback: Depth): Depth {
  if (header === undefined) return fallback;
  const v = header.trim().toLowerCase();
  if (v === '0') return 0;
  if (v === '1') return 1;
  if (v === 'infinity') return 'infinity';
  throw new DavRequestError(400, `invalid Depth header "${header.slice(0, 20)}"`);
}

/** A strong entity tag on the wire: the opaque value in double quotes. */
export function formatEtag(opaque: string): string {
  if (!/^[\x21\x23-\x7e]*$/.test(opaque)) throw new DavRequestError(500, 'entity tag contains characters it may not');
  return `"${opaque}"`;
}

export interface EntityTag {
  readonly weak: boolean;
  /** The opaque value, without quotes. */
  readonly opaque: string;
}

/**
 * An If-Match / If-None-Match value (RFC 9110 §13.1.1): `*`, or a list of entity tags. Malformed
 * lists are a 400 rather than a guess, since a guess could let a write through that should 412.
 */
export function parseEtagList(header: string): '*' | EntityTag[] {
  const v = header.trim();
  if (v === '*') return '*';
  const tags: EntityTag[] = [];
  const re = /\s*(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"\s*(,|$)/y;
  let pos = 0;
  while (pos < v.length) {
    re.lastIndex = pos;
    const m = re.exec(v);
    if (m === null) throw new DavRequestError(400, 'malformed entity-tag list');
    tags.push({ weak: m[1] !== undefined, opaque: m[2] ?? '' });
    pos = re.lastIndex;
    if (m[3] === '' && pos < v.length) throw new DavRequestError(400, 'malformed entity-tag list');
  }
  if (tags.length === 0) throw new DavRequestError(400, 'empty entity-tag list');
  return tags;
}

export interface Preconditions {
  readonly ifMatch?: string | undefined;
  readonly ifNoneMatch?: string | undefined;
}

/**
 * Evaluate If-Match and If-None-Match (RFC 9110 §13.2.2) against the resource's current strong
 * entity tag (`null` when it does not exist). Returns the status to answer instead of performing
 * the method — 412, or 304 for a GET/HEAD whose If-None-Match matched — or null to proceed.
 * If-Match uses the strong comparison, If-None-Match the weak one.
 */
export function evaluatePreconditions(p: Preconditions, current: string | null, method: string): 304 | 412 | null {
  if (p.ifMatch !== undefined) {
    const list = parseEtagList(p.ifMatch);
    const ok = current !== null && (list === '*' || list.some((t) => !t.weak && t.opaque === current));
    if (!ok) return 412;
  }
  if (p.ifNoneMatch !== undefined) {
    const list = parseEtagList(p.ifNoneMatch);
    const matched = current !== null && (list === '*' || list.some((t) => t.opaque === current));
    if (matched) return method === 'GET' || method === 'HEAD' ? 304 : 412;
  }
  return null;
}

// RFC 3986 pchar minus the sub-delims clients are least consistent about: unreserved, plus a few
// sub-delims every client leaves alone. Everything else is percent-encoded, UTF-8 first.
const SEGMENT_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;

/** Percent-encode one path segment. */
export function encodeSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (SEGMENT_SAFE.test(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `/a/b/` from segments; `trailingSlash` for a collection. */
export function hrefOf(segments: readonly string[], trailingSlash: boolean): string {
  const path = `/${segments.map(encodeSegment).join('/')}`;
  return trailingSlash && segments.length > 0 ? `${path}/` : path;
}

export interface DecodedPath {
  readonly segments: string[];
  /** The request path ended in `/`. */
  readonly trailingSlash: boolean;
}

/**
 * Decode a request path (no query) into segments, refusing anything that could name something
 * other than what it looks like: malformed or overlong percent-encoding, invalid UTF-8, an encoded
 * `/` or NUL, control characters, and `.`/`..` segments. Empty segments (`//`) collapse.
 */
export function decodePath(path: string, maxLength = 2048): DecodedPath {
  if (path.length > maxLength) throw new DavRequestError(414, 'request path too long');
  if (!path.startsWith('/')) throw new DavRequestError(400, 'request path must be absolute');
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    if (/%(?![0-9A-Fa-f]{2})/.test(raw)) throw new DavRequestError(400, 'malformed percent-encoding');
    let seg: string;
    try {
      seg = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(raw.replace(/%([0-9A-Fa-f]{2})|[^%]+/g, (m, hex?: string) => (hex === undefined ? Buffer.from(m, 'utf8').toString('latin1') : String.fromCharCode(parseInt(hex, 16)))), 'latin1'),
      );
    } catch {
      throw new DavRequestError(400, 'path is not valid UTF-8');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f/\\]/.test(seg)) throw new DavRequestError(400, 'path segment contains a character it may not');
    if (seg === '.' || seg === '..') throw new DavRequestError(400, 'dot segments are not allowed');
    segments.push(seg);
  }
  return { segments, trailingSlash: path.endsWith('/') };
}

/**
 * The path of an href from a request body (multiget): an absolute path, or an absolute URL whose
 * path is taken. Returns null when it is neither.
 */
export function hrefPath(href: string): string | null {
  const h = href.trim();
  if (h.startsWith('/')) return h.split(/[?#]/, 1)[0] ?? null;
  if (/^https?:\/\//i.test(h)) {
    try {
      return new URL(h).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

/** The DAV:error condition for a PROPFIND with Depth: infinity (RFC 4918 §9.1). */
export const PROPFIND_FINITE_DEPTH = clark(NS.DAV, 'propfind-finite-depth');
