// How tall a render will be, estimated on the server (PST-T-17.3, design finding PST-DA-084).
//
// The Newsletters feed frames every issue in the sandboxed usercontent iframe, and that frame can
// never tell its parent how tall its document is: no allow-scripts, no allow-same-origin, a CSP
// with no script-src, and a different origin (PST-REQ-081, PST-ADR-011 rejected script-sized
// frames). So the render ticket carries an ESTIMATE instead, made here from the very markup the
// usercontent route serves, and the feed sizes each frame from it — clamped, with a "Read in full"
// past the cap. A one-line note gets a short frame; a long issue is cut off at the feed's cap.
//
// It is a rough box model, not a layout engine: block elements stack, inline text wraps at an
// average glyph width, table cells sit side by side (their row is as tall as its tallest cell),
// images take their declared box, `display:none` (a preheader) takes nothing, and vertical
// padding, margins and declared heights are counted. It reads only our sanitised OUTPUT, so every
// tag is one of the sanitizer's, balanced, with its attributes quoted.
//
// Two widths, because the frame's width changes the answer twice over: text wraps more in a narrow
// frame, and below 600 px NARROW_FIT_STYLE linearises layout tables so their cells stack. `wide`
// is a frame 720 px wide (the feed on a desktop), `narrow` one 360 px wide (a phone); the client
// interpolates between them for the width it actually has.
import { escapeText } from './sanitize.js';
import { tokenize } from './tokenizer.js';

/** The two frame widths an estimate is made for, in CSS px. */
export const ESTIMATE_WIDTHS = { narrow: 360, wide: 720 } as const;

/** Below this frame width NARROW_FIT_STYLE linearises tables (its media query is max-width:599px). */
const LINEARISE_BELOW = 600;

/** No estimate is larger than this: a frame is capped far below it anyway. */
export const MAX_ESTIMATE = 100_000;

/** Average glyph advance as a fraction of the font size (Inter and system-ui both sit near it). */
const GLYPH = 0.5;
/** Word wrapping wastes the end of most lines. */
const WRAP_FILL = 0.9;
/** A loaded image whose size the sender never said: a typical newsletter banner. */
const UNSIZED_IMAGE = 200;

export interface HeightEstimate {
  /** Estimated document height, in CSS px, in a frame ESTIMATE_WIDTHS.narrow wide. */
  narrow: number;
  /** Estimated document height, in CSS px, in a frame ESTIMATE_WIDTHS.wide wide. */
  wide: number;
}

export interface EstimateOptions {
  /** The message paints its own page (theme.ts): 14px/1.5 with a 12px page padding; else 16px/1.6, flush. */
  designed: boolean;
  /** Remote images are loaded through the proxy in this render (otherwise each is a 1×1 placeholder). */
  images?: boolean | undefined;
}

interface Node {
  name: string;
  attrs: Map<string, string>;
  children: (Node | string)[];
}

const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);

const INLINE = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

/** Elements with a default vertical margin of about 1em (collapsed between siblings). */
const MARGINED = new Set(['p', 'ul', 'ol', 'dl', 'pre', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'address']);

const HEADING_SCALE: Record<string, number> = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
/** <font size=1..7> in px. */
const FONT_SIZES = [10, 13, 16, 18, 24, 32, 48];

/** The sanitised markup as a tree. <style> blocks (raw text) and comments are not content. */
function parse(html: string): Node {
  const root: Node = { name: '#root', attrs: new Map(), children: [] };
  const stack: Node[] = [root];
  for (const token of tokenize(html)) {
    const top = stack[stack.length - 1] ?? root;
    if (token.type === 'text') {
      top.children.push(token.text);
    } else if (token.type === 'start') {
      const node: Node = { name: token.name, attrs: new Map(token.attrs), children: [] };
      top.children.push(node);
      if (!VOID.has(token.name) && !token.selfClosing) stack.push(node);
    } else if (token.type === 'end') {
      // A reverse scan, not stack.map(...).lastIndexOf: no allocation per end tag at the depth cap.
      let at = stack.length - 1;
      while (at >= 0 && stack[at]?.name !== token.name) at -= 1;
      if (at > 0) stack.length = at;
    }
  }
  return root;
}

/** One declaration's value from a style attribute, lower-cased; null when absent. */
function declaration(style: string, property: string): string | null {
  let found: string | null = null;
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    if (part.slice(0, colon).trim().toLowerCase() === property) found = part.slice(colon + 1).replace(/!important/i, '').trim().toLowerCase();
  }
  return found;
}

/** A CSS or attribute length in px; `%` resolves against `of`. Null for anything else (auto, calc…). */
function length(value: string | null | undefined, fontSize: number, of: number | null = null): number | null {
  if (value === null || value === undefined) return null;
  const m = /^(-?\d+(?:\.\d+)?)(px|pt|em|rem|%)?$/.exec(value.trim().toLowerCase());
  if (m === null) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case 'px':
      return n;
    case 'pt':
      return (n * 4) / 3;
    case 'em':
      return n * fontSize;
    case 'rem':
      return n * 16;
    case '%':
      return of === null ? null : (n * of) / 100;
    default:
      return null;
  }
}

/** Top and bottom of a padding/margin shorthand plus its -top/-bottom longhands, in px. */
function vertical(style: string, property: 'padding' | 'margin', fontSize: number): { top: number | null; bottom: number | null } {
  let top: number | null = null;
  let bottom: number | null = null;
  const short = declaration(style, property);
  if (short !== null) {
    const parts = short.split(/\s+/);
    top = length(parts[0], fontSize);
    bottom = length(parts[2] ?? parts[0], fontSize);
  }
  top = length(declaration(style, `${property}-top`), fontSize) ?? top;
  bottom = length(declaration(style, `${property}-bottom`), fontSize) ?? bottom;
  return { top: top === null ? null : Math.max(0, top), bottom: bottom === null ? null : Math.max(0, bottom) };
}

interface Context {
  /** Content width available, px. */
  width: number;
  fontSize: number;
  /** Line height as a multiple of the font size (inherited, as the served `font:` shorthand sets it). */
  lineHeight: number;
  pre: boolean;
  /** NARROW_FIT_STYLE is in force: table rows and cells are blocks. */
  linear: boolean;
  images: boolean;
}

const clampFont = (px: number): number => Math.min(96, Math.max(1, px));

function fontSizeOf(node: Node, style: string, parent: number): number {
  let size = parent;
  const heading = HEADING_SCALE[node.name];
  if (heading !== undefined) size = 16 * heading;
  if (node.name === 'small') size = parent * 0.83;
  if (node.name === 'big') size = parent * 1.2;
  if (node.name === 'font') {
    const n = Number.parseInt(node.attrs.get('size') ?? '', 10);
    if (Number.isFinite(n)) size = FONT_SIZES[Math.min(7, Math.max(1, n)) - 1] ?? parent;
  }
  const declared = length(declaration(style, 'font-size'), parent, parent);
  if (declared !== null) size = declared;
  return clampFont(size);
}

function hidden(style: string): boolean {
  const display = declaration(style, 'display');
  if (display === 'none') return true;
  const maxHeight = declaration(style, 'max-height');
  return maxHeight !== null && /^0(px)?$/.test(maxHeight) && declaration(style, 'overflow') === 'hidden';
}

/** Lines `chars` characters of text take at this width and size. */
function textLines(chars: number, ctx: Context): number {
  if (chars <= 0) return 0;
  const perLine = Math.max(1, Math.floor((ctx.width / (ctx.fontSize * GLYPH)) * WRAP_FILL));
  return Math.ceil(chars / perLine);
}

/** An <img>'s rendered height, after `img{max-width:100%;height:auto}`. */
function imageHeight(node: Node, ctx: Context): number {
  const style = node.attrs.get('style') ?? '';
  const declaredW = length(declaration(style, 'width'), ctx.fontSize, ctx.width) ?? length(node.attrs.get('width'), ctx.fontSize, ctx.width);
  const styledH = length(declaration(style, 'height'), ctx.fontSize);
  const attrH = length(node.attrs.get('height'), ctx.fontSize);
  const width = declaredW === null ? null : Math.min(declaredW, ctx.width);
  // An inline height outranks the stylesheet's height:auto, so it is the height (max-width aside).
  if (styledH !== null) return declaredW !== null && declaredW > ctx.width ? (styledH * ctx.width) / declaredW : styledH;
  // A blocked remote image is the 1×1 placeholder: height:auto gives it the placeholder's square.
  const blocked = node.attrs.has('data-src') && !ctx.images;
  if (blocked) return width ?? 1;
  if (declaredW !== null && attrH !== null && declaredW > 0) return (attrH * (width ?? declaredW)) / declaredW;
  if (attrH !== null) return attrH;
  if (width !== null) return width / 2;
  return Math.min(UNSIZED_IMAGE, ctx.width);
}

/** The height of a block's content: its inline runs wrapped, its block children stacked. */
function measureContent(children: readonly (Node | string)[], ctx: Context): number {
  let height = 0;
  let chars = 0;
  let inlineImages = 0;
  let openLine = false;
  const line = (): number => ctx.fontSize * ctx.lineHeight;

  const flush = (): void => {
    if (chars > 0 || openLine) height += Math.max(1, textLines(chars, ctx)) * line();
    height += inlineImages;
    chars = 0;
    inlineImages = 0;
    openLine = false;
  };

  const walkInline = (node: Node | string, inner: Context): void => {
    if (typeof node === 'string') {
      if (inner.pre) {
        const rows = node.split('\n');
        rows.forEach((row, i) => {
          if (i > 0) {
            // A newline ends the line it is on, empty or not; a trailing one opens nothing.
            height += Math.max(1, textLines(chars, inner)) * line();
            chars = 0;
            openLine = false;
          }
          if (row.length > 0) {
            chars += row.length;
            openLine = true;
          }
        });
      } else {
        const collapsed = node.replace(/\s+/g, ' ');
        if (collapsed.trim() !== '') {
          chars += collapsed.length;
          openLine = true;
        }
      }
      return;
    }
    const style = node.attrs.get('style') ?? '';
    if (hidden(style)) return;
    if (node.name === 'br') {
      height += (openLine ? Math.max(1, textLines(chars, inner)) : 1) * line();
      chars = 0;
      openLine = false;
      return;
    }
    if (node.name === 'img') {
      inlineImages += imageHeight(node, inner);
      return;
    }
    const display = declaration(style, 'display');
    if (!INLINE.has(node.name) || display === 'block' || display === 'table' || display === 'flex') {
      flush();
      height += measureBlock(node, inner);
      return;
    }
    const size = fontSizeOf(node, style, inner.fontSize);
    // A larger inline font makes its share of the line taller; approximate by weighting its text.
    const scale = size / inner.fontSize;
    for (const child of node.children) {
      if (typeof child === 'string' && scale !== 1 && !inner.pre) {
        const collapsed = child.replace(/\s+/g, ' ');
        if (collapsed.trim() !== '') {
          chars += collapsed.length * scale * scale;
          openLine = true;
        }
      } else {
        walkInline(child, inner);
      }
    }
  };

  for (const child of children) walkInline(child, ctx);
  flush();
  return height;
}

function measureTable(node: Node, ctx: Context): number {
  const rows: Node[] = [];
  const others: Node[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name === 'tr') rows.push(child);
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') {
      for (const row of child.children) if (typeof row !== 'string' && row.name === 'tr') rows.push(row);
    } else if (child.name === 'caption') others.push(child);
  }
  const padding = Number.parseInt(node.attrs.get('cellpadding') ?? '', 10);
  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 1;
  const spacing = Number.parseInt(node.attrs.get('cellspacing') ?? '', 10);
  const gap = Number.isFinite(spacing) ? Math.max(0, spacing) : 2;
  let height = others.reduce((sum, caption) => sum + measureBlock(caption, ctx), 0);
  if (!ctx.linear) height += gap;
  for (const row of rows) {
    const rowStyle = row.attrs.get('style') ?? '';
    if (hidden(rowStyle)) continue;
    const cells = row.children.filter((c): c is Node => typeof c !== 'string' && (c.name === 'td' || c.name === 'th') && !hidden(c.attrs.get('style') ?? ''));
    if (cells.length === 0) continue;
    if (ctx.linear) {
      // NARROW_FIT_STYLE: every cell is a block, full width, one under the other.
      for (const cell of cells) height += measureCell(cell, ctx.width, pad, ctx);
      continue;
    }
    // Cells side by side: declared widths first, the rest share what is left.
    const declared = cells.map((cell) => length(declaration(cell.attrs.get('style') ?? '', 'width'), ctx.fontSize, ctx.width) ?? length(cell.attrs.get('width'), ctx.fontSize, ctx.width));
    const fixed = declared.reduce<number>((sum, w) => sum + (w ?? 0), 0);
    const free = declared.filter((w) => w === null).length;
    const share = free === 0 ? 0 : Math.max(0, ctx.width - fixed) / free;
    const scaleDown = fixed > ctx.width ? ctx.width / fixed : 1;
    const rowMin = length(row.attrs.get('height'), ctx.fontSize) ?? 0;
    let tallest = rowMin;
    cells.forEach((cell, i) => {
      const width = Math.max(ctx.fontSize, ((declared[i] ?? null) === null ? share : (declared[i] ?? 0) * scaleDown) - 2 * pad);
      tallest = Math.max(tallest, measureCell(cell, width, pad, ctx));
    });
    height += tallest + gap;
  }
  return height;
}

function measureCell(cell: Node, width: number, pad: number, ctx: Context): number {
  const style = cell.attrs.get('style') ?? '';
  const size = fontSizeOf(cell, style, ctx.fontSize);
  const inner: Context = { ...ctx, width: Math.max(size, width), fontSize: size };
  const padding = vertical(style, 'padding', size);
  const content = measureContent(cell.children, inner);
  const declared = length(declaration(style, 'height'), size) ?? length(cell.attrs.get('height'), size) ?? 0;
  return Math.max(declared, content + (padding.top ?? pad) + (padding.bottom ?? pad));
}

/** A block element's whole box: margin, padding, content (or its declared height, if taller). */
function measureBlock(node: Node, ctx: Context): number {
  const style = node.attrs.get('style') ?? '';
  if (hidden(style) || node.name === 'style') return 0;
  const size = fontSizeOf(node, style, ctx.fontSize);
  if (node.name === 'hr') return 2 + size;
  if (node.name === 'img') return imageHeight(node, ctx);
  const padding = vertical(style, 'padding', size);
  const margin = vertical(style, 'margin', size);
  const defaultMargin = MARGINED.has(node.name) ? size * (HEADING_SCALE[node.name] === undefined ? 1 : 0.67) : 0;
  const declaredWidth = length(declaration(style, 'width'), size, ctx.width) ?? (node.name === 'table' ? length(node.attrs.get('width'), size, ctx.width) : null);
  const width = Math.min(ctx.width, declaredWidth ?? ctx.width);
  // The served stylesheet: blockquote{margin:0 0 0 8px;padding-left:8px}; lists indent 40px.
  const indent = node.name === 'blockquote' ? 16 : node.name === 'ul' || node.name === 'ol' ? 40 : node.name === 'dd' ? 40 : 0;
  const inner: Context = {
    ...ctx,
    width: Math.max(size, width - indent),
    fontSize: size,
    pre: ctx.pre || node.name === 'pre',
  };
  let content: number;
  if (node.name === 'table') content = measureTable(node, inner);
  else if (node.name === 'details' && !node.attrs.has('open')) {
    content = measureContent(node.children.filter((c) => typeof c !== 'string' && c.name === 'summary'), inner);
  } else content = measureContent(node.children, inner);
  const declaredHeight = length(declaration(style, 'height'), size) ?? (node.name === 'table' || node.name === 'tr' ? length(node.attrs.get('height'), size) : null) ?? 0;
  const vpad = (padding.top ?? 0) + (padding.bottom ?? 0);
  return Math.max(declaredHeight, content + vpad) + (margin.top ?? defaultMargin) + (margin.bottom ?? 0);
}

function estimateAt(root: Node, width: number, opts: EstimateOptions): number {
  const page = opts.designed ? 12 : 0;
  const ctx: Context = {
    width: Math.max(1, width - 2 * page),
    fontSize: opts.designed ? 14 : 16,
    lineHeight: opts.designed ? 1.5 : 1.6,
    pre: false,
    linear: width < LINEARISE_BELOW,
    images: opts.images === true,
  };
  // The last margined block's bottom margin, which measureBlock leaves out of every sibling.
  const last = [...root.children].reverse().find((c): c is Node => typeof c !== 'string');
  const trailing = last !== undefined && MARGINED.has(last.name) ? ctx.fontSize : 0;
  const height = measureContent(root.children, ctx) + trailing + 2 * page;
  // Rounded up, less the float noise of summing many fractional line heights.
  return Math.min(MAX_ESTIMATE, Math.max(0, Math.ceil(height - 1e-6)));
}

/** The estimate for a sanitised HTML body (sanitizeHtml's `html`), at both widths. */
export function estimateHtmlHeight(sanitized: string, opts: EstimateOptions): HeightEstimate {
  const root = parse(sanitized);
  return { narrow: estimateAt(root, ESTIMATE_WIDTHS.narrow, opts), wide: estimateAt(root, ESTIMATE_WIDTHS.wide, opts) };
}

/** The estimate for a text/plain body, served as `<pre style="font: inherit">` on a plain page. */
export function estimateTextHeight(text: string): HeightEstimate {
  return estimateHtmlHeight(`<pre>${escapeText(text)}</pre>`, { designed: false });
}
