import { useEffect, useState } from 'react';
import { StatusDot } from '@d3cloud/ui';
import { deviceApi, passwordLastUsed } from './api';
import { POLL_LIMIT_MS, connectedMessage, linkWatchLimit, startWatch, type Observation } from './watch';

/**
 * What to watch: a one-time link (minted when the phone opens it) until two minutes past its
 * expiry, or a password already minted, for ten minutes.
 */
export type Watch = { kind: 'link'; linkId: string; expiresAt: string } | { kind: 'password'; id: string };

export interface FirstUse {
  observation: Observation | null;
  /** True once the watch ran out without a sign-in; the screen stops asking. */
  timedOut: boolean;
}

/**
 * Polls every five seconds — for a link until two minutes past its expiry, for a password ten
 * minutes — and stops on a sign-in, on unmount, or on a new watch.
 */
export function useFirstUse(watch: Watch | null): FirstUse {
  const key = watch === null ? null : watch.kind === 'link' ? `link:${watch.linkId}:${watch.expiresAt}` : `password:${watch.id}`;
  const [state, setState] = useState<{ key: string | null } & FirstUse>({ key: null, observation: null, timedOut: false });

  useEffect(() => {
    if (key === null) return undefined;
    const [kind, id = '', ...rest] = key.split(':');
    // The expiry is an ISO timestamp, colons and all.
    const expiresAt = rest.join(':');
    const check =
      kind === 'link'
        ? () => deviceApi.linkStatus(id)
        : () => passwordLastUsed(id).then((p): Observation => ({ redeemed: true, lastUsedAt: p.lastUsedAt, protocol: null }));
    return startWatch(
      check,
      (observation) => {
        setState({ key, observation, timedOut: false });
      },
      () => {
        setState((current) => ({ ...current, key, timedOut: true }));
      },
      { limitMs: kind === 'link' ? linkWatchLimit(expiresAt) : POLL_LIMIT_MS },
    );
  }, [key]);

  // A state left over from a previous watch is not this one's.
  return state.key === key ? { observation: state.observation, timedOut: state.timedOut } : { observation: null, timedOut: false };
}

/**
 * The line under a freshly minted password or profile: waiting, then "Connected over CalDAV at …"
 * (whichever protocol signed in), or "Connected at …" when the server recorded none.
 * A polite live region, so the change is announced without stealing focus.
 */
export function ConnectionStatus({ watch, waiting }: { watch: Watch; waiting: string }) {
  const { observation, timedOut } = useFirstUse(watch);
  const lastUsedAt = observation?.lastUsedAt ?? null;
  return (
    <p role="status" className="pr-device-status">
      {lastUsedAt !== null ? (
        <StatusDot tone="neutral">{connectedMessage(lastUsedAt, observation?.protocol ?? null)}</StatusDot>
      ) : timedOut ? (
        <StatusDot tone="idle">Not connected yet. Check the app’s settings against the ones below, or try again.</StatusDot>
      ) : (
        <StatusDot tone="idle">{watch.kind === 'link' && observation?.redeemed === true ? 'Profile downloaded. Install it in Settings, then open Mail.' : waiting}</StatusDot>
      )}
    </p>
  );
}
