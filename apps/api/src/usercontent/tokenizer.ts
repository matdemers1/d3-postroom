// An HTML tokenizer for mail, after the HTML Living Standard §13.2.5 — enough of it to read what a
// browser would read as tags, attributes, comments and raw text, and tolerant of everything else.
// It never throws and never backtracks: one pass, yielding tokens as it goes, so a 4 MiB message is
// walked once. It does no tree construction; the sanitizer keeps its own stack.
//
// Where this reading and a browser's could disagree (foreign content, a `<noscript>` under scripting
// on or off), the difference cannot reach the reader: the browser only ever parses the sanitizer's
// OUTPUT, which is allowlisted tags with quoted, escaped attributes and escaped text.
import { decodeEntities } from './entities.js';

export type Token =
  | { type: 'text'; text: string }
  | { type: 'start'; name: string; attrs: [string, string][]; selfClosing: boolean }
  | { type: 'end'; name: string }
  /** The content of a raw-text element (script, style, textarea, …), undecoded. */
  | { type: 'raw'; name: string; text: string };

/** Elements whose content is not markup: everything up to the matching end tag is one raw token. */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

interface Tag {
  name: string;
  attrs: [string, string][];
  selfClosing: boolean;
  /** Index just past the tag's `>`; -1 when the input ended inside the tag (it is then dropped). */
  next: number;
}

function readTag(input: string, from: number): Tag {
  const n = input.length;
  let i = from;
  while (i < n && !isWs(input.charAt(i)) && input.charAt(i) !== '/' && input.charAt(i) !== '>') i++;
  const name = input.slice(from, i).toLowerCase().replace(/\0/g, '�');
  const attrs: [string, string][] = [];
  const seen = new Set<string>();
  const selfClosing = false;
  for (;;) {
    while (i < n && isWs(input.charAt(i))) i++;
    if (i >= n) return { name, attrs, selfClosing, next: -1 };
    const c = input.charAt(i);
    if (c === '>') return { name, attrs, selfClosing, next: i + 1 };
    if (c === '/') {
      if (input.charAt(i + 1) === '>') return { name, attrs, selfClosing: true, next: i + 2 };
      i++;
      continue;
    }
    // Attribute name. Its first character may be anything but whitespace, `/` or `>` — even `=`.
    const start = i;
    i++;
    while (i < n) {
      const d = input.charAt(i);
      if (isWs(d) || d === '/' || d === '>' || d === '=') break;
      i++;
    }
    const attrName = input.slice(start, i).toLowerCase();
    while (i < n && isWs(input.charAt(i))) i++;
    let value = '';
    if (input.charAt(i) === '=') {
      i++;
      while (i < n && isWs(input.charAt(i))) i++;
      const q = input.charAt(i);
      if (q === '"' || q === "'") {
        const end = input.indexOf(q, i + 1);
        if (end === -1) return { name, attrs, selfClosing, next: -1 };
        value = input.slice(i + 1, end);
        i = end + 1;
      } else if (q !== '>') {
        const s = i;
        while (i < n && !isWs(input.charAt(i)) && input.charAt(i) !== '>') i++;
        value = input.slice(s, i);
      }
    }
    // The first of a repeated attribute wins (§13.2.5.33).
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push([attrName, decodeEntities(value, true)]);
    }
  }
}

/** Index of the next `>` at or after `from`, or the end of input. */
function skipTo(input: string, from: number): number {
  const gt = input.indexOf('>', from);
  return gt === -1 ? input.length : gt + 1;
}

function commentEnd(input: string, from: number): number {
  // `<!-->` and `<!--->` are complete (empty) comments.
  if (input.startsWith('>', from)) return from + 1;
  if (input.startsWith('->', from)) return from + 2;
  // One forward scan for `--`, then `>` or `!>` after it (two independent searches would each run
  // to the end of the input when one terminator is absent: quadratic over many comments).
  let at = input.indexOf('--', from);
  while (at !== -1) {
    if (input.charAt(at + 2) === '>') return at + 3;
    if (input.startsWith('!>', at + 2)) return at + 4;
    at = input.indexOf('--', at + 1);
  }
  return input.length;
}

export function* tokenize(input: string): Generator<Token> {
  const n = input.length;
  let i = 0;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      yield { type: 'text', text: decodeEntities(input.slice(i), false) };
      return;
    }
    if (lt > i) yield { type: 'text', text: decodeEntities(input.slice(i, lt), false) };
    i = lt;
    const c = input.charAt(i + 1);
    if (isAlpha(c)) {
      const tag = readTag(input, i + 1);
      if (tag.next === -1) return;
      i = tag.next;
      yield { type: 'start', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing };
      if (RAW_TEXT.has(tag.name)) {
        let end = n;
        if (tag.name !== 'plaintext') {
          const close = new RegExp(`</${tag.name}[\\t\\n\\f\\r />]`, 'gi');
          close.lastIndex = i;
          const m = close.exec(input);
          if (m !== null) end = m.index;
          else if (input.slice(-(tag.name.length + 2)).toLowerCase() === `</${tag.name}`) end = n - tag.name.length - 2;
        }
        yield { type: 'raw', name: tag.name, text: input.slice(i, end) };
        i = end;
      }
    } else if (c === '/') {
      const d = input.charAt(i + 2);
      if (isAlpha(d)) {
        const tag = readTag(input, i + 2);
        if (tag.next === -1) return;
        i = tag.next;
        yield { type: 'end', name: tag.name };
      } else if (d === '>') {
        i += 3;
      } else if (d === '') {
        yield { type: 'text', text: '</' };
        return;
      } else {
        i = skipTo(input, i + 2); // a bogus comment
      }
    } else if (c === '!') {
      i = input.startsWith('<!--', i) ? commentEnd(input, i + 4) : skipTo(input, i + 2);
    } else if (c === '?') {
      i = skipTo(input, i + 2);
    } else {
      yield { type: 'text', text: '<' };
      i++;
    }
  }
}
