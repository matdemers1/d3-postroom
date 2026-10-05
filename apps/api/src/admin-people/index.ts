// /api/admin/people — Admin › People (PST-T-20.2, PST-T-20.3): the people with an account here,
// the invites that make new ones, and the accounts waiting out their deletion grace period.
//
// Inviting someone makes a credential-bearing identity (and maybe an admin), and restoring an
// account undoes a deletion the person asked for, so every write needs the same five-minute step-up
// as the other admin mutations. Mounted by app.ts behind requireAdmin.
import { getAuditContext, recordAudit } from '@postroom/audit';
import { AccountKind, AddressKind } from '@postroom/db';
import { Router } from 'express';
import { z } from 'zod';
import { createInvite, INVITE_LOCAL_PART, InviteConflict, inviteState, inviteUrl, restoreAccount } from '../auth/account-lifecycle.js';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CreateInviteBody = z.object({
  /** The new address's local part, or the full address at the primary domain. */
  address: z.string().trim().toLowerCase().min(1).max(320),
  displayName: z.string().trim().max(200).optional(),
  isAdmin: z.boolean().optional(),
});

export function peopleRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/',
    handle(async (_req, res) => {
      const now = rt.now();
      const [accounts, invites] = await Promise.all([
        db.account.findMany({
          where: { kind: AccountKind.person },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            id: true,
            displayName: true,
            isAdmin: true,
            disabledAt: true,
            deleteAfter: true,
            totpEnabled: true,
            createdAt: true,
            addresses: { where: { kind: AddressKind.primary }, select: { localPart: true, domain: { select: { name: true } } }, take: 1 },
          },
        }),
        db.accountInvite.findMany({
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: { createdBy: { select: { displayName: true } } },
        }),
      ]);
      const domain = await db.domain.findFirst({ where: { isPrimary: true }, select: { name: true } });
      res.json({
        domain: domain?.name ?? rt.domain,
        accounts: accounts.map((a) => {
          const primary = a.addresses[0];
          return {
            id: a.id,
            displayName: a.displayName,
            address: primary === undefined ? null : `${primary.localPart}@${primary.domain.name}`,
            isAdmin: a.isAdmin,
            // Accepted an invite but never finished its second factor.
            secondFactor: a.totpEnabled ? 'enrolled' : 'none',
            disabledAt: a.disabledAt?.toISOString() ?? null,
            deleteAfter: a.deleteAfter?.toISOString() ?? null,
            createdAt: a.createdAt.toISOString(),
          };
        }),
        invites: invites.map((i) => ({
          id: i.id,
          address: `${i.localPart}@${domain?.name ?? rt.domain}`,
          displayName: i.displayName,
          isAdmin: i.isAdmin,
          state: inviteState(i, now),
          createdBy: i.createdBy?.displayName ?? null,
          createdAt: i.createdAt.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          acceptedAt: i.acceptedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  router.post(
    '/invites',
    requireStepUp(deps),
    handle(async (req, res) => {
      const parsed = CreateInviteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: 'Name the address to invite.' });
        return;
      }
      const domain = await db.domain.findFirst({ where: { isPrimary: true }, select: { name: true } });
      let localPart = parsed.data.address;
      const at = localPart.lastIndexOf('@');
      if (at >= 0) {
        if (domain === null || localPart.slice(at + 1) !== domain.name) {
          res.status(400).json({ error: 'foreign_domain', message: `Invite an address at ${domain?.name ?? rt.domain}.` });
          return;
        }
        localPart = localPart.slice(0, at);
      }
      if (!INVITE_LOCAL_PART.test(localPart)) {
        res.status(400).json({ error: 'invalid_address', message: 'Use letters, digits, dot, dash or underscore.' });
        return;
      }
      const me = currentSession(req);
      try {
        const invite = await db.$transaction((tx) =>
          createInvite(
            tx,
            { localPart, displayName: parsed.data.displayName === undefined || parsed.data.displayName === '' ? null : parsed.data.displayName, isAdmin: parsed.data.isAdmin ?? false, createdById: me.accountId },
            rt.now(),
            getAuditContext(req),
          ),
        );
        res.setHeader('Cache-Control', 'no-store');
        // The link is shown once: only the token's hash is kept.
        res.status(201).json({
          id: invite.id,
          address: `${invite.localPart}@${invite.domain}`,
          url: inviteUrl(deps.config.webOrigin, invite.token),
          expiresAt: invite.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof InviteConflict) {
          const message =
            error.code === 'address_taken'
              ? 'That address is already in use.'
              : error.code === 'invite_pending'
                ? 'That address already has an invite waiting. Withdraw it first.'
                : 'Finish setup first: there is no primary domain.';
          res.status(409).json({ error: error.code, message });
          return;
        }
        throw error;
      }
    }),
  );

  router.delete(
    '/invites/:id',
    requireStepUp(deps),
    handle(async (req, res) => {
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      const outcome = await db.$transaction(async (tx) => {
        const invite = await tx.accountInvite.findUnique({ where: { id } });
        if (invite === null) return 'not_found' as const;
        if (inviteState(invite, rt.now()) !== 'pending') return 'not_pending' as const;
        await tx.accountInvite.update({ where: { id }, data: { revokedAt: rt.now() } });
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'account.invite.revoke',
          entityType: 'account_invite',
          entityId: id,
          before: { revokedAt: null },
          after: { revokedAt: rt.now().toISOString() },
          context: getAuditContext(req),
        });
        return 'revoked' as const;
      });
      if (outcome === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (outcome === 'not_pending') {
        res.status(409).json({ error: 'not_pending', message: 'That invite has already been used, withdrawn or has expired.' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  // Cancel a deletion during its grace period (PST-ADR-016): the account is enabled again and the
  // purge will pass it by. Its sessions and app passwords stay ended; the person signs in afresh.
  router.post(
    '/accounts/:id/restore',
    requireStepUp(deps),
    handle(async (req, res) => {
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      const outcome = await db.$transaction((tx) => restoreAccount(tx, id, me.accountId, getAuditContext(req)));
      if (outcome === 'not_pending') {
        res.status(409).json({ error: 'not_pending', message: 'That account is not waiting to be deleted.' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
