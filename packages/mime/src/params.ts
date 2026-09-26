// Content-Type (RFC 2045 §5), Content-Disposition (RFC 2183) and their parameters, including
// RFC 2231 continuations, charsets and languages (`filename*0*=utf-8''…`, `title*=…`). Parameter
// values that are RFC 2047 encoded-words — wrong, but what Outlook and Gmail send for filenames —
// are decoded too.

import { decodeBytes } from './charset.js';
import { decodeEncodedWords } from './encoded-word.js';

export type Params = Record<string, string>;

export interface ContentType {
  /** `type/subtype`, lowercased. */
  readonly mimeType: string;
  readonly type: string;
  readonly subtype: string;
  readonly params: Params;
  /** False when the header was absent or unparseable and the default applied. */
  readonly valid: boolean;
}

export interface ContentDisposition {
  /** `inline`, `attachment`, or another token, lowercased. */
  readonly type: string;
  readonly params: Params;
}

/** Remove RFC 5322 comments, honouring quoted strings, nesting and quoted-pairs. */
export function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += ch + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out;
}

interface RawParam {
  name: string;
  value: string;
  quoted: boolean;
}

/** Split `a=b; c="d;e"` into raw parameters. Unquotes quoted-strings. Never throws. */
function splitParams(text: string): RawParam[] {
  const out: RawParam[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && (text[i] === ';' || /\s/.test(text[i] as string))) i++;
    if (i >= n) break;
    let name = '';
    while (i < n && text[i] !== '=' && text[i] !== ';') name += text[i++] as string;
    name = name.trim().toLowerCase();
    if (text[i] !== '=') {
      i++;
      continue; // a bare token without a value: ignore
    }
    i++; // '='
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) i++;
        value += text[i++] as string;
      }
      i++; // closing quote (or end)
      while (i < n && text[i] !== ';') i++; // anything after the quoted string is junk
    } else {
      while (i < n && text[i] !== ';') value += text[i++] as string;
      value = value.trim();
    }
    if (name !== '') out.push({ name, value, quoted });
  }
  return out;
}

function percentDecode(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x25 && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch > 0x7f) {
      out.push(...Buffer.from(text[i] ?? '', 'utf8'));
    } else {
      out.push(ch);
    }
  }
  return Buffer.from(out);
}

interface Section {
  value: string;
  encoded: boolean;
}

/**
 * Parse a parameter list (everything after the first `;`). RFC 2231 continuations are joined in
 * order, `*`-marked sections percent-decoded and decoded in the charset named by the first section.
 * A plain `name=` is overridden by an extended `name*=` of the same name.
 */
export function parseParams(text: string): Params {
  const params: Params = Object.create(null) as Params;
  const extended = new Map<string, Map<number, Section>>();
  for (const p of splitParams(text)) {
    const m = /^([^*]+)\*(?:(\d{1,3})(\*)?|(\*)?)$/.exec(p.name);
    // name*  → single encoded; name*N → section; name*N* → encoded section
    if (m !== null) {
      const base = m[1] as string;
      const index = m[2] === undefined ? 0 : Number(m[2]);
      const encoded = m[2] === undefined ? true : m[3] === '*';
      let sections = extended.get(base);
      if (sections === undefined) {
        if (extended.size >= 64) continue;
        sections = new Map();
        extended.set(base, sections);
      }
      if (!sections.has(index)) sections.set(index, { value: p.value, encoded: encoded && !p.quoted });
    } else if (!(p.name in params)) {
      // Only human-facing names are RFC 2047-decoded; a boundary must stay byte-exact.
      params[p.name] = ENCODED_WORD_PARAMS.has(p.name) ? decodeIfEncodedWord(p.value) : p.value;
    }
  }
  for (const [base, sections] of extended) {
    let charset: string | null = null;
    const bytes: Buffer[] = [];
    for (let i = 0; sections.has(i); i++) {
      const s = sections.get(i) as Section;
      if (s.encoded) {
        let v = s.value;
        if (i === 0) {
          const q1 = v.indexOf("'");
          const q2 = q1 >= 0 ? v.indexOf("'", q1 + 1) : -1;
          if (q2 >= 0) {
            charset = v.slice(0, q1) || null;
            v = v.slice(q2 + 1);
          }
        }
        bytes.push(percentDecode(v));
      } else {
        bytes.push(Buffer.from(s.value, 'utf8'));
      }
    }
    if (bytes.length > 0) params[base] = decodeBytes(Buffer.concat(bytes), charset).text;
  }
  return params;
}

const ENCODED_WORD_PARAMS = new Set(['name', 'filename']);

function decodeIfEncodedWord(value: string): string {
  return value.includes('=?') ? decodeEncodedWords(value) : value;
}

/** Split `type/subtype; params` at the first `;` outside a quoted string. */
function splitHead(value: string): [string, string] {
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\\') i++;
    else if (ch === ';' && !quoted) return [value.slice(0, i), value.slice(i + 1)];
  }
  return [value, ''];
}

const TOKEN = /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+$/;

/**
 * Parse a Content-Type value. `fallback` is used (with `valid: false`) when the value is null or
 * has no parseable `type/subtype` — RFC 2045 §5.2 says to treat that as text/plain.
 */
export function parseContentType(value: string | null, fallback = 'text/plain'): ContentType {
  const fb = (): ContentType => {
    const [type, subtype] = fallback.split('/') as [string, string];
    const params = value === null ? (Object.create(null) as Params) : parseParams(splitHead(stripComments(value))[1]);
    return { mimeType: fallback, type, subtype, params, valid: false };
  };
  if (value === null) return fb();
  const [head, rest] = splitHead(stripComments(value));
  const slash = head.indexOf('/');
  if (slash < 0) return fb();
  const type = head.slice(0, slash).trim().toLowerCase();
  const subtype = head.slice(slash + 1).trim().toLowerCase();
  if (!TOKEN.test(type) || !TOKEN.test(subtype)) return fb();
  return { mimeType: `${type}/${subtype}`, type, subtype, params: parseParams(rest), valid: true };
}

/** Parse a Content-Disposition value, or null when absent. */
export function parseContentDisposition(value: string | null): ContentDisposition | null {
  if (value === null) return null;
  const [head, rest] = splitHead(stripComments(value));
  const type = head.trim().toLowerCase();
  return { type: type === '' ? 'attachment' : type, params: parseParams(rest) };
}

/** Quote a parameter value for writing if it is not a token. */
export function formatParamValue(value: string): string {
  return TOKEN.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
