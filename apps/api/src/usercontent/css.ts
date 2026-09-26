// CSS for mail: a conservative property allowlist and a value check, for inline `style` attributes
// and for `<style>` blocks. What is refused is anything that can fetch, run or escape:
// url() and every function but colour/arithmetic ones (so image-set(), expression(), element() go
// too), @import and every at-rule but @media, `behavior` and `-moz-binding` (not on the allowlist),
// backslash escapes (the usual way to spell `url(` without writing it), and `position` (an overlay).
// The output is a fixed point: sanitising it again gives the same text.

const PROPERTIES = new Set([
  'color', 'background-color', 'background', 'opacity',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-decoration-line',
  'text-decoration-color', 'text-decoration-style', 'text-transform', 'text-indent', 'text-overflow',
  'vertical-align', 'white-space', 'word-break', 'word-wrap', 'overflow-wrap', 'direction', 'unicode-bidi',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-collapse', 'border-spacing',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'box-sizing',
  'display', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y', 'visibility',
  'list-style-type', 'list-style-position', 'table-layout', 'caption-side', 'empty-cells',
]);

/** The only functions a value may call: colours and arithmetic. Nothing that names a resource. */
const FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp']);
/** Selector pseudo-classes that take an argument. */
const PSEUDO_FUNCTIONS = new Set(['not', 'is', 'where', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir']);

const MAX_VALUE = 500;

function functionsAllowed(text: string, allowed: ReadonlySet<string>): boolean {
  for (const m of text.matchAll(/([A-Za-z0-9_-]+)\(/g)) {
    if (!allowed.has((m[1] ?? '').toLowerCase())) return false;
  }
  return true;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A declaration value, or null to drop it. */
export function cssValue(raw: string): string | null {
  const value = collapse(raw);
  if (value === '' || value.length > MAX_VALUE) return null;
  // No escapes, no quoting tricks that end the attribute or block, no markup, no at-rules.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\<>{};=@`\0-\x08\x0b\x0e-\x1f\x7f]/.test(value)) return null;
  if (/expression|javascript|vbscript|behavior|binding|url\s*\(/i.test(value)) return null;
  if (!functionsAllowed(value, FUNCTIONS)) return null;
  return value;
}

/** `prop: value; …` → the allowed declarations, `; `-joined; '' when none survive. */
export function sanitizeDeclarations(block: string): string {
  const out: string[] = [];
  for (const piece of block.split(';')) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    const prop = collapse(piece.slice(0, colon)).toLowerCase();
    if (!PROPERTIES.has(prop)) continue;
    const value = cssValue(piece.slice(colon + 1));
    if (value === null) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');

/** A `style` attribute. */
export function sanitizeInlineStyle(style: string): string {
  const css = stripComments(style);
  if (css.includes('\\')) return '';
  return sanitizeDeclarations(css);
}

function safeSelector(raw: string): string | null {
  const sel = collapse(raw);
  if (sel === '' || sel.length > 1000) return null;
  // Type, class, id, combinators, pseudo-classes and bare attribute-presence selectors. No `=`,
  // quotes or escapes, so an attribute selector can never test a value (the CSS exfiltration trick).
  if (!/^[A-Za-z0-9\s.#,>+~*:_()[\]-]+$/.test(sel)) return null;
  if (!functionsAllowed(sel, PSEUDO_FUNCTIONS) || /javascript:/i.test(sel)) return null;
  return sel;
}

function safeMediaPrelude(raw: string): string | null {
  const p = collapse(raw);
  if (p.length > 500 || !/^[A-Za-z0-9\s(),:.-]*$/.test(p)) return null;
  if (!functionsAllowed(p, new Set()) || /javascript:/i.test(p)) return null;
  return p;
}

/** Index of the `}` closing the block opened just before `from` (or the end of input). */
function blockEnd(css: string, from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    const c = css.charAt(i);
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return css.length;
}

function rules(css: string, depth: number): string[] {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css.charAt(i))) i++;
    if (i >= n) break;
    if (css.charAt(i) === '}') {
      i++;
      continue;
    }
    const brace = css.indexOf('{', i);
    if (css.charAt(i) === '@') {
      // A statement at-rule (@import, @charset, @namespace): dropped.
      const semi = (brace === -1 ? css.slice(i) : css.slice(i, brace)).indexOf(';');
      if (semi !== -1) {
        i += semi + 1;
        continue;
      }
      if (brace === -1) break;
      const end = blockEnd(css, brace + 1);
      const header = /^@([A-Za-z-]+)([\s\S]*)$/.exec(css.slice(i, brace));
      if (header !== null && header[1]?.toLowerCase() === 'media' && depth < 2) {
        const prelude = safeMediaPrelude(header[2] ?? '');
        const inner = prelude === null ? [] : rules(css.slice(brace + 1, end), depth + 1);
        if (prelude !== null && inner.length > 0) out.push(`@media ${prelude}{${inner.join('')}}`);
      }
      i = end + 1;
      continue;
    }
    if (brace === -1) break;
    const end = blockEnd(css, brace + 1);
    const selector = safeSelector(css.slice(i, brace));
    const body = css.slice(brace + 1, end);
    if (selector !== null && !body.includes('{')) {
      const decls = sanitizeDeclarations(body);
      if (decls !== '') out.push(`${selector}{${decls}}`);
    }
    i = end + 1;
  }
  return out;
}

/** The content of a `<style>` element. Never contains `<`, so it can never close its element early. */
export function sanitizeStylesheet(sheet: string): string {
  // CDO/CDC (`<!--`, `-->`) are ignored by CSS and common in mail, which hides styles from old clients.
  const css = stripComments(sheet.replace(/<!--|-->/g, ' '));
  if (css.includes('\\') || css.includes('<')) return '';
  return rules(css, 0).join('\n');
}
