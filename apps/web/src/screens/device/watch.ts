// Watching a new app password for its first use (PST-T-16.16): once a profile is installed or a
// password is pasted into a mail app, the screen says "Connected over IMAP at …" by itself. Pure
// and DOM-free apart from timers, so it is unit-tested.

/** How often the screen asks, and for how long before it stops asking. */
export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT_MS = 10 * 60 * 1000;

export interface Observation {
  /** For a one-time link: whether the phone has opened it yet. Always true for a known password. */
  redeemed: boolean;
  lastUsedAt: string | null;
}

/**
 * Calls `check` now and every `intervalMs` until it reports a lastUsedAt, `limitMs` has passed, or
 * the returned stop function is called. A failed check is skipped, not fatal: the next one may work.
 * `onTimeout` runs once if the limit passes first.
 */
export function startWatch(
  check: () => Promise<Observation>,
  onUpdate: (observation: Observation) => void,
  onTimeout: () => void,
  { intervalMs = POLL_INTERVAL_MS, limitMs = POLL_LIMIT_MS, now = () => Date.now() }: { intervalMs?: number; limitMs?: number; now?: () => number } = {},
): () => void {
  const deadline = now() + limitMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = (): void => {
    if (stopped) return;
    check()
      .then((observation) => {
        if (stopped) return;
        onUpdate(observation);
        if (observation.lastUsedAt !== null) stopped = true;
      })
      .catch(() => undefined)
      .finally(() => {
        if (stopped) return;
        if (now() + intervalMs > deadline) {
          stopped = true;
          onTimeout();
          return;
        }
        timer = setTimeout(tick, intervalMs);
      });
  };
  tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** "Connected over IMAP at 3:42 PM" — the time only, since it is minutes ago at most. */
export function connectedMessage(lastUsedAt: string, locale?: string): string {
  const time = new Date(lastUsedAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `Connected over IMAP at ${time}`;
}

/** The port and its transport security, as a mail app's settings screen names them. */
export function securityLabel(security: 'tls' | 'starttls'): string {
  return security === 'tls' ? 'SSL/TLS' : 'STARTTLS';
}
