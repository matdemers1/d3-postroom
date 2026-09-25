import type { ActorKind } from '@postroom/db';

/** Who did it: an authenticated account, or a labeled non-account actor (system/service/anonymous). */
export type Actor =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: Exclude<ActorKind, 'account'>; readonly label?: string };

/** Per-request metadata attached by {@link auditContext} and threaded through to every audit row. */
export interface RequestContext {
  readonly requestId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}
