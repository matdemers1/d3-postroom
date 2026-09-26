// PST-T-11.1 (PST-P-11): the designed loading and load-failed states every data screen shares, so a
// screen is never a blank area while it waits and never shows a raw error when its call fails.
//
//   - Loading: @d3cloud/ui's Skeleton is aria-hidden scaffolding by design, and its `block`
//     variant has no height of its own (a bare <Skeleton variant="block" /> is a zero-height, blank
//     area). Here it gets a height, and a container that says what is loading — role="status" with
//     an accessible name, and aria-busy while it is there.
//   - LoadFailed: one component for the three ways a screen's own data call fails. A 401 means the
//     session ended while the page was open (signed out elsewhere, expired, revoked) — say so, and
//     offer the way back in. A 403 means this account may not see it. Anything else is the server
//     not answering, with Try again.
import type { ReactNode } from 'react';
import { Button, EmptyState, Link, Skeleton, Stack } from '@d3cloud/ui';
import { ApiError } from '../api';

export function Loading({ label, height = 160, lines }: { label: string; height?: number; lines?: number }) {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {lines === undefined ? (
        <Skeleton variant="block" height={height} />
      ) : (
        <Stack gap="12">
          <Skeleton variant="text" lines={lines} />
          <Skeleton variant="block" height={height} />
        </Stack>
      )}
    </div>
  );
}

export type LoadFailure = 'signed-out' | 'forbidden' | 'error';

export function failureOf(error: unknown): LoadFailure {
  if (error instanceof ApiError && error.status === 401) return 'signed-out';
  if (error instanceof ApiError && error.status === 403) return 'forbidden';
  return 'error';
}

/** The full-page load to /signin: the Gate asks the server again and shows Sign in. */
export function SessionEnded({ headingLevel = 2, size }: { headingLevel?: 2 | 3 | 4; size?: 'inline' | 'row' }) {
  return (
    <EmptyState
      kind="no-access"
      heading="Your session has ended"
      headingLevel={headingLevel}
      {...(size === undefined ? {} : { size })}
      action={<Link href="/signin">Sign in again</Link>}
    >
      You were signed out, perhaps from another device. Sign in again to carry on.
    </EmptyState>
  );
}

export function NoAccess({ headingLevel = 2, children }: { headingLevel?: 2 | 3 | 4; children?: ReactNode }) {
  return (
    <EmptyState kind="no-access" heading="You do not have access to this" headingLevel={headingLevel}>
      {children ?? 'This screen is for Postroom administrators. Ask the operator if you need it.'}
    </EmptyState>
  );
}

/**
 * What a screen shows when its own data call failed. `what` finishes "Could not load …".
 * `error` is whatever the call threw (or `true` when a screen only knows that it failed).
 */
export function LoadFailed({
  error,
  what,
  onRetry,
  headingLevel = 2,
  size,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
  headingLevel?: 2 | 3 | 4;
  size?: 'inline' | 'row';
}) {
  const failure = failureOf(error);
  if (failure === 'signed-out') return <SessionEnded headingLevel={headingLevel} {...(size === undefined ? {} : { size })} />;
  if (failure === 'forbidden') return <NoAccess headingLevel={headingLevel} />;
  return (
    <EmptyState
      kind="error"
      heading={`Could not load ${what}`}
      headingLevel={headingLevel}
      {...(size === undefined ? {} : { size })}
      {...(onRetry === undefined ? {} : { action: <Button onClick={onRetry}>Try again</Button> })}
    >
      The server did not answer. Your data is safe; try again in a moment.
    </EmptyState>
  );
}
