// /api/account/identities — the D3 Auth identities linked to the signed-in account, and unlinking
// one (PST-REQ-202, PST-ADR-014). Linking stays the /api/auth/oidc/start?link=1 round trip. Mounted
// behind requireSession; only the caller's own links are ever visible or removable.
import { getAuditContext, recordAudit } from '@postroom/audit';
import { Router } from 'express';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { currentSession, handle, requireStepUp } from './middleware.js';
import { runtimeFor } from './runtime.js';
import { clearSessionCookie, deleteSession } from './sessions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LinkedIdentity = z.object({
  id: z.uuid(),
  issuer: z.string(),
  email: z.string().nullable(),
  linkedAt: z.string().describe('When the link was made (the row’s created_at), ISO 8601.'),
  lastUsedAt: z.string().nullable().describe('The last sign-in through it, ISO 8601, or null.'),
});
export const LinkedIdentityList = z.array(LinkedIdentity);
export const IdentityParams = z.object({ id: z.uuid() });
export const UnlinkResult = z.object({
  ok: z.literal(true),
  /** Sessions that had signed in through the identity, now ended. */
  endedSessions: z.number().int(),
  /** The caller's own session was one of them: the cookie is cleared and the caller signed out. */
  signedOut: z.boolean(),
});

export function accountIdentityRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/identities',
    handle(async (req, res) => {
      const me = currentSession(req);
      const rows = await db.identityLink.findMany({
        where: { accountId: me.accountId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, issuer: true, email: true, createdAt: true, lastUsedAt: true },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        rows.map((row) => ({
          id: row.id,
          issuer: row.issuer,
          email: row.email,
          linkedAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
      );
    }),
  );

  // Removing a way into the account needs a fresh second factor. The sessions that signed in through
  // the identity end with it: the link they rest on is gone.
  router.delete(
    '/identities/:id',
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const id = String(req.params['id']);
      const link = UUID.test(id) ? await db.identityLink.findUnique({ where: { id } }) : null;
      // Someone else's link is not found, never forbidden, so its existence is not leaked.
      if (link === null || link.accountId !== me.accountId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const context = getAuditContext(req);
      const ended = await db.$transaction(async (tx) => {
        // The last way in: an account with no password whose only identity this is would be locked
        // out for good. Counted inside the commit, so two unlinks cannot each leave the other last.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-identity-unlink:' + me.accountId}, 0))`;
        const account = await tx.account.findUniqueOrThrow({ where: { id: me.accountId }, select: { passwordHash: true } });
        const links = await tx.identityLink.count({ where: { accountId: me.accountId } });
        if (account.passwordHash === null && links <= 1) return null;
        await tx.identityLink.delete({ where: { id: link.id } });
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'auth.identity.unlink',
          entityType: 'identity_link',
          entityId: link.id,
          before: { issuer: link.issuer, subject: link.subject, email: link.email, linkedAt: link.createdAt },
          after: null,
          context,
        });
        // Only this account's sessions that came through this (iss, sub) — never a password session.
        const sessions = await tx.session.findMany({
          where: { accountId: me.accountId, method: 'oidc', oidcIssuer: link.issuer, oidcSubject: link.subject },
          select: { id: true },
        });
        const ids: string[] = [];
        for (const s of sessions) {
          await deleteSession(tx, s.id);
          ids.push(s.id);
        }
        if (ids.length > 0) {
          await recordAudit(tx, {
            actor: { kind: 'account', accountId: me.accountId },
            action: 'auth.session.revoke-identity',
            entityType: 'identity_link',
            entityId: link.id,
            after: { ended: ids, reason: 'identity_unlinked' },
            context,
          });
        }
        return ids;
      });
      if (ended === null) {
        res.status(409).json({ error: 'last_sign_in_method' });
        return;
      }
      const signedOut = ended.includes(me.sessionId);
      if (signedOut) clearSessionCookie(res, rt.secure);
      res.json({ ok: true, endedSessions: ended.length, signedOut });
    }),
  );

  return router;
}
