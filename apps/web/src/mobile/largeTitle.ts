// PST-T-17.8 (PST-REQ-155, PST-REQ-194; critique-settings X12, critique-admin X11): the phone's
// large-title pattern. A pushed Settings or Admin screen opens with its own h1 (PageHeader's
// `.d3-ph__title`) right under the context bar, so the bar shows no title of its own and draws no
// hairline; once that h1 has scrolled up under the bar, the bar takes the title (and its hairline).
// A screen with no PageHeader title (the place indexes, whose h1 is visually hidden) keeps the bar's
// title from the start. DOM access goes through the narrow shapes below and the observers are
// injected, so the decision and the wiring are unit-tested without a browser
// (test/unit/context-bar.test.ts).

/** The page heading the bar collapses into: PageHeader's h1. A visually hidden h1 never counts. */
export const LARGE_TITLE_SELECTOR = '.d3-ph__title';

/** What the decision reads from an IntersectionObserver entry. */
export interface TitleEntry {
  isIntersecting: boolean;
  boundingClientRect: { bottom: number };
}

/**
 * Whether the heading has scrolled up under the bar: it no longer shows below the bar, and it left
 * through the top (its bottom edge is at or above the bar's bottom edge). A heading that is out of
 * view because it is still BELOW the viewport has not scrolled under anything.
 */
export function headingUnderBar(entry: TitleEntry, barBottom: number): boolean {
  return !entry.isIntersecting && entry.boundingClientRect.bottom <= barBottom + 0.5;
}

/** The slice of an Element the wiring touches. */
export interface BarElement {
  parentElement: { querySelector: (selector: string) => unknown } | null;
  getBoundingClientRect: () => { bottom: number };
}

/** The observers, injected: the browser's own by default, fakes in a unit test. */
export interface ObserverEnv {
  IntersectionObserver?:
    | (new (
        callback: (entries: TitleEntry[]) => void,
        options: { rootMargin: string; threshold: number },
      ) => { observe: (target: never) => void; disconnect: () => void })
    | undefined;
  MutationObserver?:
    | (new (callback: () => void) => { observe: (target: never, options: { childList: boolean; subtree: boolean }) => void; disconnect: () => void })
    | undefined;
}

/**
 * Watches the first `.d3-ph__title` in the bar's push frame (the bar's parent) and reports whether
 * the bar should show its title. With no such heading — or no IntersectionObserver at all — it
 * reports `true` at once. A screen swaps its heading as it loads (a Loading state, then the page),
 * so the frame is watched for changes and the observer follows the current heading. Returns the
 * cleanup.
 */
export function observeLargeTitle(bar: BarElement, onChange: (showTitle: boolean) => void, env: ObserverEnv = globalEnv()): () => void {
  const frame = bar.parentElement;
  const IO = env.IntersectionObserver;
  if (frame === null || IO === undefined) {
    onChange(true);
    return () => undefined;
  }
  // A sentinel, so the first look reports even when it finds no heading.
  let watched: unknown = Symbol('unseen');
  let io: { disconnect: () => void } | null = null;
  let last: boolean | null = null;
  const report = (show: boolean): void => {
    if (show === last) return;
    last = show;
    onChange(show);
  };
  const follow = (): void => {
    const heading = frame.querySelector(LARGE_TITLE_SELECTOR) ?? null;
    if (heading === watched) return;
    watched = heading;
    io?.disconnect();
    io = null;
    if (heading === null) {
      report(true);
      return;
    }
    // The root is the viewport, shrunk from the top by the bar: the heading "intersects" while any
    // of it still shows below the bar.
    const barBottom = Math.max(0, Math.round(bar.getBoundingClientRect().bottom));
    const observer = new IO(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry !== undefined) report(headingUnderBar(entry, barBottom));
      },
      { rootMargin: `-${String(barBottom)}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(heading as never);
    io = observer;
    // Until the observer's first report (it comes asynchronously), a fresh screen shows its heading
    // under the bar: no bar title.
    report(false);
  };
  follow();
  const MO = env.MutationObserver;
  const mo = MO === undefined ? null : new MO(follow);
  mo?.observe(frame as never, { childList: true, subtree: true });
  return () => {
    mo?.disconnect();
    io?.disconnect();
  };
}

function globalEnv(): ObserverEnv {
  const g = globalThis as unknown as ObserverEnv;
  return { IntersectionObserver: g.IntersectionObserver, MutationObserver: g.MutationObserver };
}
