// The one login check the protocol daemons call (PST-REQ-027): submission, IMAP, DAV and
// ManageSieve accept an app password and nothing else. The account's web password is never looked
// at here — not even to reject it — so there is no code path by which it could be accepted.
//
// Every call does exactly one Argon2id verify, whether the username exists, the password parses,
// or its prefix matches a row: an unknown user, an unknown prefix and a wrong password cost the
// same time. Nothing is cached, so a revocation, a disabled account or a freeze applies to the
// very next login.
import { AddressKind, type AppPasswordScope, type Db, normalizeDomain, normalizeLocalPart } from '@postroom/db';
import { decoyAppPasswordHash, verifyAppPasswordHash } from './hash.js';
import { parseAppPassword } from './generate.js';

export interface ProtocolLoginRequest {
  /** One of the account's own addresses (primary or service), any case. */
  readonly username: string;
  readonly password: string;
  readonly scope: AppPasswordScope;
  /** The client's address, recorded as last-used. */
  readonly ip: string | null;
}

export interface ProtocolLoginOptions {
  /** PASSWORD_PEPPER, the same value the web password is hashed with. */
  readonly pepper: string;
  readonly now?: Date;
}

/**
 * Why a login failed. For logs and throttling only: a daemon answers every one of these with the
 * same generic refusal (SMTP 535 5.7.8, IMAP NO [AUTHENTICATIONFAILED]) except, if it chooses,
 * `frozen`, which the owner needs to hear about.
 */
export type ProtocolLoginFailure =
  | 'unknown_user'
  | 'bad_password'
  | 'revoked'
  | 'account_disabled'
  | 'wrong_scope'
  | 'frozen';

export type ProtocolLoginResult =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly appPasswordId: string;
      /** The account's live addresses (`local@domain`), which it may send as. */
      readonly addresses: string[];
    }
  | { readonly ok: false; readonly reason: ProtocolLoginFailure };

/** The account an address-shaped username names, or null. Only primary and service addresses log in. */
async function resolveAccountId(db: Db, username: string): Promise<string | null> {
  if (username.length > 320) return null;
  const at = username.lastIndexOf('@');
  if (at <= 0 || at === username.length - 1) return null;
  let localPart: string;
  let domain: string;
  try {
    localPart = normalizeLocalPart(username.slice(0, at));
    domain = normalizeDomain(username.slice(at + 1));
  } catch {
    return null;
  }
  const address = await db.address.findFirst({
    where: {
      localPart,
      domain: { name: domain },
      kind: { in: [AddressKind.primary, AddressKind.service] },
      killedAt: null,
      accountId: { not: null },
    },
    select: { accountId: true },
  });
  return address?.accountId ?? null;
}

export async function verifyProtocolLogin(
  db: Db,
  request: ProtocolLoginRequest,
  options: ProtocolLoginOptions,
): Promise<ProtocolLoginResult> {
  const now = options.now ?? new Date();
  const accountId = await resolveAccountId(db, request.username);
  const parsed = parseAppPassword(request.password);
  const row =
    parsed === null
      ? null
      : await db.appPassword.findUnique({
          where: { prefix: parsed.prefix },
          include: { account: { select: { disabledAt: true } } },
        });
  // A row is only a candidate for the account the username named; anything else hashes the decoy.
  const candidate = row !== null && accountId !== null && row.accountId === accountId ? row : null;
  const matched = await verifyAppPasswordHash(
    candidate?.hash ?? (await decoyAppPasswordHash(options.pepper)),
    parsed?.normalized ?? request.password,
    options.pepper,
  );

  if (accountId === null) return { ok: false, reason: 'unknown_user' };
  if (candidate === null || parsed === null || !matched) return { ok: false, reason: 'bad_password' };
  if (candidate.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (candidate.account.disabledAt !== null) return { ok: false, reason: 'account_disabled' };
  if (!candidate.scopes.includes(request.scope)) return { ok: false, reason: 'wrong_scope' };
  if (request.scope === 'smtp' && candidate.frozenAt !== null) return { ok: false, reason: 'frozen' };

  // Conditional on still being live, so a revocation that lands between the read and here wins.
  // Last-used is not audited: it is a login, not a mutation anyone made, and would drown the log.
  const { count } = await db.appPassword.updateMany({
    where: { id: candidate.id, revokedAt: null },
    data: { lastUsedAt: now, lastUsedIp: request.ip },
  });
  if (count === 0) return { ok: false, reason: 'revoked' };

  const addresses = await db.address.findMany({
    where: { accountId, killedAt: null },
    select: { localPart: true, domain: { select: { name: true } } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });
  return {
    ok: true,
    accountId,
    appPasswordId: candidate.id,
    addresses: addresses.map((a) => `${a.localPart}@${a.domain.name}`),
  };
}
