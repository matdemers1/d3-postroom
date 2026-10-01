import { useEffect, useState } from 'react';
import { StatusDot } from '@d3cloud/ui';
import { deviceApi, passwordLastUsed } from './api';
import { connectedMessage, startWatch, type Observation } from './watch';

/** What to watch: a one-time link (minted when the phone opens it), or a password already minted. */
export type Watch = { kind: 'link'; linkId: string } | { kind: 'password'; id: string };

export interface FirstUse {
  observation: Observation | null;
  /** True once ten minutes passed without a sign-in; the screen stops asking. */
  timedOut: boolean;
}

/** Polls every five seconds for up to ten minutes; stops on a sign-in, on unmount, or on a new watch. */
export function useFirstUse(watch: Watch | null): FirstUse {
  const key = watch === null ? null : watch.kind === 'link' ? `link:${watch.linkId}` : `password:${watch.id}`;
  const [state, setState] = useState<{ key: string | null } & FirstUse>({ key: null, observation: null, timedOut: false });

  useEffect(() => {
    if (key === null) return undefined;
    const [kind, id = ''] = key.split(':');
    const check =
      kind === 'link'
        ? () => deviceApi.linkStatus(id)
        : () => passwordLastUsed(id).then((p): Observation => ({ redeemed: true, lastUsedAt: p.lastUsedAt }));
    return startWatch(
      check,
      (observation) => {
        setState({ key, observation, timedOut: false });
      },
      () => {
        setState((current) => ({ ...current, key, timedOut: true }));
      },
    );
  }, [key]);

  // A state left over from a previous watch is not this one's.
  return state.key === key ? { observation: state.observation, timedOut: state.timedOut } : { observation: null, timedOut: false };
}

/**
 * The line under a freshly minted password or profile: waiting, then "Connected over IMAP at …".
 * A polite live region, so the change is announced without stealing focus.
 */
export function ConnectionStatus({ watch, waiting }: { watch: Watch; waiting: string }) {
  const { observation, timedOut } = useFirstUse(watch);
  const lastUsedAt = observation?.lastUsedAt ?? null;
  return (
    <p role="status" className="pr-device-status">
      {lastUsedAt !== null ? (
        <StatusDot tone="neutral">{connectedMessage(lastUsedAt)}</StatusDot>
      ) : timedOut ? (
        <StatusDot tone="idle">Not connected yet. Check the app’s settings against the ones below, or try again.</StatusDot>
      ) : (
        <StatusDot tone="idle">{watch.kind === 'link' && observation?.redeemed === true ? 'Profile downloaded. Install it in Settings, then open Mail.' : waiting}</StatusDot>
      )}
    </p>
  );
}
