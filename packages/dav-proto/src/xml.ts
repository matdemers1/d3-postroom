// A small, strict XML 1.0 + Namespaces parser for request bodies (PROPFIND, PROPPATCH, REPORT,
// MKCALENDAR, extended MKCOL). Hand-rolled on purpose: what a DAV server needs is a tiny subset of
// XML, and the dangerous parts of XML are the parts we do not need.
//
// What it refuses, always, with no option to turn it back on:
//   - any DOCTYPE, ENTITY, ELEMENT, ATTLIST or NOTATION declaration (XmlError code `dtd`). Without a
//     DTD there is no external entity to fetch (XXE) and no entity to expand exponentially
//     (billion laughs): the only entity references that exist are the five predefined ones and
//     numeric character references.
//   - an undeclared namespace prefix, a rebound `xml`/`xmlns` prefix, `xmlns:p=""`.
//   - characters XML does not allow, lone surrogates, malformed UTF-8, an encoding other than UTF-8.
//   - more than `maxBytes` of input, `maxDepth` of nesting, `maxNodes` nodes, `maxAttributes` on
//     one element.
//
// What it keeps: elements (by namespace URI and local name, never by prefix), attributes, and text.
// Adjacent text and CDATA merge into one string. Comments and processing instructions are dropped.
// Line endings are normalised to LF, as XML requires; a CR a client wants kept must be sent as &#13;.
import { XmlError } from './errors.js';
import { NS } from './ns.js';

export interface XmlAttribute {
  /** Namespace URI; '' for an unprefixed attribute (which is in no namespace). */
  ns: string;
  local: string;
  value: string;
}

export interface XmlElement {
  /** Namespace URI; '' when the element is in no namespace. */
  ns: string;
  local: string;
  attrs: XmlAttribute[];
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface XmlParseOptions {
  /** Maximum input size in bytes (UTF-8). Default 1 MiB. */
  maxBytes?: number;
  /** Maximum element nesting. Default 64. */
  maxDepth?: number;
  /** Maximum elements + text nodes. Default 50 000. */
  maxNodes?: number;
  /** Maximum attributes (namespace declarations included) on one element. Default 64. */
  maxAttributes?: number;
}

export const DEFAULT_MAX_XML_BYTES = 1024 * 1024;
export const DEFAULT_MAX_XML_DEPTH = 64;
export const DEFAULT_MAX_XML_NODES = 50_000;
export const DEFAULT_MAX_XML_ATTRIBUTES = 64;

// XML 1.0 (5th ed.) §2.3 NameStartChar / NameChar, BMP ranges plus any surrogate pair (#x10000-#xEFFFF).
const START = 'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const REST = `${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PAIR = '[\\uD800-\\uDB7F][\\uDC00-\\uDFFF]';
/** An NCName (no colon). */
const NCNAME = `(?:[${START}]|${PAIR})(?:[${REST}]|${PAIR})*`;
// eslint-disable-next-line no-misleading-character-class -- combining marks are NameChars, by design
const NCNAME_RE = new RegExp(`^${NCNAME}$`);
// eslint-disable-next-line no-misleading-character-class -- as above
const QNAME_STICKY = new RegExp(`${NCNAME}(?::${NCNAME})?`, 'y');
// eslint-disable-next-line no-misleading-character-class -- as above
const PI_TARGET_STICKY = new RegExp(NCNAME, 'y');

// Characters XML 1.0 does not allow anywhere (§2.2), and lone surrogates.
// eslint-disable-next-line no-control-regex
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when `name` is a valid NCName (a local name or a prefix). */
export function isNcName(name: string): boolean {
  return NCNAME_RE.test(name);
}

/** True when `cp` is a character XML 1.0 allows (§2.2 Char). */
export function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function decode(input: string | Uint8Array, maxBytes: number): string {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maxBytes) throw new XmlError('limit', `body larger than ${String(maxBytes)} bytes`);
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
  }
  if (input.length > maxBytes) throw new XmlError('limit', `body larger than ${String(maxBytes)} bytes`);
  // UTF-16 is the only other encoding XML parsers must support; a DAV client never sends it.
  if (input.length >= 2 && ((input[0] === 0xfe && input[1] === 0xff) || (input[0] === 0xff && input[1] === 0xfe))) {
    throw new XmlError('encoding', 'only UTF-8 is accepted');
  }
  try {
    // Strips a UTF-8 BOM; `fatal` refuses malformed sequences and encoded surrogates.
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new XmlError('encoding', 'body is not valid UTF-8');
  }
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

interface Scope {
  /** prefix → URI; '' is the default namespace. */
  readonly bindings: Map<string, string>;
  readonly parent: Scope | null;
}

function lookup(scope: Scope | null, prefix: string): string | undefined {
  for (let s = scope; s !== null; s = s.parent) {
    const uri = s.bindings.get(prefix);
    if (uri !== undefined) return uri;
  }
  if (prefix === 'xml') return NS.XML;
  if (prefix === '') return '';
  return undefined;
}

interface OpenElement {
  readonly qname: string;
  readonly element: XmlElement;
  readonly scope: Scope;
  /** Text gathered since the last child element, merged into one node when it ends. */
  text: string;
}

class Parser {
  private pos = 0;
  private nodes = 0;

  constructor(
    private readonly src: string,
    private readonly maxDepth: number,
    private readonly maxNodes: number,
    private readonly maxAttributes: number,
  ) {}

  private fail(code: 'syntax' | 'namespace' | 'dtd' | 'entity' | 'limit', message: string): never {
    throw new XmlError(code, message, this.pos);
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private skipSpace(): boolean {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a) break;
      this.pos++;
    }
    return this.pos > start;
  }

  private countNode(): void {
    this.nodes++;
    if (this.nodes > this.maxNodes) this.fail('limit', `more than ${String(this.maxNodes)} nodes`);
  }

  private qname(): string {
    QNAME_STICKY.lastIndex = this.pos;
    const m = QNAME_STICKY.exec(this.src);
    if (m === null) this.fail('syntax', 'expected a name');
    this.pos += m[0].length;
    return m[0];
  }

  /** `<!--` … `-->`, positioned after `<!--`. */
  private comment(): void {
    const end = this.src.indexOf('--', this.pos);
    if (end < 0) this.fail('syntax', 'unterminated comment');
    if (this.src[end + 2] !== '>') {
      this.pos = end;
      this.fail('syntax', "'--' inside a comment");
    }
    this.pos = end + 3;
  }

  /** `<?target …?>`, positioned after `<?`. The `<?xml` declaration is handled by the caller. */
  private processingInstruction(): void {
    PI_TARGET_STICKY.lastIndex = this.pos;
    const m = PI_TARGET_STICKY.exec(this.src);
    if (m === null) this.fail('syntax', 'processing instruction without a target');
    if (m[0].toLowerCase() === 'xml') this.fail('syntax', 'XML declaration not at the start of the document');
    this.pos += m[0].length;
    const end = this.src.indexOf('?>', this.pos);
    if (end < 0) this.fail('syntax', 'unterminated processing instruction');
    if (end > this.pos && !this.skipSpace()) this.fail('syntax', 'processing instruction target not followed by space');
    this.pos = end + 2;
  }

  /** Comments, PIs and whitespace outside the root. Refuses a DOCTYPE outright. */
  private misc(): void {
    for (;;) {
      this.skipSpace();
      if (this.startsWith('<!--')) {
        this.pos += 4;
        this.comment();
      } else if (this.startsWith('<?')) {
        this.pos += 2;
        this.processingInstruction();
      } else if (this.startsWith('<!')) {
        this.fail('dtd', 'document type declarations are not accepted');
      } else {
        return;
      }
    }
  }

  /** `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` at offset 0 only. */
  private xmlDeclaration(): void {
    if (!/^<\?xml[\t\n ]/.test(this.src.slice(0, 6))) return;
    const end = this.src.indexOf('?>');
    if (end < 0) this.fail('syntax', 'unterminated XML declaration');
    const body = this.src.slice(5, end);
    const decl = /^\s+version\s*=\s*(["'])1\.[0-9]+\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\4)?\s*$/.exec(body);
    if (decl === null) this.fail('syntax', 'malformed XML declaration');
    const encoding = decl[3];
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) throw new XmlError('encoding', `encoding ${encoding} is not accepted; send UTF-8`);
    this.pos = end + 2;
  }

  /** An entity or character reference, positioned on `&`. */
  private reference(): string {
    const end = this.src.indexOf(';', this.pos);
    if (end < 0 || end - this.pos > 12) this.fail('entity', 'unterminated entity reference');
    const name = this.src.slice(this.pos + 1, end);
    let out: string;
    if (name.startsWith('#x')) {
      if (!/^#x[0-9A-Fa-f]{1,6}$/.test(name)) this.fail('entity', 'malformed character reference');
      out = this.charFromCode(parseInt(name.slice(2), 16));
    } else if (name.startsWith('#')) {
      if (!/^#[0-9]{1,7}$/.test(name)) this.fail('entity', 'malformed character reference');
      out = this.charFromCode(parseInt(name.slice(1), 10));
    } else {
      const v = PREDEFINED[name];
      if (v === undefined) this.fail('entity', `undefined entity &${name.slice(0, 20)};`);
      out = v;
    }
    this.pos = end + 1;
    return out;
  }

  private charFromCode(cp: number): string {
    if (!isXmlChar(cp)) this.fail('entity', `character reference to a character XML does not allow (U+${cp.toString(16)})`);
    return String.fromCodePoint(cp);
  }

  private attributeValue(): string {
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") this.fail('syntax', 'attribute value must be quoted');
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) this.fail('syntax', 'unterminated attribute value');
      const c = this.src.charAt(this.pos);
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === '<') this.fail('syntax', "'<' in an attribute value");
      if (c === '&') {
        out += this.reference();
        continue;
      }
      // §3.3.3 attribute-value normalisation (CDATA type): whitespace characters become spaces.
      out += c === '\t' || c === '\n' ? ' ' : c;
      this.pos++;
    }
  }

  /** Positioned after `<`. Returns the opened element, or null for an empty-element tag. */
  private startTag(parentScope: Scope | null, depth: number): { open: OpenElement; empty: boolean } {
    if (depth > this.maxDepth) this.fail('limit', `elements nested deeper than ${String(this.maxDepth)}`);
    this.countNode();
    const qname = this.qname();
    const raw: { qname: string; value: string }[] = [];
    for (;;) {
      const spaced = this.skipSpace();
      if (this.startsWith('/>') || this.startsWith('>')) break;
      if (!spaced) this.fail('syntax', 'attributes must be separated by whitespace');
      const name = this.qname();
      this.skipSpace();
      if (this.src[this.pos] !== '=') this.fail('syntax', `attribute ${name} without a value`);
      this.pos++;
      this.skipSpace();
      const value = this.attributeValue();
      if (raw.some((a) => a.qname === name)) this.fail('syntax', `duplicate attribute ${name}`);
      raw.push({ qname: name, value });
      if (raw.length > this.maxAttributes) this.fail('limit', `more than ${String(this.maxAttributes)} attributes`);
    }
    const empty = this.startsWith('/>');
    this.pos += empty ? 2 : 1;

    // Namespace declarations first: they apply to the element's own name and attributes.
    const bindings = new Map<string, string>();
    for (const a of raw) {
      if (a.qname === 'xmlns') {
        if (a.value === NS.XML || a.value === NS.XMLNS) this.fail('namespace', `the default namespace cannot be ${a.value}`);
        bindings.set('', a.value);
      } else if (a.qname.startsWith('xmlns:')) {
        const prefix = a.qname.slice(6);
        if (prefix === 'xmlns') this.fail('namespace', 'the xmlns prefix cannot be declared');
        if (prefix === 'xml' ? a.value !== NS.XML : a.value === NS.XML) this.fail('namespace', 'the xml prefix is bound to its own namespace only');
        if (a.value === NS.XMLNS) this.fail('namespace', 'the xmlns namespace cannot be bound');
        if (a.value === '') this.fail('namespace', `xmlns:${prefix}="" is not allowed in XML 1.0`);
        bindings.set(prefix, a.value);
      }
    }
    const scope: Scope = { bindings, parent: parentScope };
    const resolve = (name: string, isAttribute: boolean): { ns: string; local: string } => {
      const colon = name.indexOf(':');
      if (colon < 0) return { ns: isAttribute ? '' : (lookup(scope, '') ?? ''), local: name };
      const prefix = name.slice(0, colon);
      const uri = lookup(scope, prefix);
      if (uri === undefined) this.fail('namespace', `undeclared prefix ${prefix}`);
      return { ns: uri, local: name.slice(colon + 1) };
    };

    const { ns, local } = resolve(qname, false);
    const attrs: XmlAttribute[] = [];
    const seen = new Set<string>();
    for (const a of raw) {
      if (a.qname === 'xmlns' || a.qname.startsWith('xmlns:')) continue;
      const r = resolve(a.qname, true);
      const key = `{${r.ns}}${r.local}`;
      if (seen.has(key)) this.fail('namespace', `duplicate attribute ${key}`);
      seen.add(key);
      attrs.push({ ns: r.ns, local: r.local, value: a.value });
    }
    return { open: { qname, element: { ns, local, attrs, children: [] }, scope, text: '' }, empty };
  }

  private flushText(open: OpenElement): void {
    if (open.text !== '') {
      this.countNode();
      open.element.children.push(open.text);
      open.text = '';
    }
  }

  parse(): XmlElement {
    if (BAD_CHAR.test(this.src)) {
      const m = BAD_CHAR.exec(this.src);
      this.pos = m?.index ?? 0;
      this.fail('syntax', 'character not allowed in XML');
    }
    this.xmlDeclaration();
    this.misc();
    if (this.src[this.pos] !== '<') this.fail('syntax', this.pos >= this.src.length ? 'no root element' : 'content before the root element');
    this.pos++;
    const first = this.startTag(null, 1);
    const root = first.open.element;
    if (!first.empty) this.content(first.open);
    this.misc();
    if (this.pos < this.src.length) this.fail('syntax', 'content after the root element');
    return root;
  }

  /** The content of `rootOpen` up to and including its end tag, iteratively (no recursion). */
  private content(rootOpen: OpenElement): void {
    const stack: OpenElement[] = [rootOpen];
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) return;
      if (this.pos >= this.src.length) this.fail('syntax', `unclosed element ${top.qname}`);
      const lt = this.src.indexOf('<', this.pos);
      const amp = this.src.indexOf('&', this.pos);
      const stop = Math.min(lt < 0 ? this.src.length : lt, amp < 0 ? this.src.length : amp);
      if (stop > this.pos) {
        const chunk = this.src.slice(this.pos, stop);
        if (chunk.includes(']]>')) {
          this.pos += chunk.indexOf(']]>');
          this.fail('syntax', "']]>' in text");
        }
        top.text += chunk;
        this.pos = stop;
        continue;
      }
      if (this.src[this.pos] === '&') {
        top.text += this.reference();
        continue;
      }
      // At '<'.
      if (this.startsWith('</')) {
        this.pos += 2;
        const name = this.qname();
        this.skipSpace();
        if (this.src[this.pos] !== '>') this.fail('syntax', 'malformed end tag');
        if (name !== top.qname) this.fail('syntax', `end tag ${name} does not match ${top.qname}`);
        this.pos++;
        this.flushText(top);
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.element.children.push(top.element);
        continue;
      }
      if (this.startsWith('<!--')) {
        this.pos += 4;
        this.comment();
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        const end = this.src.indexOf(']]>', this.pos + 9);
        if (end < 0) this.fail('syntax', 'unterminated CDATA section');
        top.text += this.src.slice(this.pos + 9, end);
        this.pos = end + 3;
        continue;
      }
      if (this.startsWith('<!')) this.fail('dtd', 'markup declarations are not accepted');
      if (this.startsWith('<?')) {
        this.pos += 2;
        this.processingInstruction();
        continue;
      }
      this.pos++;
      this.flushText(top);
      const child = this.startTag(top.scope, stack.length + 1);
      if (child.empty) top.element.children.push(child.open.element);
      else stack.push(child.open);
    }
  }
}

/**
 * Parse one XML document into its root element. Throws only {@link XmlError}.
 */
export function parseXml(input: string | Uint8Array, options: XmlParseOptions = {}): XmlElement {
  const text = decode(input, options.maxBytes ?? DEFAULT_MAX_XML_BYTES);
  // §2.11: CRLF and lone CR become LF before parsing.
  const normalised = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  return new Parser(
    normalised,
    options.maxDepth ?? DEFAULT_MAX_XML_DEPTH,
    options.maxNodes ?? DEFAULT_MAX_XML_NODES,
    options.maxAttributes ?? DEFAULT_MAX_XML_ATTRIBUTES,
  ).parse();
}

// ---- Tree helpers ----

/** A new element. */
export function el(ns: string, local: string, children: XmlNode[] = [], attrs: XmlAttribute[] = []): XmlElement {
  return { ns, local, attrs, children };
}

/** True when `node` is an element named `{ns}local`. */
export function isElement(node: XmlNode | undefined, ns?: string, local?: string): node is XmlElement {
  if (node === undefined || typeof node === 'string') return false;
  return (ns === undefined || node.ns === ns) && (local === undefined || node.local === local);
}

/** Child elements, optionally only those named `{ns}local`. Text is skipped. */
export function childElements(parent: XmlElement, ns?: string, local?: string): XmlElement[] {
  return parent.children.filter((c): c is XmlElement => isElement(c, ns, local));
}

/** The first child element named `{ns}local`. */
export function childElement(parent: XmlElement, ns: string, local: string): XmlElement | undefined {
  return parent.children.find((c): c is XmlElement => isElement(c, ns, local));
}

/** The concatenated text content of an element and its descendants. */
export function textContent(node: XmlElement): string {
  let out = '';
  const stack: XmlNode[] = [...node.children].reverse();
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (typeof n === 'string') out += n;
    else for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as XmlNode);
  }
  return out;
}

/** The value of an unprefixed (or `{ns}`) attribute. */
export function attribute(element: XmlElement, local: string, ns = ''): string | undefined {
  return element.attrs.find((a) => a.ns === ns && a.local === local)?.value;
}
