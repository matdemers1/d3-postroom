// XML serializer for responses. Every namespace the tree uses is declared once, on the root, with
// the well-known prefixes (d:, cal:, card:, cs:, ical:) and generated ones (x0:, x1:, …) for the
// rest; nothing is ever put in a default namespace, so an unprefixed name is always in no namespace.
//
// Text is escaped so that a conforming parser gives back exactly the same string: `&`, `<`, `>`, and
// CR as `&#13;` (a raw CR would be normalised away, and calendar data is CRLF). Characters XML cannot
// carry at all (NUL and most C0 controls) are replaced with U+FFFD rather than emitted.
import { DavError } from './errors.js';
import { NS, PREFERRED_PREFIXES } from './ns.js';
import { isNcName, type XmlElement, type XmlNode } from './xml.js';

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape character data. */
export function escapeText(text: string): string {
  return text.replace(UNSAFE, '\uFFFD').replace(/[&<>\r]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;'));
}

/** Escape an attribute value for a double-quoted attribute. */
export function escapeAttribute(text: string): string {
  return text
    .replace(UNSAFE, '\uFFFD')
    .replace(/[&<>"\t\n\r]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : `&#${String(c.charCodeAt(0))};`,
    );
}

export interface SerializeOptions {
  /** Prefix `<?xml version="1.0" encoding="utf-8"?>`. Default true. */
  declaration?: boolean;
}

function collectNamespaces(root: XmlElement): string[] {
  const seen = new Set<string>();
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined || typeof n === 'string') continue;
    if (n.ns !== '') seen.add(n.ns);
    for (const a of n.attrs) if (a.ns !== '' && a.ns !== NS.XML) seen.add(a.ns);
    for (const c of n.children) stack.push(c);
  }
  return [...seen].sort();
}

/** Serialise a tree. Throws DavError for a name that is not an NCName. */
export function serializeXml(root: XmlElement, options: SerializeOptions = {}): string {
  const prefixes = new Map<string, string>();
  let generated = 0;
  const taken = new Set<string>();
  const namespaces = collectNamespaces(root);
  for (const ns of namespaces) {
    const preferred = PREFERRED_PREFIXES[ns];
    if (preferred !== undefined) {
      prefixes.set(ns, preferred);
      taken.add(preferred);
    }
  }
  for (const ns of namespaces) {
    if (prefixes.has(ns)) continue;
    let p: string;
    do p = `x${String(generated++)}`;
    while (taken.has(p));
    prefixes.set(ns, p);
    taken.add(p);
  }
  const qn = (ns: string, local: string): string => {
    if (!isNcName(local)) throw new DavError(`not an XML name: ${local.slice(0, 40)}`);
    if (ns === '') return local;
    if (ns === NS.XML) return `xml:${local}`;
    return `${prefixes.get(ns) ?? ''}:${local}`;
  };

  const out: string[] = [];
  if (options.declaration ?? true) out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  // Iterative: a deep tree must not overflow the stack.
  type Frame = { el: XmlElement; next: number; name: string };
  const open = (e: XmlElement, isRoot: boolean): Frame => {
    const name = qn(e.ns, e.local);
    let tag = `<${name}`;
    if (isRoot) for (const ns of namespaces) tag += ` xmlns:${prefixes.get(ns) ?? ''}="${escapeAttribute(ns)}"`;
    for (const a of e.attrs) tag += ` ${qn(a.ns, a.local)}="${escapeAttribute(a.value)}"`;
    if (e.children.length === 0) {
      out.push(`${tag}/>`);
      return { el: e, next: 0, name: '' };
    }
    out.push(`${tag}>`);
    return { el: e, next: 0, name };
  };
  const stack: Frame[] = [];
  const first = open(root, true);
  if (first.name !== '') stack.push(first);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const child = top.el.children[top.next];
    if (child === undefined) {
      out.push(`</${top.name}>`);
      stack.pop();
      continue;
    }
    top.next++;
    if (typeof child === 'string') {
      out.push(escapeText(child));
      continue;
    }
    const f = open(child, false);
    if (f.name !== '') stack.push(f);
  }
  return out.join('');
}
