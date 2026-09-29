import { useSyncExternalStore } from 'react';

/** Tablet and up: the list and the reading pane side by side. Below it, push navigation. */
export const SPLIT_QUERY = '(min-width: 768px)';
/** The shell's `lg`: the sidebar is a column rather than a drawer. */
export const WIDE_QUERY = '(min-width: 1024px)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => {
        list.removeEventListener('change', notify);
      };
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

/** A mouse or trackpad is the primary pointer: key hints (the toast's `z`) mean something. */
export const FINE_POINTER_QUERY = '(pointer: fine)';

/**
 * Whether to draw a key hint at all (PST-T-14.11): on a touch phone a `z` keycap is noise. Read at
 * the moment a toast is shown; with no matchMedia (tests, SSR) the hint stays.
 */
export function showsKeyHints(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(FINE_POINTER_QUERY).matches;
}
