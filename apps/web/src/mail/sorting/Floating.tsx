// PST-T-14.9: the floating layer the bucket chip's "Why it's here" and the Person card open in. On a
// desktop it is a popover beside what opened it (--motion-popover-enter; surface-raised +
// border-float, no shadow, per the token rules); on a phone it is a bottom sheet over a scrim
// (--motion-drawer). @d3cloud/ui 1.3 has no Popover, so this is the one small piece written here.
//
// Keyboard: focus moves in when it opens; the arrow keys move through its actions; Esc closes it
// and focus goes back to what opened it. A pointer outside, or focus leaving, closes it too.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled])';
/** A design-system Select's list is portalled to <body>: a press or focus there is still inside. */
const OWNED_LAYER = '[data-radix-popper-content-wrapper], .d3-sel__content';
const inOwnedLayer = (node: Node | null): boolean => node instanceof Element && node.closest(OWNED_LAYER) !== null;
const GAP = 6;
const MARGIN = 8;

export interface FloatingProps {
  /** Where the opener was when it was clicked (the list is virtualised: the element itself may go). */
  anchor: DOMRect;
  /** Focus returns here on close, when it is still in the document. */
  returnFocus: HTMLElement | null;
  /** The button that opened it: a press on it is left to toggle the layer shut itself. */
  opener?: HTMLElement | null;
  label: string;
  /** A bottom sheet (phone) instead of a popover. */
  sheet: boolean;
  onClose: () => void;
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function Floating({ anchor, returnFocus, opener = null, label, sheet, onClose, className, testId, children }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  const openerRef = useRef(opener);
  openerRef.current = opener;
  closeRef.current = onClose;

  // Below the opener, or above it when there is no room; never off either edge.
  useLayoutEffect(() => {
    if (sheet) return;
    const el = ref.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + GAP;
    if (top + height > vh - MARGIN && anchor.top - GAP - height >= MARGIN) top = anchor.top - GAP - height;
    const left = Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN));
    setPos({ top: Math.max(MARGIN, top), left });
  }, [anchor, sheet]);

  const close = () => {
    closeRef.current();
    if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
  };
  const closeLatest = useRef(close);
  closeLatest.current = close;

  // Focus moves in once the layer is placed (a popover is hidden until it is measured, and a hidden
  // element cannot take focus).
  const placed = sheet || pos !== null;
  const focused = useRef(false);
  useEffect(() => {
    if (!placed || focused.current) return;
    focused.current = true;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    // Esc closes it wherever focus is — even when the control that had it has just gone (a
    // replaced button leaves focus on the body).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target instanceof Node ? e.target : null;
      if (target !== null && target !== document.body && ref.current?.contains(target) !== true) return;
      e.preventDefault();
      e.stopPropagation();
      closeLatest.current();
    };
    document.addEventListener('keydown', onKey, true);
    const onPointer = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (target !== null && ref.current?.contains(target) === true) return;
      if (inOwnedLayer(target)) return;
      // A press on the opener is its own toggle.
      if (target !== null && openerRef.current?.contains(target) === true) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement || target?.getAttribute('role') === 'combobox') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const i = target === null ? -1 : items.indexOf(target);
    const next = e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length];
    next?.focus();
  };

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      aria-modal={sheet ? true : undefined}
      tabIndex={-1}
      data-testid={testId}
      className={['pr-float', sheet ? 'pr-float--sheet' : 'pr-float--popover', className ?? ''].join(' ').trim()}
      style={sheet ? undefined : { top: pos?.top ?? anchor.bottom + GAP, left: pos?.left ?? anchor.left, visibility: pos === null ? 'hidden' : undefined }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
        // Focus left for somewhere else on the page (Tab past the last action): close, quietly.
        if (next !== null && ref.current?.contains(next) !== true && openerRef.current?.contains(next) !== true && !inOwnedLayer(next)) closeRef.current();
      }}
    >
      {children}
    </div>
  );

  return createPortal(
    sheet ? (
      <div className="pr-float__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeLatest.current(); }}>
        {body}
      </div>
    ) : (
      body
    ),
    document.body,
  );
}
