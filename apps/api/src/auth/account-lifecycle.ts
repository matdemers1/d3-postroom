// The account lifecycle of the D3 App contract (PST-P-20, `spec/account-lifecycle.md`): invites that
// make an account (PST-T-20.2) and an account deleting itself (PST-T-20.3, PST-ADR-016).
//
// Invites. An admin names the new account's address and whether it is an admin; the person chooses
// a display name and a password, then enrols an authenticator. The account exists after the first
// step — the token is spent there — and the challenge only finishes its second factor. An account
// left without one (the challenge expired) is finished by presenting the same token with the same
// password again: the invite made exactly one account, and only that account's password reopens it.
// The web page (/invite/<token>) and D3 Constellation take the same two steps; only the session at
// the end differs (a cookie, or native tokens).
//
// Deletion. A current code and the host name typed out; the account is disabled at once, every
// session, app password and push registration ends, and the worker purges it — crypto-shredding the
// mailbox — once the grace period passes (apps/worker/src/account-deletion). An admin can restore
// it until then. The instance's last owner — its last enabled admin who can sign in — cannot.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { recordAudit, type RequestContext } from '@postroom/audit';
import { AccountKind, AddressKind, DEFAULT_MAILBOXES, normalizeLocalPart, randomUidValidity, type Db, type Prisma } from '@postroom/db';
import type { PasswordProblem } from './password-policy.js';

type Tx = Prisma.TransactionClient;

/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an invite's second-factor challenge waits: the contract asks for at least ten minutes. */
export const INVITE_ENROL_TTL_MS = 15 * 60 * 1000;
/** At least the contract's day; a week, so a person who regrets it on Monday can still be helped (PST-ADR-016). */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Advisory lock for deletion decisions, so the last-owner rule sees one request at a time. */
const DELETION_LOCK = 0x5057_0020;

/** A local part an admin may invite: the setup screen's rule. */
export const INVITE_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The web page an invite opens — the link Constellation recognises when one is pasted (CON-T-12.1). */
export function inviteUrl(webOrigin: string, token: string): string {
  return new URL(`/invite/${token}`, webOrigin).toString();
}

/** The words for a refused password, as the contract's weak_password `detail`. */
export function weakPasswordDetail(problems: readonly PasswordProblem[]): string {
  const first = problems[0];
  switch (first) {
    case 'too_short':
      return 'Use at least 12 characters.';
    case 'too_long':
      return 'Use at most 1024 characters.';
    case 'common':
      return 'That is one of the most common breached passwords. Choose another.';
    case 'context_word':
      return 'Don’t build it on Postroom’s own name or the domain’s. Choose something unrelated.';
    default:
      return 'Choose a longer, less common password.';
  }
}

export type InviteState = 'pending' | 'accepted' | 'revoked' | 'expired';

export function inviteState(row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InviteState {
  if (row.acceptedAt !== null) return 'accepted';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export class InviteConflict extends Error {
  constructor(readonly code: 'address_taken' | 'invite_pending' | 'no_domain') {
    super(code);
  }
}

/** A new invite. The token is returned once, here; only its hash is kept. */
export async function createInvite(
  tx: Tx,
  input: { localPart: string; displayName: string | null; isAdmin: boolean; createdById: string },
  now: Date,
  context: RequestContext,
): Promise<{ id: string; token: string; localPart: string; domain: string; expiresAt: Date }> {
  const localPart = normalizeLocalPart(input.localPart);
  const domain = await tx.domain.findFirst({ where: { isPrimary: true } });
  if (domain === null) throw new InviteConflict('no_domain');
  const taken = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId: domain.id } }, select: { id: true } });
  if (taken !== null) throw new InviteConflict('address_taken');
  const pending = await tx.accountInvite.count({ where: { localPart, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } });
  if (pending > 0) throw new InviteConflict('invite_pending');
  const token = newInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const row = await tx.accountInvite.create({
    data: {
      tokenHash: hashInviteToken(token),
      localPart,
      displayName: input.displayName,
      isAdmin: input.isAdmin,
      createdById: input.createdById,
      createdAt: now,
      expiresAt,
    },
  });
  await recordAudit(tx, {
    actor: { kind: 'account', accountId: input.createdById },
    action: 'account.invite.create',
    entityType: 'account_invite',
    entityId: row.id,
    after: { address: `${localPart}@${domain.name}`, isAdmin: input.isAdmin, expiresAt: expiresAt.toISOString() },
    context,
  });
  return { id: row.id, token, localPart, domain: domain.name, expiresAt };
}

/** Why an invite's first step failed: always answered as one `invite_invalid` to the caller. */
export class InviteUnusable extends Error {
  constructor(readonly reason: 'unknown' | 'accepted' | 'revoked' | 'expired' | 'address_taken' | 'no_domain') {
    super(reason);
  }
}

export interface AcceptedInvite {
  accountId: string;
  address: string;
  /** False: a fresh account. True: the invite's own account, still without its second factor. */
  resumed: boolean;
}

/**
 * The first step: the account, from a live invite, in one transaction with the token spent — so two
 * presentations racing with one token make one account. `passwordHash` is computed by the caller
 * before the transaction (Argon2id is too slow to hold row locks through).
 */
export async function acceptInvite(
  db: Db,
  input: { token: string; displayName: string; passwordHash: string },
  now: Date,
  context: RequestContext,
): Promise<AcceptedInvite> {
  return db.$transaction(async (tx) => {
    const invite = await tx.accountInvite.findUnique({ where: { tokenHash: hashInviteToken(input.token) } });
    if (invite === null) throw new InviteUnusable('unknown');
    const state = inviteState(invite, now);
    if (state !== 'pending') throw new InviteUnusable(state);
    const domain = await tx.domain.findFirst({ where: { isPrimary: true } });
    if (domain === null) throw new InviteUnusable('no_domain');
    // Spent first, conditionally: the loser of a race sees zero rows and makes nothing.
    const { count } = await tx.accountInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (count !== 1) throw new InviteUnusable('accepted');
    const taken = await tx.address.findUnique({ where: { localPart_domainId: { localPart: invite.localPart, domainId: domain.id } }, select: { id: true } });
    if (taken !== null) throw new InviteUnusable('address_taken');
    const account = await tx.account.create({
      data: { displayName: input.displayName, isAdmin: invite.isAdmin, kind: AccountKind.person, passwordHash: input.passwordHash, createdAt: now },
    });
    for (const mb of DEFAULT_MAILBOXES) {
      await tx.mailbox.create({ data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    await tx.address.create({ data: { localPart: invite.localPart, domainId: domain.id, kind: AddressKind.primary, accountId: account.id } });
    await tx.accountInvite.update({ where: { id: invite.id }, data: { accountId: account.id } });
    const address = `${invite.localPart}@${domain.name}`;
    await recordAudit(tx, {
      actor: { kind: 'account', accountId: account.id },
      action: 'account.invite.accept',
      entityType: 'account',
      entityId: account.id,
      after: { inviteId: invite.id, address, displayName: input.displayName, isAdmin: invite.isAdmin, secondFactor: 'pending' },
      context,
    });
    return { accountId: account.id, address, resumed: false };
  });
}

/**
 * A spent invite whose account never finished its second factor: the account to resume, when the
 * password presented is that account's (checked by the caller), or null.
 */
export async function resumableInvite(db: Db, token: string): Promise<{ accountId: string; passwordHash: string; address: string } | null> {
  const invite = await db.accountInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: { acceptedAt: true, revokedAt: true, account: { select: { id: true, passwordHash: true, totpEnabled: true, disabledAt: true, addresses: { where: { kind: AddressKind.primary }, select: { localPart: true, domain: { select: { name: true } } } } } } },
  });
  const account = invite?.account ?? null;
  if (invite === null || invite.acceptedAt === null || invite.revokedAt !== null || account === null) return null;
  if (account.totpEnabled || account.disabledAt !== null || account.passwordHash === null) return null;
  const primary = account.addresses[0];
  return { accountId: account.id, passwordHash: account.passwordHash, address: primary === undefined ? '' : `${primary.localPart}@${primary.domain.name}` };
}

/** Whether another enabled admin who can sign in exists: what makes `accountId` not the last owner. */
export async function hasOtherOwner(tx: Tx | Db, accountId: string): Promise<boolean> {
  const others = await tx.account.count({
    where: {
      id: { not: accountId },
      isAdmin: true,
      kind: AccountKind.person,
      disabledAt: null,
      OR: [{ passwordHash: { not: null } }, { identityLinks: { some: {} } }],
    },
  });
  return others > 0;
}

export type DeletionOutcome = { kind: 'scheduled'; graceUntil: Date } | { kind: 'last_owner' } | { kind: 'gone' };

/**
 * Schedule this account's deletion (PST-ADR-016). The caller has proven the person with a current
 * code. Disabled now; every session (web, native, D3 Auth token rows), app password and push
 * registration ends in the same commit.
 */
export async function requestDeletion(tx: Tx, accountId: string, now: Date, context: RequestContext): Promise<DeletionOutcome> {
  // One deletion decision at a time, so two admins deleting themselves at once cannot both be "not last".
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DELETION_LOCK})`;
  const account = await tx.account.findUnique({ where: { id: accountId }, select: { isAdmin: true, disabledAt: true, kind: true } });
  if (account === null || account.disabledAt !== null || account.kind !== AccountKind.person) return { kind: 'gone' };
  if (account.isAdmin && !(await hasOtherOwner(tx, accountId))) return { kind: 'last_owner' };
  const graceUntil = new Date(now.getTime() + DELETION_GRACE_MS);
  await tx.account.update({ where: { id: accountId }, data: { disabledAt: now, deletionRequestedAt: now, deleteAfter: graceUntil } });
  const sessions = await tx.session.deleteMany({ where: { accountId } });
  const appPasswords = await tx.appPassword.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } });
  const registrations = await tx.relayRegistration.deleteMany({ where: { accountId } });
  await recordAudit(tx, {
    actor: { kind: 'account', accountId },
    action: 'account.delete.request',
    entityType: 'account',
    entityId: accountId,
    before: { disabledAt: null },
    after: {
      disabledAt: now.toISOString(),
      deleteAfter: graceUntil.toISOString(),
      sessionsEnded: sessions.count,
      appPasswordsRevoked: appPasswords.count,
      pushRegistrationsRemoved: registrations.count,
    },
    context,
  });
  return { kind: 'scheduled', graceUntil };
}


/** An admin restores an account during its grace period: re-enabled, the schedule cleared. */
export async function restoreAccount(tx: Tx, accountId: string, adminId: string, context: RequestContext): Promise<'restored' | 'not_pending'> {
  const account = await tx.account.findUnique({ where: { id: accountId }, select: { deleteAfter: true, disabledAt: true } });
  if (account === null || account.deleteAfter === null) return 'not_pending';
  await tx.account.update({ where: { id: accountId }, data: { disabledAt: null, deletionRequestedAt: null, deleteAfter: null } });
  await recordAudit(tx, {
    actor: { kind: 'account', accountId: adminId },
    action: 'account.delete.cancel',
    entityType: 'account',
    entityId: accountId,
    before: { disabledAt: account.disabledAt?.toISOString() ?? null, deleteAfter: account.deleteAfter.toISOString() },
    after: { disabledAt: null, deleteAfter: null },
    context,
  });
  return 'restored';
}
