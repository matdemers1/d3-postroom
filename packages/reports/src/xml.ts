// A small, strict XML reader for report bodies (PST-T-7.1, PST-REQ-122) — hand-rolled, no library.
//
// What it accepts is exactly what an aggregate report needs: an optional XML declaration, comments,
// processing instructions (skipped), elements with attributes, character data, CDATA sections, the
// five predefined entities and character references. What it refuses is everything that makes XML
// dangerous to parse:
//   \u00B7 any DOCTYPE — so there is no internal subset, no external entity (XXE) and no entity
//     expansion ("billion laughs") to defend against in the first place;
//   \u00B7 any entity reference other than &lt; &gt; &amp; &quot; &apos; and &#N; / &#xH;;
//   \u00B7 input over `maxBytes`, nesting over `maxDepth`, more than `maxNodes` elements or
//     `maxAttributes` attributes on one element.
// It is iterative (an explicit stack, no recursion), so depth costs heap, not call stack. Every
// failure is a ReportError; nothing else is ever thrown for any input.
import { ReportError } from './errors.js';

export interface XmlElement {
  /** The qualified name as written (`dmarc:record` or `record`). */
  readonly name: string;
  /** The local part: the name after any prefix. Report readers match on this. */
  readonly local: string;
  /** Attribute values by qualified name (null-prototype: `__proto__` is just a name here). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** This element's own character data (text and CDATA, not its children's), entity-decoded. */
  readonly text: string;
}

export interface XmlParseOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxAttributes?: number;
}

export const DEFAULT_MAX_XML_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_XML_DEPTH = 32;
export const DEFAULT_MAX_XML_NODES = 1_000_000;
export const DEFAULT_MAX_XML_ATTRIBUTES = 32;

interface MutableElement {
  name: string;
  local: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
}

const NAME = /[A-Za-z_:\u00C0-\uFFFF][A-Za-z0-9_:.\-\u00B7\u00C0-\uFFFF]*/y;
const SPACE = /[ \t\n]*/y;
// Code points XML 1.0 forbids anywhere in a document (after line-end normalisation, so no \r), and
// lone surrogates, which a JS string can hold and UTF-8 cannot.
// eslint-disable-next-line no-control-regex -- matching the control characters XML forbids is the point
const FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ALLOWED_ENCODINGS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

function syntax(message: string, at: number): never {
  throw new ReportError('xml-syntax', `${message} at offset ${String(at)}`);
}

export function isXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/** Decodes the five predefined entities and character references; anything else is refused. */
export function decodeEntities(raw: string, at = 0): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let pos = 0;
  for (;;) {
    const amp = raw.indexOf('&', pos);
    if (amp === -1) break;
    out += raw.slice(pos, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) syntax('an "&" that does not start a reference', at + amp);
    const ref = raw.slice(amp + 1, semi);
    switch (ref) {
      case 'lt':
        out += '<';
        break;
      case 'gt':
        out += '>';
        break;
      case 'amp':
        out += '&';
        break;
      case 'quot':
        out += '"';
        break;
      case 'apos':
        out += "'";
        break;
      default: {
        let cp: number;
        if (/^#[0-9]{1,7}$/.test(ref)) cp = Number.parseInt(ref.slice(1), 10);
        else if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) cp = Number.parseInt(ref.slice(2), 16);
        else throw new ReportError('unknown-entity', `entity "&${ref.slice(0, 12)};" is not one of the five predefined entities`);
        if (!isXmlChar(cp)) syntax(`character reference to U+${cp.toString(16)} is not an XML character`, at + amp);
        out += String.fromCodePoint(cp);
      }
    }
    pos = semi + 1;
  }
  return out + raw.slice(pos);
}

function decodeInput(input: string | Uint8Array, maxBytes: number): string {
  if (typeof input === 'string') {
    if (input.length > maxBytes) throw new ReportError('too-large', `XML is over ${String(maxBytes)} characters`);
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
  }
  if (input.byteLength > maxBytes) throw new ReportError('too-large', `XML is over ${String(maxBytes)} bytes`);
  let bytes = input;
  if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) {
    throw new ReportError('unsupported-encoding', 'UTF-16 XML is not supported');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReportError('xml-syntax', 'XML is not valid UTF-8');
  }
}

/** Parses one XML document into an element tree. Throws ReportError, and only ReportError. */
export function parseXml(input: string | Uint8Array, options: XmlParseOptions = {}): XmlElement {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_XML_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_XML_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_XML_NODES;
  const maxAttributes = options.maxAttributes ?? DEFAULT_MAX_XML_ATTRIBUTES;

  // XML 1.0 §2.11: every CRLF and lone CR is read as LF.
  const src = decodeInput(input, maxBytes).replace(/\r\n?/g, '\n');
  const bad = FORBIDDEN_CHAR.exec(src);
  if (bad !== null) syntax('a character XML does not allow', bad.index);

  let i = 0;
  let nodes = 0;

  const skipSpace = (): void => {
    SPACE.lastIndex = i;
    SPACE.exec(src);
    i = SPACE.lastIndex;
  };
  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (m === null) syntax('expected a name', i);
    i = NAME.lastIndex;
    return m[0];
  };
  const skipComment = (): void => {
    // at "<!--"
    const end = src.indexOf('-->', i + 4);
    if (end === -1) syntax('unterminated comment', i);
    if (src.slice(i + 4, end).includes('--')) syntax('"--" inside a comment', i);
    i = end + 3;
  };
  const skipPi = (): void => {
    // at "<?"
    i += 2;
    const target = readName();
    if (target.toLowerCase() === 'xml') syntax('an XML declaration that is not at the start', i);
    const end = src.indexOf('?>', i);
    if (end === -1) syntax('unterminated processing instruction', i);
    i = end + 2;
  };
  const refuseBang = (): never => {
    if (src.startsWith('<!DOCTYPE', i)) throw new ReportError('dtd-refused', 'a DOCTYPE is refused (no DTDs, no entities, no XXE)');
    if (src.startsWith('<!ENTITY', i) || src.startsWith('<!ELEMENT', i) || src.startsWith('<!ATTLIST', i)) {
      throw new ReportError('dtd-refused', 'markup declarations are refused');
    }
    syntax('unexpected "<!"', i);
  };

  // The XML declaration: only at the very start, and only an encoding we can honestly read.
  if (src.startsWith('<?xml') && /[ \t\n?]/.test(src[5] ?? '')) {
    const end = src.indexOf('?>');
    if (end === -1) syntax('unterminated XML declaration', 0);
    const decl = src.slice(5, end);
    const enc = /encoding\s*=\s*["']([^"']*)["']/.exec(decl);
    if (enc !== null && !ALLOWED_ENCODINGS.has((enc[1] ?? '').toLowerCase())) {
      throw new ReportError('unsupported-encoding', `XML declares encoding "${(enc[1] ?? '').slice(0, 40)}"`);
    }
    i = end + 2;
  }

  // Prolog: whitespace, comments and processing instructions up to the root element.
  for (;;) {
    skipSpace();
    if (i >= src.length) syntax('no root element', i);
    if (src.startsWith('<!--', i)) skipComment();
    else if (src.startsWith('<?', i)) skipPi();
    else if (src.startsWith('<!', i)) refuseBang();
    else if (src[i] === '<') break;
    else syntax('text before the root element', i);
  }

  const stack: MutableElement[] = [];
  let root: MutableElement | null = null;

  const openTag = (): void => {
    // at "<" + name
    const at = i;
    i += 1;
    const name = readName();
    const colon = name.lastIndexOf(':');
    const el: MutableElement = { name, local: colon === -1 ? name : name.slice(colon + 1), attributes: Object.create(null) as Record<string, string>, children: [], text: '' };
    if (++nodes > maxNodes) throw new ReportError('too-many', `more than ${String(maxNodes)} elements`);
    let count = 0;
    for (;;) {
      const before = i;
      skipSpace();
      const c = src[i];
      if (c === '>' || c === '/') break;
      if (c === undefined) syntax('unterminated start tag', at);
      if (i === before) syntax('expected whitespace before an attribute', i);
      const attr = readName();
      skipSpace();
      if (src[i] !== '=') syntax('expected "=" after an attribute name', i);
      i++;
      skipSpace();
      const q = src[i];
      if (q !== '"' && q !== "'") syntax('expected a quoted attribute value', i);
      const close = src.indexOf(q, i + 1);
      if (close === -1) syntax('unterminated attribute value', i);
      const raw = src.slice(i + 1, close);
      if (raw.includes('<')) syntax('"<" inside an attribute value', i);
      if (Object.hasOwn(el.attributes, attr)) syntax(`duplicate attribute "${attr}"`, i);
      if (++count > maxAttributes) throw new ReportError('too-many', `more than ${String(maxAttributes)} attributes on one element`);
      el.attributes[attr] = decodeEntities(raw, i + 1).replace(/[\t\n]/g, ' ');
      i = close + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(el);
    else root = el;
    if (src[i] === '/') {
      if (src[i + 1] !== '>') syntax('expected "/>"', i);
      i += 2;
      return;
    }
    i += 1; // '>'
    if (stack.length + 1 > maxDepth) throw new ReportError('too-deep', `elements nested deeper than ${String(maxDepth)}`);
    stack.push(el);
  };

  openTag();
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as MutableElement;
    const lt = src.indexOf('<', i);
    if (lt === -1) syntax(`unclosed element "${top.name}"`, i);
    if (lt > i) {
      const raw = src.slice(i, lt);
      if (raw.includes(']]>')) syntax('"]]>" in character data', i);
      top.text += decodeEntities(raw, i);
      i = lt;
    }
    if (src.startsWith('</', i)) {
      i += 2;
      const name = readName();
      if (name !== top.name) syntax(`end tag "${name}" does not match "${top.name}"`, i);
      skipSpace();
      if (src[i] !== '>') syntax('expected ">"', i);
      i++;
      stack.pop();
    } else if (src.startsWith('<!--', i)) {
      skipComment();
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) syntax('unterminated CDATA section', i);
      top.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      skipPi();
    } else if (src.startsWith('<!', i)) {
      refuseBang();
    } else {
      openTag();
    }
  }

  // Epilog: nothing but whitespace, comments and processing instructions.
  for (;;) {
    skipSpace();
    if (i >= src.length) break;
    if (src.startsWith('<!--', i)) skipComment();
    else if (src.startsWith('<?', i)) skipPi();
    else syntax('content after the root element', i);
  }

  // Assigned inside openTag, which the compiler does not follow.
  const result = root as MutableElement | null;
  if (result === null) syntax('no root element', 0);
  return result;
}

/** Escapes text for element content or a double-quoted attribute. `\r` and tab survive a re-parse. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"'\r\t\n]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      case '\r':
        return '&#13;';
      case '\t':
        return '&#9;';
      default:
        return '&#10;';
    }
  });
}

/** The first child with this local name. */
export function child(el: XmlElement, local: string): XmlElement | undefined {
  return el.children.find((c) => c.local === local);
}

/** Every child with this local name. */
export function children(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c) => c.local === local);
}
