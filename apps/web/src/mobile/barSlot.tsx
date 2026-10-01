// PST-T-17.8 (PST-REQ-155; critique-admin X11): the context bar's trailing slot. On a phone a page's
// one utility action (Refresh, Re-check) belongs in the bar as an IconButton, not as a full-width
// slab under the h1 — but the bar is drawn by Shell and the action by the page. A page hands its
// action up through this slot:
//
//   // In a page. `inBar` is true only when a context bar is drawn above it (a phone push screen).
//   const inBar = useContextBarAction(
//     <IconButton icon={<RefreshIcon />} label="Refresh" onClick={reload} />,
//   );
//   <PageHeader title="Outbound queue" actions={inBar ? undefined : <Button onClick={reload}>Refresh</Button>} />
//
//   // Or, declaratively, anywhere in the page's tree (renders nothing where it stands):
//   <ContextBarAction><IconButton icon={<RefreshIcon />} label="Refresh" onClick={reload} /></ContextBarAction>
//
// Shell makes one slot per push screen (`createBarSlot`), provides it with `ContextBarSlotProvider`
// around the page, and passes it to `<ContextBar slot={…}>`, which draws whatever is registered
// after its own `actions`. A registration lasts while the page is mounted; the newest one wins, so a
// screen swapping its content never leaves a stale button behind. On a desktop there is no provider:
// the hook registers nothing and returns false, and the page keeps the action in its PageHeader.
import { createContext, useContext, useEffect, useId, useSyncExternalStore, type ReactNode } from 'react';

export interface BarSlot {
  /** The action now showing in the bar: the newest registration's, or null. */
  get: () => ReactNode;
  /** Registers (or replaces) `owner`'s action. */
  set: (owner: string, node: ReactNode) => void;
  /** Withdraws `owner`'s action; any other registration stays. */
  clear: (owner: string) => void;
  subscribe: (listener: () => void) => () => void;
}

/** A slot. Pure: no React, no DOM. */
export function createBarSlot(): BarSlot {
  // Insertion order is registration order; re-registering an owner keeps its place, so a page
  // re-rendering its action never jumps ahead of one registered after it.
  const entries = new Map<string, ReactNode>();
  const listeners = new Set<() => void>();
  let current: ReactNode = null;
  const recompute = (): void => {
    let next: ReactNode = null;
    for (const node of entries.values()) next = node;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => current,
    set: (owner, node) => {
      entries.set(owner, node);
      recompute();
    },
    clear: (owner) => {
      if (!entries.delete(owner)) return;
      recompute();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const SlotContext = createContext<BarSlot | null>(null);

/** Shell wraps a phone push screen's page in this, with the slot its ContextBar draws. */
export const ContextBarSlotProvider = SlotContext.Provider;

/** True when a context bar is drawn above this page (a phone push screen), so the page should not
 * draw a second Back or a duplicate utility action of its own. */
export function useHasContextBar(): boolean {
  return useContext(SlotContext) !== null;
}

/**
 * Puts `node` (one IconButton) in the context bar's trailing slot while the calling component is
 * mounted. Returns whether there is a bar to put it in; without one, nothing is registered.
 */
export function useContextBarAction(node: ReactNode): boolean {
  const slot = useContext(SlotContext);
  const owner = useId();
  useEffect(() => {
    if (slot === null) return undefined;
    slot.set(owner, node);
    return undefined;
  }, [slot, owner, node]);
  useEffect(() => {
    if (slot === null) return undefined;
    return () => {
      slot.clear(owner);
    };
  }, [slot, owner]);
  return slot !== null;
}

/** The declarative form of `useContextBarAction`: renders nothing in place. */
export function ContextBarAction({ children }: { children: ReactNode }) {
  useContextBarAction(children);
  return null;
}

const EMPTY: BarSlot = createBarSlot();

/** What a slot holds now, re-rendering on change; null without a slot. */
export function useBarSlotAction(slot: BarSlot | null | undefined): ReactNode {
  const s = slot ?? EMPTY;
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
