// Paths, mailboxes and domains (RFC 5321 §4.1.2, §4.1.3, §4.5.3.1; RFC 6531 §3.3 for UTF-8).
//
// Parsing works on the decoded command string. UTF-8 is accepted by the grammar here; whether it is
// *permitted* (only with SMTPUTF8) is the command parser's call, reported through `nonAscii`.

import { isIPv6 } from 'node:net';

export interface Mailbox {
  /** The local part as meant, with any quoting and quoted-pair escapes removed. */
  readonly localPart: string;
  /** A domain, or an address literal including its brackets (`[192.0.2.1]`, `[IPv6:…]`). */
  readonly domain: string;
}

export type ReversePath = { readonly kind: 'null' } | { readonly kind: 'mailbox'; readonly mailbox: Mailbox };
export type ForwardPath =
  | { readonly kind: 'mailbox'; readonly mailbox: Mailbox }
  /** RFC 5321 §4.1.1.3: the bare `<Postmaster>` recipient, which has no domain. */
  | { readonly kind: 'postmaster' };

export const MAX_LOCAL_PART_OCTETS = 64;
export const MAX_DOMAIN_OCTETS = 255;
export const MAX_PATH_OCTETS = 256;

// atext (RFC 5322 §3.2.3) as ASCII code points.
const ATEXT = new Set("!#$%&'*+-/=?^_`{|}~".split('').map((c) => c.charCodeAt(0)));

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}
function isAtext(c: number): boolean {
  return isAlpha(c) || isDigit(c) || ATEXT.has(c) || c >= 0x80;
}
function isQtextSMTP(c: number): boolean {
  return c === 32 || c === 33 || (c >= 35 && c <= 91) || (c >= 93 && c <= 126) || c >= 0x80;
}

function octets(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return true;
  return false;
}

/** A Dot-string: atoms of atext separated by single dots. */
export function isDotString(s: string): boolean {
  if (s === '') return false;
  let prevDot = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2e) {
      if (prevDot) return false;
      prevDot = true;
    } else if (isAtext(c)) prevDot = false;
    else return false;
  }
  return !prevDot;
}

/** One domain label: letters/digits/hyphen (or UTF-8 for U-labels), no leading/trailing hyphen. */
function isLabel(label: string): boolean {
  if (label === '' || octets(label) > 63) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (!(isAlpha(c) || isDigit(c) || c === 0x2d || c >= 0x80)) return false;
  }
  return true;
}

export function isDomain(s: string): boolean {
  if (s === '' || octets(s) > MAX_DOMAIN_OCTETS) return false;
  return s.split('.').every(isLabel);
}

function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
  );
}

/** `[IPv4]` or `[IPv6:…]`. General address literals (`[tag:…]`) are refused. */
export function isAddressLiteral(s: string): boolean {
  if (!s.startsWith('[') || !s.endsWith(']')) return false;
  const inner = s.slice(1, -1);
  if (/^IPv6:/i.test(inner)) return isIPv6(inner.slice(5));
  return isIPv4(inner);
}

export function isDomainOrLiteral(s: string): boolean {
  return s.startsWith('[') ? isAddressLiteral(s) : isDomain(s);
}

/** Quote a local part only if it is not already a valid Dot-string. */
export function formatLocalPart(local: string): string {
  if (isDotString(local)) return local;
  return `"${local.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
}

export function formatMailbox(m: Mailbox): string {
  return `${formatLocalPart(m.localPart)}@${m.domain}`;
}

export function formatReversePath(p: ReversePath): string {
  return p.kind === 'null' ? '<>' : `<${formatMailbox(p.mailbox)}>`;
}

export function formatForwardPath(p: ForwardPath): string {
  return p.kind === 'postmaster' ? '<Postmaster>' : `<${formatMailbox(p.mailbox)}>`;
}

export type PathParse =
  | { readonly ok: true; readonly path: ReversePath | ForwardPath; readonly end: number; readonly nonAscii: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse `<…>` starting at `s[start]`. Returns the path and the index just past `>`.
 * Source routes (`<@a,@b:user@c>`) are accepted and stripped, per RFC 5321 §4.1.2 / Appendix C.
 */
export function parsePath(s: string, start: number, kind: 'reverse' | 'forward'): PathParse {
  let i = start;
  if (s[i] !== '<') return { ok: false, reason: 'path must start with <' };
  i++;
  if (s[i] === '>') {
    if (kind === 'forward') return { ok: false, reason: 'null path not allowed here' };
    return { ok: true, path: { kind: 'null' }, end: i + 1, nonAscii: false };
  }
  // Source route: A-d-l ":" — "@dom,@dom:".
  if (s[i] === '@') {
    const colon = s.indexOf(':', i);
    if (colon < 0) return { ok: false, reason: 'unterminated source route' };
    const hops = s.slice(i, colon).split(',');
    if (!hops.every((h) => h.startsWith('@') && isDomainOrLiteral(h.slice(1)))) {
      return { ok: false, reason: 'invalid source route' };
    }
    i = colon + 1;
  }
  // Local part.
  let local: string;
  if (s[i] === '"') {
    i++;
    let buf = '';
    for (;;) {
      if (i >= s.length) return { ok: false, reason: 'unterminated quoted local part' };
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c === 0x5c) {
        const n = s.charCodeAt(i + 1);
        if (!(n >= 32 && n <= 126)) return { ok: false, reason: 'invalid quoted-pair' };
        buf += s[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (!isQtextSMTP(c)) return { ok: false, reason: 'invalid character in quoted local part' };
      buf += s[i] ?? '';
      i++;
    }
    local = buf;
  } else {
    const startLocal = i;
    while (i < s.length && s[i] !== '@' && s[i] !== '>') i++;
    local = s.slice(startLocal, i);
    if (kind === 'forward' && s[i] === '>' && local.toLowerCase() === 'postmaster') {
      return { ok: true, path: { kind: 'postmaster' }, end: i + 1, nonAscii: false };
    }
    if (!isDotString(local)) return { ok: false, reason: 'invalid local part' };
  }
  if (octets(local) > MAX_LOCAL_PART_OCTETS) return { ok: false, reason: 'local part too long' };
  if (s[i] !== '@') return { ok: false, reason: 'missing @domain' };
  i++;
  // Domain or address literal, up to ">".
  const close = s.indexOf('>', i);
  if (close < 0) return { ok: false, reason: 'path must end with >' };
  const domain = s.slice(i, close);
  if (!isDomainOrLiteral(domain)) return { ok: false, reason: 'invalid domain' };
  const mailbox: Mailbox = { localPart: local, domain };
  if (octets(formatMailbox(mailbox)) + 2 > MAX_PATH_OCTETS) return { ok: false, reason: 'path too long' };
  return {
    ok: true,
    path: { kind: 'mailbox', mailbox },
    end: close + 1,
    nonAscii: hasNonAscii(local) || hasNonAscii(domain),
  };
}

// --- xtext (RFC 3461 §4): used by AUTH=, ENVID=, ORCPT= -------------------------------------------

export function decodeXtext(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2b) {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (c >= 33 && c <= 126 && c !== 0x3d) out += s[i] ?? '';
    else return null;
  }
  return out;
}

export function encodeXtext(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 33 && c <= 126 && c !== 0x2b && c !== 0x3d) out += s[i] ?? '';
    else if (c <= 0xff) out += `+${c.toString(16).toUpperCase().padStart(2, '0')}`;
    else throw new TypeError('xtext cannot encode characters above U+00FF');
  }
  return out;
}
