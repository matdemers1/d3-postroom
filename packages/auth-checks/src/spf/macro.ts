// Macro expansion, RFC 7208 SS7. `%{letter [digits] [r] [delimiters]}`, plus the literal escapes
// `%%`, `%_` and `%-`. Uppercase letters URL-escape their expansion (SS7.3). Steps for a letter
// with a transformer: split on the delimiter set (default "."), keep the right-most `digits`
// parts (if given), then reverse (if `r` was given), then rejoin with ".".

import { SpfPermError } from './errors.js';
import { parseIPv6, ipv6ToDottedNibbles } from './ip.js';

export interface MacroContext {
  /** The `<sender>` from SS4.1: MAIL FROM, or postmaster@HELO when MAIL FROM is null. */
  sender: string;
  /** `<domain>`: the domain currently under evaluation (changes across include/redirect). */
  domain: string;
  ip: string;
  ipVersion: 4 | 6;
  helo: string;
  /** Domain name of the host performing the SPF check, for the `r` macro (exp= only). */
  receivingDomain?: string | undefined;
  timestamp?: number | undefined;
  /** `c`, `r` and `t` are only defined while expanding an `exp=` explanation string (SS7.3). */
  inExp: boolean;
}

const MACRO_LETTERS = 'slodipvhcrtSLODIPVHCRT';

export function localPart(sender: string): string {
  const at = sender.indexOf('@');
  return at === -1 ? sender : sender.slice(0, at);
}

export function domainPart(sender: string): string {
  const at = sender.indexOf('@');
  return at === -1 ? '' : sender.slice(at + 1);
}

function splitByDelims(str: string, delims: string): string[] {
  const delimSet = new Set(delims.split(''));
  const parts: string[] = [];
  let current = '';
  for (const ch of str) {
    if (delimSet.has(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function urlEscape(str: string): string {
  return Array.from(str)
    .map((ch) => {
      if (/[A-Za-z0-9._~-]/.test(ch)) return ch;
      const bytes = new TextEncoder().encode(ch);
      return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    })
    .join('');
}

function expandLetter(letter: string, ctx: MacroContext): string {
  switch (letter) {
    case 's':
      return ctx.sender;
    case 'l':
      return localPart(ctx.sender);
    case 'o':
      return domainPart(ctx.sender);
    case 'd':
      return ctx.domain;
    case 'i':
      if (ctx.ipVersion === 4) return ctx.ip;
      {
        const v6 = parseIPv6(ctx.ip);
        if (v6 === undefined) throw new SpfPermError(`invalid IPv6 address for %{i}: ${ctx.ip}`);
        return ipv6ToDottedNibbles(v6);
      }
    case 'p':
      // Validated domain name (SS7.3): we do not perform the forward-confirmed reverse-DNS
      // lookup this would require, so per RFC 7208 SS7.3 we always report "unknown".
      return 'unknown';
    case 'v':
      return ctx.ipVersion === 4 ? 'in-addr' : 'ip6';
    case 'h':
      return ctx.helo;
    case 'c':
      return ctx.ip;
    case 'r':
      return ctx.receivingDomain ?? 'unknown';
    case 't':
      return String(ctx.timestamp ?? Math.floor(Date.now() / 1000));
    default:
      throw new SpfPermError(`unknown macro letter: ${letter}`);
  }
}

/** Expand a macro-string (domain-spec or explain-string) per RFC 7208 SS7. Throws SpfPermError
 * on any syntax error, including use of `c`/`r`/`t` outside an `exp=` explanation. */
export function expandMacros(template: string, ctx: MacroContext): string {
  let result = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '%') {
      result += ch ?? '';
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next === '%') {
      result += '%';
      i += 2;
      continue;
    }
    if (next === '_') {
      result += ' ';
      i += 2;
      continue;
    }
    if (next === '-') {
      result += '%20';
      i += 2;
      continue;
    }
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      if (close === -1) throw new SpfPermError('unterminated macro expansion');
      const body = template.slice(i + 2, close);
      const m = /^([a-zA-Z])(\d*)(r?)([.\-+,/_=]*)$/.exec(body);
      if (!m || !MACRO_LETTERS.includes(m[1] ?? '')) {
        throw new SpfPermError(`invalid macro: %{${body}}`);
      }
      const letterRaw = m[1] ?? '';
      const digitsRaw = m[2] ?? '';
      const reverseFlag = m[3] ?? '';
      const delimsRaw = m[4] ?? '';
      const letter = letterRaw.toLowerCase();
      const upper = letterRaw !== letter;
      if ((letter === 'c' || letter === 'r' || letter === 't') && !ctx.inExp) {
        throw new SpfPermError(`macro %{${letter}} is only valid in an exp= explanation`);
      }
      let expanded = expandLetter(letter, ctx);
      const delims = delimsRaw === '' ? '.' : delimsRaw;
      let parts = splitByDelims(expanded, delims);
      if (digitsRaw !== '') {
        const n = Number(digitsRaw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new SpfPermError(`macro digit transformer must be a positive integer: ${digitsRaw}`);
        }
        parts = parts.slice(-n);
      }
      if (reverseFlag === 'r') parts = parts.reverse();
      expanded = parts.join('.');
      if (upper) expanded = urlEscape(expanded);
      result += expanded;
      i = close + 1;
      continue;
    }
    throw new SpfPermError(`invalid macro escape at position ${String(i)}`);
  }
  return result;
}
