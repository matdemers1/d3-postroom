// RFC 5545 §3.1 content lines: CRLF line breaks, folding at 75 octets (never inside a UTF-8
// sequence), parameters with quoted values and RFC 6868 caret escapes, and TEXT escaping (§3.3.11).
import { ICalError, ICalLimitError, ICalParseError } from './errors.js';

/** Parameters: upper-cased name → decoded values (a parameter always has at least one value). */
export type Params = Record<string, string[]>;

export interface ContentLine {
  /** Upper-cased property name. */
  name: string;
  params: Params;
  /** The raw value exactly as it appeared after unfolding (escapes intact). */
  value: string;
}

export interface LogicalLine {
  text: string;
  /** 1-based physical line number the logical line starts on. */
  line: number;
}

/** Octets a line may occupy before it must be folded, excluding the CRLF (RFC 5545 §3.1). */
export const FOLD_OCTETS = 75;

const NAME_CHAR = /^[A-Za-z0-9-]$/;

/** Decode input bytes as UTF-8 (lossy: invalid sequences become U+FFFD) and drop a leading BOM. */
export function decodeInput(input: string | Uint8Array, maxBytes: number): string {
  let text: string;
  if (typeof input === 'string') {
    if (input.length > maxBytes || utf8Length(input) > maxBytes) {
      throw new ICalLimitError(`input exceeds ${String(maxBytes)} bytes`);
    }
    text = input;
  } else {
    if (input.byteLength > maxBytes) throw new ICalLimitError(`input exceeds ${String(maxBytes)} bytes`);
    text = new TextDecoder('utf-8').decode(input);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** UTF-8 length of a string (lone surrogates count as the 3-byte U+FFFD they encode to). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * Split into logical lines: accepts CRLF, bare LF or bare CR as a line break (real-world exporters
 * send all three) and joins any physical line beginning with a space or HTAB onto the previous one,
 * removing exactly that one whitespace character. Empty logical lines are dropped.
 */
export function unfold(text: string, maxLines = Number.POSITIVE_INFINITY): LogicalLine[] {
  const physical = text.split(/\r\n|\n|\r/);
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  for (let i = 0; i < physical.length; i++) {
    const p = physical[i] ?? '';
    const first = p.charCodeAt(0);
    if ((first === 0x20 || first === 0x09) && current !== null) {
      current.text += p.slice(1);
      continue;
    }
    if (current !== null && current.text !== '') out.push(current);
    if (out.length > maxLines) throw new ICalLimitError(`more than ${String(maxLines)} content lines`);
    if (first === 0x20 || first === 0x09) {
      // A continuation with nothing to continue: RFC 5545 has no meaning for it.
      if (p.trim() === '') {
        current = null;
        continue;
      }
      throw new ICalParseError('folded continuation line with no line before it', i + 1);
    }
    current = { text: p, line: i + 1 };
  }
  if (current !== null && current.text !== '') out.push(current);
  if (out.length > maxLines) throw new ICalLimitError(`more than ${String(maxLines)} content lines`);
  return out;
}

/**
 * Fold one logical line so no physical line exceeds {@link FOLD_OCTETS} octets (excluding CRLF),
 * never splitting a UTF-8 sequence or a surrogate pair. Continuations start with a single space.
 */
export function fold(line: string, maxOctets = FOLD_OCTETS): string {
  if (maxOctets < 5) throw new RangeError('fold width must be at least 5 octets');
  const parts: string[] = [];
  let start = 0;
  let octets = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    let width: number;
    let units = 1;
    if (c < 0x80) width = 1;
    else if (c < 0x800) width = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < line.length && isLowSurrogate(line.charCodeAt(i + 1))) {
      width = 4;
      units = 2;
    } else width = 3;
    // A continuation line spends one octet on its leading space.
    const limit = parts.length === 0 ? maxOctets : maxOctets - 1;
    if (octets + width > limit) {
      parts.push(line.slice(start, i));
      start = i;
      octets = 0;
    }
    octets += width;
    i += units;
  }
  parts.push(line.slice(start));
  return parts.join('\r\n ');
}

export interface ContentLineOptions {
  /** vCard: allow a `group.` prefix on the name. */
  groups?: boolean;
  /** vCard 2.1/3.0 tolerance: a parameter with no `=` is a TYPE value (`TEL;WORK;VOICE:`). */
  bareParamsAreTypes?: boolean;
}

export interface ParsedContentLine extends ContentLine {
  group: string | null;
}

/** Parse one unfolded content line: `[group.]name *(";" param) ":" value`. */
export function parseContentLine(text: string, lineNo: number, options: ContentLineOptions = {}): ParsedContentLine {
  let i = 0;
  let group: string | null = null;
  const nameStart = i;
  while (i < text.length && (NAME_CHAR.test(text[i] ?? '') || (options.groups === true && text[i] === '.'))) i++;
  let name = text.slice(nameStart, i);
  if (options.groups === true) {
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      group = name.slice(0, dot);
      name = name.slice(dot + 1);
      if (group === '' || group.includes('.')) throw new ICalParseError(`malformed group in "${clip(text)}"`, lineNo);
    }
  }
  if (name === '') throw new ICalParseError(`content line has no name: "${clip(text)}"`, lineNo);
  name = name.toUpperCase();
  const params: Params = {};
  while (text[i] === ';') {
    i++;
    const pStart = i;
    while (i < text.length && NAME_CHAR.test(text[i] ?? '')) i++;
    const pname = text.slice(pStart, i).toUpperCase();
    if (pname === '') throw new ICalParseError(`empty parameter name in "${clip(text)}"`, lineNo);
    if (text[i] !== '=') {
      if (options.bareParamsAreTypes === true && (text[i] === ';' || text[i] === ':')) {
        addParam(params, 'TYPE', [text.slice(pStart, i)]);
        continue;
      }
      throw new ICalParseError(`parameter ${pname} has no "="`, lineNo);
    }
    i++;
    const values: string[] = [];
    for (;;) {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (close < 0) throw new ICalParseError(`unterminated quoted value for ${pname}`, lineNo);
        values.push(decodeParamValue(text.slice(i + 1, close)));
        i = close + 1;
      } else {
        const vStart = i;
        while (i < text.length && text[i] !== ';' && text[i] !== ':' && text[i] !== ',') i++;
        values.push(decodeParamValue(text.slice(vStart, i)));
      }
      if (text[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    if (text[i] !== ';' && text[i] !== ':') throw new ICalParseError(`junk after the value of ${pname}`, lineNo);
    addParam(params, pname, values);
  }
  if (text[i] !== ':') throw new ICalParseError(`content line has no ":" before its value: "${clip(text)}"`, lineNo);
  return { group, name, params, value: text.slice(i + 1) };
}

function addParam(params: Params, name: string, values: string[]): void {
  const existing = params[name];
  if (existing === undefined) params[name] = values;
  else existing.push(...values);
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** RFC 6868: `^n` → newline, `^^` → `^`, `^'` → `"`; any other `^x` is left alone. */
export function decodeParamValue(s: string): string {
  if (!s.includes('^')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '^' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n' || n === 'N') {
        out += '\n';
        i++;
        continue;
      }
      if (n === '^') {
        out += '^';
        i++;
        continue;
      }
      if (n === "'") {
        out += '"';
        i++;
        continue;
      }
    }
    out += c ?? '';
  }
  return out;
}

/** RFC 6868 encoding plus DQUOTE-quoting when the value holds `;`, `:` or `,`. */
export function encodeParamValue(s: string): string {
  const escaped = s.replace(/\^/g, '^^').replace(/\r\n|\r|\n/g, '^n').replace(/"/g, "^'");
  return /[;:,]/.test(escaped) ? `"${escaped}"` : escaped;
}

/** Serialise one content line (unfolded). Throws if the raw value contains a line break. */
export function formatContentLine(line: ContentLine, group: string | null = null): string {
  if (/[\r\n]/.test(line.value)) {
    throw new ICalError(`value of ${line.name} contains a raw line break; escape it as TEXT first`);
  }
  let out = group === null ? line.name : `${group}.${line.name}`;
  for (const [name, values] of Object.entries(line.params)) {
    out += `;${name}=${values.map(encodeParamValue).join(',')}`;
  }
  return `${out}:${line.value}`;
}

/** TEXT escaping (§3.3.11): backslash, semicolon, comma and newlines. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Inverse of {@link escapeText}. An unknown escape `\x` is kept verbatim (lossless). */
export function unescapeText(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      i++;
      if (n === 'n' || n === 'N') out += '\n';
      else if (n === '\\' || n === ';' || n === ',') out += n;
      else out += `\\${n ?? ''}`;
      continue;
    }
    out += c ?? '';
  }
  return out;
}

/** Split on `sep` wherever it is not backslash-escaped. Escapes are left in place. */
export function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '\\' && i + 1 < s.length) {
      cur += `${c}${s[i + 1] ?? ''}`;
      i++;
      continue;
    }
    if (c === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
