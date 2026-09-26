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
