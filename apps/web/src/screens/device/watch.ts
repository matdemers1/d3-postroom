// Watching a new app password for its first use (PST-T-16.16): once a profile is installed or a
// password is pasted into a mail app, the screen says "Connected over CalDAV at …" by itself, naming
// the protocol that actually signed in (PST-T-16.27). Pure and DOM-free apart from timers, so it is
// unit-tested.
import type { UseProtocol } from './api';

/** How often the screen asks, and for how long before it stops asking. */
export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT_MS = 10 * 60 * 1000;
/**
 * How long a one-time link's watch outlives the link: a phone that opened it in its last minute is
 * still installing the profile and signing in after it expires.
 */
export const LINK_GRACE_MS = 2 * 60 * 1000;

export interface Observation {
  /** For a one-time link: whether the phone has opened it yet. Always true for a known password. */
  redeemed: boolean;
  lastUsedAt: string | null;
  /** The protocol that signed in, when the server recorded one. */
  protocol: UseProtocol;
}

/** How long to watch a link that expires at `expiresAt`: until two minutes past it. */
export function linkWatchLimit(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, new Date(expiresAt).getTime() + LINK_GRACE_MS - now);
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

/**
 * The protocol as a mail app's settings name it. The `dav` scope covers both CalDAV and CardDAV; an
 * iPhone profile's Calendar account is the one that signs in, so it is named for that.
 */
const PROTOCOL_LABELS: Record<Exclude<UseProtocol, null>, string> = { imap: 'IMAP', smtp: 'SMTP', dav: 'CalDAV', sieve: 'ManageSieve' };

/**
 * "Connected over CalDAV at 3:42 PM" — the time only, since it is minutes ago at most — or just
 * "Connected at 3:42 PM" when the server recorded no protocol.
 */
export function connectedMessage(lastUsedAt: string, protocol: UseProtocol, locale?: string): string {
  const time = new Date(lastUsedAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return protocol === null ? `Connected at ${time}` : `Connected over ${PROTOCOL_LABELS[protocol]} at ${time}`;
}

/** The port and its transport security, as a mail app's settings screen names them. */
export function securityLabel(security: 'tls' | 'starttls'): string {
  return security === 'tls' ? 'SSL/TLS' : 'STARTTLS';
}
