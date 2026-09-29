// Focus return for a dialog with no trigger of its own (PST-T-14.6).
//
// A @d3cloud/ui Modal hands focus back to its `trigger` on close. Inspect and Move to… open from a
// menu item, a chip or a key, so they are controlled Modals with no trigger — and with none, Radix
// restores focus nowhere and it drops to <body>. This remembers what opened the dialog and focuses
// it once the dialog is closed: at that point the dialog's focus trap is already off (it traps only
// while open), so nothing pulls focus back inside during the exit animation, and Radix's own
// on-unmount restore targets the (absent) trigger and leaves focus where it is.
import { useEffect, useRef, type RefObject } from 'react';

/** Returns the ref to set to the opener before opening; on close, focus goes there (or `fallback()`). */
export function useFocusReturn(open: boolean, fallback?: () => HTMLElement | null): RefObject<HTMLElement | null> {
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return undefined;
    const pick = (): HTMLElement | null => {
      const to = target.current;
      if (to?.isConnected === true) return to;
      return fallbackRef.current?.() ?? null;
    };
    const restore = () => {
      const to = pick();
      if (to !== null && document.activeElement !== to) to.focus();
    };
    restore();
    // Radix settles its layers (the dialog's, and a menu that was open underneath) a task later; if
    // any of them moved focus off the opener or dropped it to <body>, put it back once.
    const t = window.setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || active.closest('[role="dialog"], [role="menu"]') !== null) restore();
      target.current = null;
    }, 0);
    return () => {
      window.clearTimeout(t);
    };
  }, [open]);
  return target;
}
