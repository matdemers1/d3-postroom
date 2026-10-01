// PST-T-16.15 (PST-DA-066): Pointer Events on a touch screen only. One set of handlers for the whole
// list (delegated to the row under the finger), so a virtual window of rows costs nothing per row.
//
//  - The row sets `touch-action: pan-y` (list.css): the browser keeps vertical scrolling, and a
//    sideways drag arrives here as pointer moves. Past that the gesture is still ours to claim only
//    after |dx| > |dy| and > 10 px (claimsGesture); a vertical-ish drag releases the row at once.
//  - The row is moved by DOM, not state: `--swipe-x` and `data-swipe` on the row element. React never
//    sets either, so a re-render in the middle of a drag cannot undo it, and a drag costs no render.
//  - Release past 40% runs the action through `onCommit`, which is the list's own onRowAction — the
//    same triage path as the row's buttons and the keys, so the Undo toast is the one they show.
//  - Reduced motion is CSS only (list.css): the row does not slide, the action still commits.
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { claimsGesture, decideSwipe, swipeOffset, type SwipeOutcome } from './swipe';

export type SwipeCommit = 'archive' | 'read';

export interface RowSwipeOptions {
  /** Touch screens with nothing selected; otherwise every handler is inert. */
  enabled: boolean;
  canArchive: boolean;
  /** Called once, on release past the threshold, with the row's list index. */
  onCommit: (action: SwipeCommit, index: number) => void;
}

interface Drag {
  pointerId: number;
  row: HTMLElement;
  index: number;
  x: number;
  y: number;
  width: number;
  claimed: boolean;
}

const ROW = '[data-message-id]';

function setState(row: HTMLElement, outcome: SwipeOutcome, offset: number): void {
  row.style.setProperty('--swipe-x', `${String(offset)}px`);
  if (outcome === 'none') delete row.dataset['swipe'];
  else row.dataset['swipe'] = outcome;
}

function reset(row: HTMLElement): void {
  row.style.removeProperty('--swipe-x');
  delete row.dataset['swipe'];
}

export function useRowSwipe({ enabled, canArchive, onCommit }: RowSwipeOptions) {
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) window.clearTimeout(t);
    };
  }, []);

  const release = useCallback((d: Drag) => {
    drag.current = null;
    try {
      d.row.releasePointerCapture(d.pointerId);
    } catch {
      // Capture was never taken, or is already gone.
    }
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      suppress.current = false;
      if (!enabled || e.pointerType === 'mouse' || !e.isPrimary) return;
      const target = e.target instanceof Element ? e.target : null;
      const row = target?.closest<HTMLElement>(ROW) ?? null;
      if (row === null || row.classList.contains('pr-mrow--leaving')) return;
      const index = Number(row.dataset['index']);
      if (Number.isNaN(index)) return;
      drag.current = { pointerId: e.pointerId, row, index, x: e.clientX, y: e.clientY, width: row.getBoundingClientRect().width, claimed: false };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d === null || d.pointerId !== e.pointerId) return;
      if (!d.row.isConnected) {
        drag.current = null;
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.claimed) {
        const claim = claimsGesture(dx, dy);
        if (claim === 'scroll') {
          drag.current = null;
          return;
        }
        if (claim === 'undecided') return;
        d.claimed = true;
        suppress.current = true;
        try {
          d.row.setPointerCapture(d.pointerId);
        } catch {
          // A synthetic or already-finished pointer: the drag still works through bubbling.
        }
      }
      const options = { canArchive };
      setState(d.row, decideSwipe(dx, dy, d.width, options), swipeOffset(dx, d.width, options));
    },
    [canArchive],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d === null || d.pointerId !== e.pointerId) return;
      release(d);
      if (!d.claimed) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      const outcome = decideSwipe(dx, dy, d.width, { canArchive });
      if (outcome === 'commit-archive') {
        // The row keeps its place on screen while triage takes it out; if triage declines (nothing to
        // move), it comes back rather than staying half off the screen.
        d.row.dataset['swipe'] = 'done';
        onCommit('archive', d.index);
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          if (d.row.isConnected && !d.row.classList.contains('pr-mrow--leaving')) reset(d.row);
        }, 800);
        timers.current.add(timer);
      } else if (outcome === 'commit-read') {
        reset(d.row);
        onCommit('read', d.index);
      } else {
        reset(d.row);
      }
    },
    [canArchive, onCommit, release],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d === null || d.pointerId !== e.pointerId) return;
      release(d);
      reset(d.row);
    },
    [release],
  );

  /** The click a finished swipe would otherwise end with must not open the row. */
  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!suppress.current) return;
    suppress.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
}
