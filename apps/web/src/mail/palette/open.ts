// Opening the palette from outside it (PST-T-15.5): the list header's search field opens ⌘K search
// rather than being a second search of its own. Whichever palette is mounted — MailView's in Mail,
// Shell's PlacePalette elsewhere, never both — subscribes; the caller needs neither of them. The
// same shape as keys.ts's requestInspect: nothing mounted → nobody listening → nothing happens.
type OpenListener = (query: string | undefined) => void;

const listeners = new Set<OpenListener>();

/** Opens the mounted palette, optionally with text already in its input. */
export function openPalette(query?: string): void {
  for (const listener of [...listeners]) listener(query);
}

/** Subscribes; returns the unsubscribe. */
export function onPaletteOpenRequest(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same function, as a hook, for a component that prefers one: `const open = useOpenPalette()`. */
export function useOpenPalette(): (query?: string) => void {
  return openPalette;
}
