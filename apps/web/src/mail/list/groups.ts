// PST-T-15.2 (PST-REQ-194): the list's day groups — Today, Yesterday, Earlier this week, then one
// group per month — and the geometry of a virtual list that interleaves their headers with
// fixed-height rows. Pure, so it is unit tested without a browser.
//
// A message is grouped by its INTERNAL date (arrival), the key the list is sorted by (./order), so
// every group is one contiguous run of rows. The groups are ARIA `group`s inside the listbox (its
// allowed children); the visible heading is decorative, the group's aria-label carries the name.

export interface DayGroup {
  /** Stable across renders: "today", "yesterday", "week", "m-2026-08". */
  key: string;
  label: string;
  /** Index of the group's first row. */
  start: number;
}

/**
 * The first day of the week as JS getDay() numbers it (0 = Sunday), from the locale where the
 * browser says (Intl.Locale weekInfo); Sunday otherwise.
 */
export function weekStartDay(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? (typeof navigator === 'undefined' ? 'en-US' : navigator.language)) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info !== undefined && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch {
    // An unknown locale tag: fall through.
  }
  return 0;
}

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which group one date belongs to, relative to `now` (local time) — the key only, cheap enough
 *  to run over every row. A date in the future is Today. */
export function dayGroupKey(iso: string, now: Date, weekStart = 0): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'today';
  if (at >= startOfDay(now)) return 'today';
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return 'yesterday';
  const back = (now.getDay() - weekStart + 7) % 7;
  if (at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime()) return 'week';
  const d = new Date(at);
  return `m-${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** What a group's header says: "Today", "Yesterday", "Earlier this week", "August", "August 2025". */
export function dayGroupLabel(key: string, now: Date): string {
  if (key === 'today') return 'Today';
  if (key === 'yesterday') return 'Yesterday';
  if (key === 'week') return 'Earlier this week';
  const [, year, month] = /^m-(\d{4})-(\d{2})/.exec(key) ?? [];
  if (year === undefined || month === undefined) return key;
  const name = new Date(Number(year), Number(month) - 1, 1).toLocaleString(undefined, { month: 'long' });
  return Number(year) === now.getFullYear() ? name : `${name} ${year}`;
}

/** The runs of rows that share a group, in list order. */
export function dayGroups(messages: readonly { internalDate: string }[], now: Date, weekStart = 0): DayGroup[] {
  const out: DayGroup[] = [];
  const used = new Map<string, number>();
  let last: string | null = null;
  messages.forEach((m, i) => {
    const key = dayGroupKey(m.internalDate, now, weekStart);
    if (key === last) return;
    last = key;
    // A key seen before (the list was out of order) gets a suffix, so React keys stay unique.
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    out.push({ key: seen === 0 ? key : `${key}~${String(seen)}`, label: dayGroupLabel(key, now), start: i });
  });
  return out;
}

// --- Geometry -------------------------------------------------------------------------------------

export interface ListLayout {
  /** The top of each row, in px from the top of the list's content. */
  rowTop: number[];
  /** True for the first row of a group (a header sits directly above it). */
  leads: boolean[];
  rowHeight: number;
  headHeight: number;
  /** The whole content height. */
  height: number;
}

export function layoutRows(groups: readonly DayGroup[], count: number, rowHeight: number, headHeight: number): ListLayout {
  const starts = new Set(groups.map((g) => g.start));
  const rowTop: number[] = new Array<number>(count);
  const leads: boolean[] = new Array<boolean>(count);
  let y = 0;
  for (let i = 0; i < count; i++) {
    const lead = starts.has(i);
    if (lead) y += headHeight;
    rowTop[i] = y;
    leads[i] = lead;
    y += rowHeight;
  }
  return { rowTop, leads, rowHeight, headHeight, height: y };
}

/** Where row `i`'s block starts: its group header when it leads one, else the row itself. */
export function blockTop(layout: ListLayout, i: number): number {
  const top = layout.rowTop[i] ?? 0;
  return layout.leads[i] === true ? top - layout.headHeight : top;
}

/** The last row whose top is at or above `y` (binary search), or -1 above the first row. */
function rowStartingBefore(layout: ListLayout, y: number): number {
  let lo = 0;
  let hi = layout.rowTop.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((layout.rowTop[mid] ?? 0) <= y) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The row under content offset `y`, or null over a group header or past the end. */
export function rowAt(layout: ListLayout, y: number): number | null {
  const i = rowStartingBefore(layout, y);
  if (i < 0) return null;
  return y < (layout.rowTop[i] ?? 0) + layout.rowHeight ? i : null;
}

/** The rows to render: [start, end) covering the viewport plus `overscan` rows either side. */
export function rangeFor(layout: ListLayout, scrollTop: number, viewport: number, overscan = 8): { start: number; end: number } {
  const count = layout.rowTop.length;
  if (count === 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, rowStartingBefore(layout, top));
  const last = Math.max(first, rowStartingBefore(layout, top + Math.max(viewport, layout.rowHeight)));
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + 1 + overscan) };
}

/** The scrollTop that brings row `i` (and its group header, when it leads one) into view; null when it is. */
export function revealRow(layout: ListLayout, i: number, scrollTop: number, viewport: number): number | null {
  if (i < 0 || i >= layout.rowTop.length) return null;
  const top = blockTop(layout, i);
  const bottom = (layout.rowTop[i] ?? 0) + layout.rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}
