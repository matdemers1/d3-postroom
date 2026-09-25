// Creating, listing and revoking app passwords. Every mutation goes through `audited()`
// (PST-REQ-009); the hash never leaves this module and the plaintext is returned exactly once.
import { audited, type Actor, type RequestContext } from '@postroom/audit';
import { AppPasswordScope, type AppPassword, type Db } from '@postroom/db';
import { generateAppPassword } from './generate.js';
import { hashAppPassword } from './hash.js';

export const APP_PASSWORD_SCOPES: readonly AppPasswordScope[] = [
  AppPasswordScope.imap,
  AppPasswordScope.smtp,
  AppPasswordScope.dav,
  AppPasswordScope.sieve,
];
export const MAX_LABEL_LENGTH = 100;

export type CredentialErrorCode = 'invalid_label' | 'invalid_scopes' | 'invalid_cap' | 'account_not_found' | 'account_disabled';

/** A refusal the caller can show: bad input or an account that cannot hold app passwords. */
export class CredentialError extends Error {
  override readonly name = 'CredentialError';
  constructor(readonly code: CredentialErrorCode) {
    super(code);
  }
}

/** An app password as anyone outside this package sees it: no hash, ever. */
export interface AppPasswordView {
  readonly id: string;
  readonly accountId: string;
  readonly label: string;
  readonly prefix: string;
  readonly scopes: AppPasswordScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly revokedAt: Date | null;
  readonly dailyRecipientCap: number | null;
  readonly frozenAt: Date | null;
}

export function toView(row: AppPassword): AppPasswordView {
  return {
    id: row.id,
    accountId: row.accountId,
    label: row.label,
    prefix: row.prefix,
    scopes: [...row.scopes],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    dailyRecipientCap: row.dailyRecipientCap,
    frozenAt: row.frozenAt,
  };
}

export function isScope(value: unknown): value is AppPasswordScope {
  return typeof value === 'string' && (APP_PASSWORD_SCOPES as readonly string[]).includes(value);
}

export interface CreateAppPasswordInput {
  readonly accountId: string;
  readonly label: string;
  readonly scopes: readonly AppPasswordScope[];
  readonly dailyRecipientCap?: number | null;
}

export interface CredentialOptions {
  /** PASSWORD_PEPPER: argon2's `secret`, the same one the account password uses. */
  readonly pepper: string;
  readonly context?: RequestContext;
}

export interface CreatedAppPassword {
  readonly appPassword: AppPasswordView;
  /** The plaintext, grouped for display. Returned here once and never again. */
  readonly password: string;
}

export async function createAppPassword(
  db: Db,
  actor: Actor,
  input: CreateAppPasswordInput,
  options: CredentialOptions,
): Promise<CreatedAppPassword> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) throw new CredentialError('invalid_label');
  const scopes = APP_PASSWORD_SCOPES.filter((s) => input.scopes.includes(s));
  if (scopes.length === 0 || input.scopes.some((s) => !isScope(s))) throw new CredentialError('invalid_scopes');
  const cap = input.dailyRecipientCap ?? null;
  if (cap !== null && !(Number.isInteger(cap) && cap > 0 && cap <= 1_000_000)) throw new CredentialError('invalid_cap');

  const account = await db.account.findUnique({ where: { id: input.accountId }, select: { id: true, disabledAt: true } });
  if (account === null) throw new CredentialError('account_not_found');
  if (account.disabledAt !== null) throw new CredentialError('account_disabled');

  // A 40-bit prefix collides with vanishing probability; drawing again costs nothing.
  let generated = generateAppPassword();
  while ((await db.appPassword.findUnique({ where: { prefix: generated.prefix }, select: { id: true } })) !== null) {
    generated = generateAppPassword();
  }
  const hash = await hashAppPassword(generated.normalized, options.pepper);

  const row = await audited(
    db,
    actor,
    { action: 'app_password.create', entityType: 'app_password', ...(options.context ? { context: options.context } : {}) },
    async (tx) => {
      const created = await tx.appPassword.create({
        data: { accountId: account.id, label, prefix: generated.prefix, hash, scopes, dailyRecipientCap: cap },
      });
      return {
        entityId: created.id,
        before: null,
        after: { accountId: created.accountId, label, prefix: created.prefix, scopes, dailyRecipientCap: cap },
        result: created,
      };
    },
  );
  return { appPassword: toView(row), password: generated.display };
}

export interface RevokeAppPasswordInput {
  readonly id: string;
  /** When set, the password must belong to this account; otherwise it is "not found". */
  readonly accountId?: string;
}

/**
 * Revoke now. The verifier reads `revoked_at` on every login and caches nothing, so the very next
 * AUTH with this password fails. Null when there is no such live password (unknown id, another
 * account's, or already revoked) — nothing is written and nothing is audited then.
 */
export async function revokeAppPassword(
  db: Db,
  actor: Actor,
  input: RevokeAppPasswordInput,
  options: { readonly now?: Date; readonly context?: RequestContext } = {},
): Promise<AppPasswordView | null> {
  const now = options.now ?? new Date();
  return audited(
    db,
    actor,
    { action: 'app_password.revoke', entityType: 'app_password', ...(options.context ? { context: options.context } : {}) },
    async (tx) => {
      const where = { id: input.id, revokedAt: null, ...(input.accountId === undefined ? {} : { accountId: input.accountId }) };
      const { count } = await tx.appPassword.updateMany({ where, data: { revokedAt: now } });
      if (count === 0) throw new NothingToRevoke();
      const row = await tx.appPassword.findUniqueOrThrow({ where: { id: input.id } });
      return {
        entityId: row.id,
        before: { revokedAt: null },
        after: { accountId: row.accountId, label: row.label, prefix: row.prefix, revokedAt: now.toISOString() },
        result: toView(row),
      };
    },
  ).catch((error: unknown) => {
    // Thrown inside the transaction so no audit row is written for a no-op.
    if (error instanceof NothingToRevoke) return null;
    throw error;
  });
}

class NothingToRevoke extends Error {}

/** An account's app passwords, newest first, without hashes. Revoked ones only when asked. */
export async function listAppPasswords(
  db: Db,
  accountId: string,
  options: { readonly includeRevoked?: boolean } = {},
): Promise<AppPasswordView[]> {
  const rows = await db.appPassword.findMany({
    where: { accountId, ...(options.includeRevoked === true ? {} : { revokedAt: null }) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}
