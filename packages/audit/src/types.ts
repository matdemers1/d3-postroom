import type { ActorKind } from '@postroom/db';

/** Who did it: an authenticated account, or a labeled non-account actor (system/service/anonymous). */
export type Actor =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: Exclude<ActorKind, 'account'>; readonly label?: string };

/**
 * Per-request metadata attached by {@link auditContext} and threaded through to every audit row.
 *
 * `requestId` is always server-generated (never taken from client input): the mutation guard
 * correlates it against audit_event, and a client that could choose its own value could make the
 * guard "see" an unrelated earlier row and stay silent about its own unaudited mutation. A client
 * `x-request-id` header, if sent, is kept only informationally in `clientRequestId` and is never
 * written to the audit log or used for any correlation.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly clientRequestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}
