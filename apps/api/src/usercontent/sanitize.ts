// The server-side HTML sanitizer for mail (PST-REQ-081, PST-REQ-082). Tokens in, allowlisted and
// re-serialised markup out — never the sender's bytes. What survives:
//
//   * elements on ALLOWED (text, layout, tables, lists, headings, links, images, font/center), with
//     their end tags balanced by our own stack; <body> becomes a <div> so its colours survive;
//   * attributes on ATTRIBUTES only — no on*, no srcset, no background, no formaction, nothing new;
//   * href: http(s), mailto, cid and in-page #fragments; every link opens in a new, unreferred tab;
//   * img src: data: images, cid: (resolved to the message's own part by the caller), and remote
//     http(s) ONLY through the caller's rewrite (the image proxy, once the reader asks) — otherwise a
//     blank placeholder with the address kept in data-src, so nothing leaves the browser;
//   * style attributes and <style> blocks through css.ts (no url(), no escapes, no @import).
//
// Everything else — script, style-with-expressions, iframe, object, embed, form, input, button,
// meta, base, link, svg, math — is gone, and svg/math/object/template/select/audio/video take their
// whole subtree with them. Text and attribute values are escaped, and additionally `=`, `javascript:`
// and `url(` are written as character references, so the output never contains those literals in any
// context (a property test holds us to that). Idempotent: sanitize(sanitize(x)) === sanitize(x).
import { sanitizeInlineStyle, sanitizeStylesheet } from './css.js';
import { RAW_TEXT, tokenize } from './tokenizer.js';

export interface SanitizeOptions {
  /**
   * A remote http(s) image the reader chose to load: return the URL to use instead (the image
   * proxy). Unset, or returning null, leaves the blocked placeholder.
   */
  remoteImage?: ((url: string) => string | null) | undefined;
  /** `cid:` image → a URL for that part of the same message; null drops the src. Unset keeps `cid:…`. */
  cidImage?: ((contentId: string) => string | null) | undefined;
}

export interface SanitizeResult {
  html: string;
  /** Remote images found (whether loaded through the proxy or blocked). */
  remoteImages: number;
  /** Remote images left blocked. */
  blockedImages: number;
}

/** A transparent 1×1 GIF: a blocked remote image keeps its box, and asks nothing of anyone. */
export const BLOCKED_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ALLOWED = new Set([
  'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
  'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);

const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Dropped with everything inside them. (Raw-text ones — script, iframe, … — go via the tokenizer.) */
const DROP_SUBTREE = new Set(['svg', 'math', 'object', 'applet', 'template', 'select', 'datalist', 'audio', 'video', 'picture', 'map', 'frameset', 'canvas', 'button', 'option', 'optgroup']);

/** Attributes any allowed element may keep. None of them loads, runs or navigates. */
const ATTRIBUTES = new Set([
  'abbr', 'align', 'alt', 'axis', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'char', 'charoff',
  'class', 'clear', 'color', 'cols', 'colspan', 'compact', 'datetime', 'dir', 'face', 'frame', 'headers',
  'height', 'hspace', 'id', 'lang', 'name', 'noshade', 'nowrap', 'open', 'reversed', 'rows', 'rowspan',
  'rules', 'scope', 'size', 'span', 'start', 'style', 'summary', 'title', 'type', 'valign', 'value',
  'vspace', 'width',
]);

const MAX_DEPTH = 256;
const MAX_ATTRIBUTE = 8192;

// ---------------------------------------------------------------------------------------------
// Escaping

/** The literals that must never appear in the output, whatever the context. */
function neutralise(s: string): string {
  return s.replace(/(javascript):/gi, '$1&#58;').replace(/(url)\(/gi, '$1&#40;');
}

export function escapeText(s: string): string {
  return neutralise(s.replace(/\0/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/=/g, '&#61;'));
}

function escapeAttribute(s: string): string {
  return neutralise(
    s
      .replace(/\0/g, '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/=/g, '&#61;')
      .replace(/`/g, '&#96;'),
  );
}

// ---------------------------------------------------------------------------------------------
// URLs

/** What the URL parser would see: no tab/newline anywhere, no C0 control or space at either end. */
function cleanUrl(raw: string): string {
  return raw.replace(/[\t\n\r]/g, '').replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');
}

function schemeOf(url: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  return m?.[1] === undefined ? null : m[1].toLowerCase();
}

/** A remote image address, normalised; null when it is not http(s). `//host/x` is https. */
function remoteUrl(url: string): string | null {
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  const scheme = schemeOf(absolute);
  if (scheme !== 'http' && scheme !== 'https') return null;
  try {
    const parsed = new URL(absolute);
    return parsed.hostname === '' ? null : parsed.href;
  } catch {
    return null;
  }
}

export function safeHref(raw: string): string | null {
  const url = cleanUrl(raw);
  if (url === '' || url.length > MAX_ATTRIBUTE) return null;
  if (url.startsWith('#')) return url;
  const scheme = schemeOf(url);
  if (scheme === 'mailto' || scheme === 'cid') return url;
  if (scheme === 'http' || scheme === 'https' || url.startsWith('//')) return remoteUrl(url);
  return null;
}

const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|jpg|webp|bmp);base64,[A-Za-z0-9+/\s]*={0,2}$/i;

// ---------------------------------------------------------------------------------------------

type Attr = [string, string];

interface Counters {
  remote: number;
  blocked: number;
}

function imageAttributes(attrs: readonly Attr[], opts: SanitizeOptions, counts: Counters): Attr[] {
  const out: Attr[] = [];
  for (const [name, value] of attrs) {
    if (name === 'src') {
      const url = cleanUrl(value);
      if (DATA_IMAGE.test(url)) {
        out.push(['src', url.replace(/\s/g, '')]);
      } else if (schemeOf(url) === 'cid') {
        const cid = url.slice(4);
        if (opts.cidImage === undefined) out.push(['src', url]);
        else {
          const resolved = opts.cidImage(cid);
          if (resolved !== null) out.push(['src', resolved]);
        }
      } else {
        const remote = remoteUrl(url);
        if (remote === null) continue;
        counts.remote++;
        const via = opts.remoteImage?.(remote) ?? null;
        if (via !== null) out.push(['src', via]);
        else {
          counts.blocked++;
          out.push(['src', BLOCKED_IMAGE], ['data-src', remote]);
        }
      }
    } else if (name === 'data-src') {
      // Only ever our own record of a blocked address (so a second pass is a no-op).
      const remote = remoteUrl(cleanUrl(value));
      if (remote !== null) out.push(['data-src', remote]);
    } else {
      out.push([name, value]);
    }
  }
  return out;
}

function sanitizeAttributes(element: string, attrs: readonly Attr[], opts: SanitizeOptions, counts: Counters): string {
  const kept: Attr[] = [];
  const candidates = element === 'img' ? imageAttributes(attrs, opts, counts) : attrs;
  for (const [name, raw] of candidates) {
    let value = raw;
    if (value.length > MAX_ATTRIBUTE) continue;
    if (element === 'img' && (name === 'src' || name === 'data-src')) {
      kept.push([name, value]);
      continue;
    }
    if (element === 'a' && name === 'href') {
      const href = safeHref(value);
      if (href !== null) kept.push(['href', href]);
      continue;
    }
    if (!ATTRIBUTES.has(name)) continue;
    if (name === 'style') {
      value = sanitizeInlineStyle(value);
      if (value === '') continue;
    }
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    kept.push([name, value.replace(/[\0-\x08\x0b\x0e-\x1f\x7f]/g, '')]);
  }
  if (element === 'a') kept.push(['target', '_blank'], ['rel', 'noopener noreferrer']);
  const seen = new Set<string>();
  let out = '';
  for (const [name, value] of kept) {
    if (seen.has(name)) continue;
    seen.add(name);
    out += ` ${name}="${escapeAttribute(value)}"`;
  }
  return out;
}

export function sanitizeHtml(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  const out: string[] = [];
  const stack: string[] = [];
  const counts: Counters = { remote: 0, blocked: 0 };
  let skip: { name: string; depth: number } | null = null;
  /** The raw token that follows is the body of a <style> we opened. */
  let styleOpen = false;

  // Adjacent text (split by a tag we dropped) is escaped as one run, so `java<x>script:` cannot
  // become `javascript:` in the output — and a second pass sees exactly the same run.
  let text = '';
  const emit = (markup: string): void => {
    if (text !== '') {
      out.push(escapeText(text));
      text = '';
    }
    out.push(markup);
  };
  const close = (name: string): void => {
    const at = stack.lastIndexOf(name);
    if (at === -1) return;
    while (stack.length > at) emit(`</${stack.pop() ?? ''}>`);
  };

  for (const token of tokenize(input)) {
    if (skip !== null) {
      if (token.type === 'start' && token.name === skip.name && !token.selfClosing) skip.depth++;
      else if (token.type === 'end' && token.name === skip.name && --skip.depth === 0) skip = null;
      continue;
    }
    switch (token.type) {
      case 'text':
        text += token.text;
        break;
      case 'raw':
        if (styleOpen && token.name === 'style') emit(sanitizeStylesheet(token.text));
        styleOpen = false;
        break;
      case 'start': {
        styleOpen = false;
        const name = token.name === 'body' ? 'div' : token.name;
        if (DROP_SUBTREE.has(name)) {
          if (!token.selfClosing) skip = { name, depth: 1 };
          break;
        }
        if (!ALLOWED.has(name) || stack.length >= MAX_DEPTH) break;
        emit(`<${name}${sanitizeAttributes(name, token.attrs, opts, counts)}>`);
        if (!VOID.has(name)) stack.push(name);
        if (name === 'style') styleOpen = true;
        break;
      }
      case 'end': {
        const name = token.name === 'body' ? 'div' : token.name;
        if (RAW_TEXT.has(name) && name !== 'style') break;
        if (ALLOWED.has(name) && !VOID.has(name)) close(name);
        break;
      }
    }
  }
  while (stack.length > 0) emit(`</${stack.pop() ?? ''}>`);
  emit('');
  return { html: out.join(''), remoteImages: counts.remote, blockedImages: counts.blocked };
}
