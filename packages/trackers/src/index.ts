// Tracking-pixel classification and tracking-parameter link cleaning, with stated reasons
// (PST-T-6.2, PST-REQ-116). Pure and deterministic: no DNS, no network, no clock — the caller
// (the sanitizer, `apps/api/src/usercontent/sanitize.ts`) decides what to do with the verdict.
//
//   * `classifyImage` looks at a (possibly relative) `<img src>` and its other attributes and says
//     whether it is a known tracking pixel — an ESP's open-tracking endpoint, a generic `/open`-style
//     path, or a pixel sized/hidden so a human was never meant to see it — or ordinary content.
//     A tracker is dropped entirely by the caller: never fetched, even once the reader asks for
//     images, unlike an ordinary blocked remote image.
//   * `cleanLink` strips tracking query parameters (utm_*, mc_cid, fbclid, gclid, …) from an `<a
//     href>`, and unwraps a known click-redirect wrapper (e.g. SendGrid's `ct.sendgrid.net/...?u=`)
//     to the real destination it names — but only when the wrapper host itself is recognised; an
//     unknown `?url=` parameter is left alone; you cannot follow a redirect you did not resolve.
import { pathLooksLikeTracker, trackerVendorFor } from './hosts.js';
import { isRedirectWrapperHost, isTrackingParam, REDIRECT_PARAM_NAMES } from './params.js';

export { REDIRECT_WRAPPER_HOSTS, isRedirectWrapperHost } from './params.js';
export { TRACKER_HOSTS, trackerVendorFor } from './hosts.js';

export const PACKAGE = '@postroom/trackers';

export interface ImageClassification {
  readonly kind: 'tracker' | 'content';
  /** Always non-empty: why this src was, or was not, classified as a tracker. */
  readonly reason: string;
}

/** A URL this module can reason about: absolute http(s), or protocol-relative (`//host/path`). */
function parseImageUrl(src: string): URL | null {
  const absolute = src.startsWith('//') ? `https:${src}` : src;
  try {
    const url = new URL(absolute);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

const PX_1_OR_0 = /^0*[01]$/;

/** True when width/height attributes both say the image is a 1×1 (or 0×0) pixel. */
function isPixelBySize(attrs: Readonly<Record<string, string | undefined>>): boolean {
  const width = attrs['width'];
  const height = attrs['height'];
  return width !== undefined && height !== undefined && PX_1_OR_0.test(width.trim()) && PX_1_OR_0.test(height.trim());
}

/** A `width:1px;height:1px` (or 0) pair inside a style attribute, however it is ordered or spaced. */
function isPixelByStyle(style: string): boolean {
  const width = /width\s*:\s*0*[01]px/i.test(style);
  const height = /height\s*:\s*0*[01]px/i.test(style);
  return width && height;
}

/** `display:none` or `visibility:hidden` in a style attribute: never meant to be seen. */
function isHiddenByStyle(style: string): boolean {
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style);
}

/**
 * Whether an `<img src>` is a known tracking pixel — an ESP's open-tracking endpoint, a generic
 * `/open`-style path, or a pixel sized or hidden so no human was meant to see it — with the reason.
 * Never throws: an unparseable or non-http(s) `src` is content (nothing left to check it against).
 */
export function classifyImage(src: string, attrs: Readonly<Record<string, string | undefined>> = {}): ImageClassification {
  const url = parseImageUrl(src);
  if (url !== null) {
    const vendor = trackerVendorFor(url.hostname, url.pathname, url.search);
    if (vendor !== null) return { kind: 'tracker', reason: `${vendor} open-tracking pixel (${url.hostname}${url.pathname})` };
    if (pathLooksLikeTracker(url.pathname, url.search)) return { kind: 'tracker', reason: `generic open-tracking path (${url.pathname})` };
  }
  if (isPixelBySize(attrs)) return { kind: 'tracker', reason: '1×1 pixel by width/height attribute' };
  const style = attrs['style'] ?? '';
  if (style !== '') {
    if (isPixelByStyle(style)) return { kind: 'tracker', reason: '1×1 pixel by style' };
    if (isHiddenByStyle(style)) return { kind: 'tracker', reason: 'hidden by style (display:none/visibility:hidden)' };
  }
  return { kind: 'content', reason: 'no known tracker signal' };
}

export interface CleanLinkResult {
  /** The address to keep: tracking parameters removed, and unwrapped when a wrapper was resolved. */
  readonly href: string;
  /** Parameter names removed, in the order first seen. Empty when nothing was removed. */
  readonly removedParams: readonly string[];
  /** Present only when a known click-redirect wrapper's real destination was resolved. */
  readonly unwrapped?: { readonly from: string; readonly to: string };
}

/** The real destination a known redirect wrapper names in one of its query parameters, if any. */
function unwrap(url: URL): { url: URL; from: string } | null {
  if (!isRedirectWrapperHost(url.hostname)) return null;
  for (const param of REDIRECT_PARAM_NAMES) {
    const inner = url.searchParams.get(param);
    if (inner === null || inner === '') continue;
    try {
      const target = new URL(inner);
      if (target.protocol === 'http:' || target.protocol === 'https:') return { url: target, from: url.href };
    } catch {
      // Not a URL after all: not a redirect param, keep looking at the others.
    }
  }
  return null;
}

/**
 * Strips tracking parameters from a link, and unwraps a known click-redirect wrapper to the
 * destination it names. Never throws — an unparseable or non-http(s) `href` (mailto:, cid:, a
 * fragment) is returned unchanged. Never changes scheme, host or path of a link that is not a
 * recognised wrapper: only its query string is touched. Idempotent.
 */
export function cleanLink(href: string): CleanLinkResult {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { href, removedParams: [] };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { href, removedParams: [] };

  const resolved = unwrap(url);
  const target = resolved?.url ?? url;

  const removed: string[] = [];
  const seen = new Set<string>();
  for (const name of target.searchParams.keys()) {
    if (isTrackingParam(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      removed.push(name);
    }
  }
  for (const name of removed) target.searchParams.delete(name);

  const result: CleanLinkResult = { href: target.href, removedParams: removed };
  return resolved === null ? result : { ...result, unwrapped: { from: resolved.from, to: target.href } };
}
