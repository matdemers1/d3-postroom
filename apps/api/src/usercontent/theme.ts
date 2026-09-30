// How a message's HTML sits in the reading pane (PST-T-15.12, PST-REQ-194). Two looks, the way
// Apple Mail and Gmail do it:
//
//   * designed — the sender painted a page (any bgcolor or background attribute, or a background /
//     background-color / background-image declaration that is not white or a no-op). It keeps
//     exactly the white page it always had, and the web app draws a hairline frame around it.
//   * plain — everything else, which is most personal mail: Outlook's MsoNormal replies set fonts
//     and `color: black` / `windowtext` but never a background. It renders on a transparent page in
//     the app's own ink and theme, so it reads like the plain-text body beside it. In the dark theme
//     the author's near-black text colours (and white backgrounds, which only a plain message can
//     have) are dropped so the reader's light ink shows instead of black on near-black.
//
// Pure functions only: the sanitizer calls them (sanitize.ts, css.ts) and index.ts picks the look.
// Nothing here widens what the sanitizer lets through — it only ever removes declarations.

export type RenderTheme = 'light' | 'dark';

/** The theme a render URL asks for: `dark`, or `light` for anything else (absent, garbage). */
export function parseTheme(raw: unknown): RenderTheme {
  return raw === 'dark' ? 'dark' : 'light';
}

type Rgb = readonly [number, number, number];

/** CSS named colours worth knowing here: the dark ones (to drop) and the common light ones (to keep). */
const NAMED: Readonly<Record<string, Rgb>> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  navy: [0, 0, 128],
  darkblue: [0, 0, 139],
  mediumblue: [0, 0, 205],
  blue: [0, 0, 255],
  midnightblue: [25, 25, 112],
  darkslateblue: [72, 61, 139],
  indigo: [75, 0, 130],
  purple: [128, 0, 128],
  darkmagenta: [139, 0, 139],
  maroon: [128, 0, 0],
  darkred: [139, 0, 0],
  brown: [165, 42, 42],
  firebrick: [178, 34, 34],
  saddlebrown: [139, 69, 19],
  darkgreen: [0, 100, 0],
  green: [0, 128, 0],
  darkolivegreen: [85, 107, 47],
  darkslategray: [47, 79, 79],
  darkslategrey: [47, 79, 79],
  teal: [0, 128, 128],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  silver: [192, 192, 192],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  red: [255, 0, 0],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  lime: [0, 255, 0],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
};

/** System and legacy keywords that mean "the default dark text" in a light-page world. */
const NEAR_BLACK_KEYWORDS = new Set(['black', 'windowtext', 'windowframe', 'buttontext', '-webkit-text']);

/** Background values that paint nothing a reader would call a page. */
const NEUTRAL_BACKGROUND_KEYWORDS = new Set(['transparent', 'inherit', 'initial', 'unset', 'revert', 'none']);

/** Near-black: relative luminance under this (WCAG's definition). Text darker than it on the dark surface reads under ~4:1. */
export const NEAR_BLACK_LUMINANCE = 0.2;

/** `black !important` → `black`; lowercased, whitespace collapsed. */
function bare(value: string): string {
  return value.replace(/!\s*important\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function channel(raw: string, max: number): number | null {
  const s = raw.trim();
  const percent = s.endsWith('%');
  const n = Number(percent ? s.slice(0, -1) : s);
  if (!Number.isFinite(n) || s === '' || s === '%') return null;
  const v = percent ? (n / 100) * max : n;
  return Math.min(max, Math.max(0, v));
}

function alphaOf(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  return channel(raw, 1);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * A CSS colour as sRGB 0–255 and an alpha 0–1: hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()
 * (comma or space syntax, numbers or percentages), hsl()/hsla(), and the named colours above.
 * Null for anything else — a keyword we do not know, a var(), a gradient — which callers keep as is.
 */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const v = bare(value);
  const named = NAMED[v];
  if (named !== undefined) return { rgb: named, alpha: 1 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? hex.replace(/./g, (c) => c + c) : hex;
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], alpha: full.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (fn === null) return null;
  const parts = (fn[2] ?? '').split(/\s*[,/]\s*|\s+/).filter((p) => p !== '');
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = alphaOf(parts[3]);
  if (alpha === null) return null;
  if ((fn[1] ?? '').startsWith('rgb')) {
    const rgb = [channel(parts[0] ?? '', 255), channel(parts[1] ?? '', 255), channel(parts[2] ?? '', 255)];
    if (rgb.some((c) => c === null)) return null;
    return { rgb: rgb as unknown as Rgb, alpha };
  }
  const h = Number((parts[0] ?? '').replace(/deg$/, ''));
  const s = channel(parts[1] ?? '', 1);
  const l = channel(parts[2] ?? '', 1);
  if (!Number.isFinite(h) || s === null || l === null || !(parts[1] ?? '').endsWith('%') || !(parts[2] ?? '').endsWith('%')) return null;
  return { rgb: hslToRgb(((h % 360) + 360) % 360, s, l), alpha };
}

/** WCAG 2 relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** A text colour that would vanish on the dark surface: black-ish keywords, or luminance under 0.2. */
export function isNearBlack(value: string): boolean {
  const v = bare(value);
  if (NEAR_BLACK_KEYWORDS.has(v)) return true;
  const c = parseColor(v);
  return c !== null && c.alpha > 0 && relativeLuminance(c.rgb) < NEAR_BLACK_LUMINANCE;
}

/** Exactly white (#fff, #ffffff, white, rgb(255,255,255)…), at any alpha above zero. */
function isWhite(value: string): boolean {
  const c = parseColor(value);
  return c !== null && c.alpha > 0 && c.rgb.every((ch) => Math.round(ch) === 255);
}

/**
 * Whether one declaration paints a page: a background, background-color or background-image whose
 * value is not white or a no-op (transparent, inherit, initial, none …). Any other property: false.
 */
export function isDesignedBackground(prop: string, value: string): boolean {
  const p = prop.trim().toLowerCase();
  if (p !== 'background' && p !== 'background-color' && p !== 'background-image') return false;
  const v = bare(value);
  if (v === '' || NEUTRAL_BACKGROUND_KEYWORDS.has(v)) return false;
  if (p === 'background-image') return true;
  const c = parseColor(v);
  if (c !== null && c.alpha === 0) return false;
  return !isWhite(v);
}

const BACKGROUND_DECLARATION = /(?:^|[\s;{"'])(background(?:-color|-image)?)\s*:\s*([^;}"']*)/gi;

/**
 * Whether a style attribute or a stylesheet (raw, as the sender wrote it) sets a designed
 * background anywhere. Detection only — the sanitizer still decides what survives.
 */
export function declarationsDesigned(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
  for (const m of text.matchAll(BACKGROUND_DECLARATION)) {
    if (isDesignedBackground(m[1] ?? '', m[2] ?? '')) return true;
  }
  return false;
}

/**
 * The dark-theme filter for a plain message's declarations: true drops it. Near-black `color`
 * goes (the text then inherits the reader's light ink), and so does a white background — the only
 * kind a plain message can have — which would otherwise be a white box behind light text.
 */
export function dropForDark(prop: string, value: string): boolean {
  if (prop === 'color') return isNearBlack(value);
  if (prop === 'background' || prop === 'background-color') return isWhite(bare(value));
  return false;
}

// The reader's colours, from @d3cloud/ui's tokens. Hard-coded on purpose: this CSS is served inside
// the usercontent frame, a separate origin that cannot see the app's custom properties, and it is
// server-rendered — outside the web app's d3-check-usage lint, which covers apps/web only.
export const THEME_COLORS: Readonly<Record<RenderTheme, { ink: string; link: string }>> = {
  light: { ink: '#101117', link: '#5432be' },
  dark: { ink: '#f0f2f7', link: '#b8b4ff' },
};
