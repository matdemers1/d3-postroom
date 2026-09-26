// Typed vCard values and the helpers contact auto-harvest needs: TEXT (with v2.1 quoted-printable
// and CHARSET), structured N and ADR (RFC 6350 §6.2.2, §6.3.1), multi-valued EMAIL/TEL with TYPE
// and PREF, PHOTO as a data: URI (v4) or inline base64 (v3), and `emailsOf` / `displayName`.
import { getProperties, getProperty, isQuotedPrintable, type VCard, type VCardProperty } from './card.js';
import { VCardParseError } from './errors.js';
import { splitUnescaped, unescapeText } from './lexer.js';

/** Decode quoted-printable (`=XX` escapes; soft breaks were already joined by the parser) to bytes. */
export function decodeQuotedPrintable(s: string): Uint8Array {
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    if (c < 0x80) out.push(c);
    else for (const b of enc.encode(s[i] ?? '')) out.push(b);
  }
  return Uint8Array.from(out);
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      // Unknown charset label: fall through to UTF-8, which is what every modern producer sends.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The raw value with v2.1 quoted-printable (and its CHARSET) undone; otherwise unchanged. */
export function rawText(prop: VCardProperty): string {
  if (!isQuotedPrintable(prop.params)) return prop.value;
  return decodeCharset(decodeQuotedPrintable(prop.value), prop.params.CHARSET?.[0]);
}

/** A TEXT value, unescaped (`\n`, `\,`, `\;`, `\\`). */
export function textOf(prop: VCardProperty): string {
  return unescapeText(rawText(prop));
}

/** A structured value: components split on unescaped `;`, each split on unescaped `,`, unescaped. */
export function structuredOf(prop: VCardProperty): string[][] {
  return splitUnescaped(rawText(prop), ';').map((c) => splitUnescaped(c, ',').map(unescapeText));
}

export interface StructuredName {
  family: string[];
  given: string[];
  additional: string[];
  prefixes: string[];
  suffixes: string[];
}

const nonEmpty = (xs: string[] | undefined): string[] => (xs ?? []).map((x) => x.trim()).filter((x) => x !== '');

/** The N property (RFC 6350 §6.2.2), or null. */
export function nameOf(card: VCard): StructuredName | null {
  const n = getProperty(card, 'N');
  if (n === undefined) return null;
  const c = structuredOf(n);
  return { family: nonEmpty(c[0]), given: nonEmpty(c[1]), additional: nonEmpty(c[2]), prefixes: nonEmpty(c[3]), suffixes: nonEmpty(c[4]) };
}

export interface Address {
  types: string[];
  pref: number;
  label: string | null;
  poBox: string[];
  extended: string[];
  street: string[];
  locality: string[];
  region: string[];
  postalCode: string[];
  country: string[];
}

/** Lower-cased TYPE values, splitting `TYPE="work,voice"` and `TYPE=work,voice` alike. */
export function typesOf(prop: VCardProperty): string[] {
  const out: string[] = [];
  for (const v of prop.params.TYPE ?? []) {
    for (const t of v.split(',')) {
      const x = t.trim().toLowerCase();
      if (x !== '' && !out.includes(x)) out.push(x);
    }
  }
  return out;
}

/** PREF (v4: 1 most preferred … 100), `TYPE=pref` (v3/v2.1) as 1, otherwise 100. */
export function prefOf(prop: VCardProperty): number {
  const p = prop.params.PREF?.[0];
  if (p !== undefined && /^\d{1,3}$/.test(p.trim())) {
    const n = Number(p.trim());
    if (n >= 1 && n <= 100) return n;
  }
  return typesOf(prop).includes('pref') ? 1 : 100;
}

/** The Apple-style label for a grouped property (`item1.X-ABLabel:Work`), or null. */
function groupLabel(card: VCard, prop: VCardProperty): string | null {
  if (prop.group === null) return null;
  const g = prop.group.toLowerCase();
  const label = card.properties.find((p) => p.name === 'X-ABLABEL' && p.group?.toLowerCase() === g);
  if (label === undefined) return null;
  const text = textOf(label).trim();
  // Apple's built-in labels look like `_$!<Other>!$_`.
  const m = /^_\$!<(.*)>!\$_$/.exec(text);
  return m ? (m[1] ?? '') : text;
}

function byPref<T extends { pref: number }>(xs: T[]): T[] {
  return xs.map((x, i) => ({ x, i })).sort((a, b) => a.x.pref - b.x.pref || a.i - b.i).map(({ x }) => x);
}

/** ADR properties (RFC 6350 §6.3.1), most preferred first. */
export function addressesOf(card: VCard): Address[] {
  return byPref(
    getProperties(card, 'ADR').map((p) => {
      const c = structuredOf(p);
      return {
        types: typesOf(p),
        pref: prefOf(p),
        label: p.params.LABEL?.[0] ?? groupLabel(card, p),
        poBox: nonEmpty(c[0]),
        extended: nonEmpty(c[1]),
        street: nonEmpty(c[2]),
        locality: nonEmpty(c[3]),
        region: nonEmpty(c[4]),
        postalCode: nonEmpty(c[5]),
        country: nonEmpty(c[6]),
      };
    }),
  );
}

export interface Email {
  /** The address, trimmed, with any `mailto:` scheme removed. Case is preserved. */
  address: string;
  types: string[];
  pref: number;
  /** Apple `X-ABLabel` for the property's group, when present. */
  label: string | null;
}

/**
 * Every distinct e-mail address on the card, most preferred first (PREF, then `TYPE=pref`, then
 * document order). Duplicates are compared case-insensitively; the first spelling wins. Values
 * without an `@` are dropped.
 */
export function emailsOf(card: VCard): Email[] {
  const seen = new Set<string>();
  const out: Email[] = [];
  for (const p of getProperties(card, 'EMAIL')) {
    let address = textOf(p).trim();
    if (/^mailto:/i.test(address)) address = address.slice(7).trim();
    if (!address.includes('@')) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, types: typesOf(p).filter((t) => t !== 'internet' && t !== 'pref'), pref: prefOf(p), label: groupLabel(card, p) });
  }
  return byPref(out);
}

export interface Telephone {
  /** The number (or `tel:` URI) as written. */
  value: string;
  types: string[];
  pref: number;
  label: string | null;
}

/** TEL properties, most preferred first. */
export function telsOf(card: VCard): Telephone[] {
  return byPref(
    getProperties(card, 'TEL')
      .map((p) => ({ value: textOf(p).trim(), types: typesOf(p).filter((t) => t !== 'pref'), pref: prefOf(p), label: groupLabel(card, p) }))
      .filter((t) => t.value !== ''),
  );
}

/**
 * The name to show for a contact: FN; else N assembled as prefix given additional family suffix;
 * else the first ORG component; else NICKNAME; else the most preferred e-mail address; else ''.
 */
export function displayName(card: VCard): string {
  const fn = getProperty(card, 'FN');
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  if (fn !== undefined) {
    const t = clean(textOf(fn));
    if (t !== '') return t;
  }
  const n = nameOf(card);
  if (n !== null) {
    const t = clean([...n.prefixes, ...n.given, ...n.additional, ...n.family, ...n.suffixes].join(' '));
    if (t !== '') return t;
  }
  const org = getProperty(card, 'ORG');
  if (org !== undefined) {
    const t = clean(structuredOf(org)[0]?.join(', ') ?? '');
    if (t !== '') return t;
  }
  const nick = getProperty(card, 'NICKNAME');
  if (nick !== undefined) {
    const t = clean(structuredOf(nick)[0]?.[0] ?? '');
    if (t !== '') return t;
  }
  return emailsOf(card)[0]?.address ?? '';
}

export interface DataUri {
  mediaType: string;
  data: Uint8Array;
}

const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

function decodeBase64(s: string): Uint8Array {
  if (!BASE64_RE.test(s)) throw new VCardParseError('invalid base64');
  return new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'base64'));
}

/** Parse a `data:` URI (RFC 2397). Throws VCardParseError if it is not one. */
export function parseDataUri(uri: string): DataUri {
  const m = /^data:([^,]*?),(.*)$/is.exec(uri.trim());
  if (m === null) throw new VCardParseError('not a data: URI');
  const meta = (m[1] ?? '').split(';').map((s) => s.trim());
  const isBase64 = meta[meta.length - 1]?.toLowerCase() === 'base64';
  const mediaType = (meta[0] ?? '') === '' || meta[0]?.toLowerCase() === 'base64' ? 'text/plain' : (meta[0] ?? '').toLowerCase();
  const body = m[2] ?? '';
  if (isBase64) return { mediaType, data: decodeBase64(body) };
  let decoded: string;
  try {
    decoded = decodeURIComponent(body);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    throw new VCardParseError('invalid percent-encoding in data: URI');
  }
  return { mediaType, data: new TextEncoder().encode(decoded) };
}

export type Photo = ({ kind: 'inline' } & DataUri) | { kind: 'uri'; uri: string };

/**
 * PHOTO (or LOGO) as inline bytes or a URI: v4 `data:` URIs, v3 `ENCODING=b;TYPE=JPEG`, and v2.1
 * `ENCODING=BASE64;JPEG`. Null when absent or undecodable.
 */
export function photoOf(card: VCard, name: 'PHOTO' | 'LOGO' = 'PHOTO'): Photo | null {
  const p = getProperty(card, name);
  if (p === undefined) return null;
  const value = p.value.trim();
  try {
    if (/^data:/i.test(value)) return { kind: 'inline', ...parseDataUri(value) };
    const enc = p.params.ENCODING?.[0]?.toLowerCase();
    if (enc === 'b' || enc === 'base64') {
      const t = typesOf(p).find((x) => x !== 'pref') ?? p.params.MEDIATYPE?.[0];
      const mediaType = t === undefined ? 'application/octet-stream' : t.includes('/') ? t.toLowerCase() : `image/${t.toLowerCase()}`;
      return { kind: 'inline', mediaType, data: decodeBase64(value) };
    }
  } catch (err) {
    if (err instanceof VCardParseError) return null;
    throw err;
  }
  return value === '' ? null : { kind: 'uri', uri: value };
}
