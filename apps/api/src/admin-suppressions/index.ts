// /api/admin/suppressions — the suppression list (PST-T-11.10). Mounted by app.ts behind
// requireAdmin; every mutation also needs a fresh step-up (PST-REQ-008) and is audited.
//
//   PST-REQ-178  list suppressed addresses with the bounce that caused each; add or remove one.
//   PST-REQ-181  every change is an audit row naming the address, the actor and the reason
//                (admin.suppression.add / admin.suppression.remove; the delivery worker's own
//                additions are suppression.add, actor system).
//
// What the list *does* lives elsewhere: the delivery worker adds 5.1.x hard bounces
// (apps/delivery/src/suppression.ts) and every sending path refuses a listed recipient
// (acceptSubmission, and SMTP RCPT). Removing an entry is all it takes to allow mail again: both
// read the table at send time, so there is nothing to invalidate.
import { audited, getAuditContext } from '@postroom/audit';
import { suppressionKey } from '@postroom/delivery';
import type { Prisma, SuppressedRecipient } from '@postroom/db';
import { Router } from 'express';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { AddSuppressionBody, RemoveSuppressionBody, SuppressionAddress, SuppressionListQuery, SuppressionParams, type SuppressionJson } from './schemas.js';

const DEFAULT_LIMIT = 100;

type Row = SuppressedRecipient & { sourceRecipient: { id: string; outboundMessageId: string; message: { subject: string | null } } | null };

const INCLUDE = { sourceRecipient: { select: { id: true, outboundMessageId: true, message: { select: { subject: true } } } } } as const;

function suppressionJson(r: Row): SuppressionJson {
  return {
    id: r.id,
    address: r.address,
    reason: r.reason === 'manual' ? 'manual' : 'hard-bounce',
    code: r.code,
    enhanced: r.enhanced,
    text: r.text,
    bounceCount: r.bounceCount,
    firstAt: r.firstAt.toISOString(),
    lastAt: r.lastAt.toISOString(),
    note: r.note,
    source: r.sourceRecipient === null ? null : { recipientId: r.sourceRecipient.id, outboundMessageId: r.sourceRecipient.outboundMessageId, subject: r.sourceRecipient.message.subject },
  };
}

/** What an audit row says about an entry: the address and why it is (or was) listed. */
function auditView(r: SuppressedRecipient): Record<string, unknown> {
  return { address: r.address, reason: r.reason, code: r.code, enhanced: r.enhanced, text: r.text, bounceCount: r.bounceCount, note: r.note };
}

class AlreadyListed extends Error {}
class NotListed extends Error {}

export function adminSuppressionRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  // POST /api/admin/suppressions/dev-seed-bounce — e2e only (POSTROOM_E2E_SEED=1, the same gate as
  // admin-queue's dev-seed-deferred): a hard-bounce entry, as the delivery worker would write it,
  // for e2e/tests/admin-suppressions.spec.ts, without a live remote MX to bounce off.
  router.post(
    '/dev-seed-bounce',
    handle(async (req, res) => {
      if (deps.env['POSTROOM_E2E_SEED'] !== '1') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = SuppressionAddress.safeParse((req.body as { address?: unknown } | undefined)?.address);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      const now = rt.now();
      const address = suppressionKey(parsed.data);
      // Audited like every other mutation (PST-REQ-009), e2e-only or not.
      const row = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.dev.seed-suppression', entityType: 'suppressed_recipient', context: getAuditContext(req) },
        async (tx) => {
          const seeded = await tx.suppressedRecipient.upsert({
            where: { address },
            create: { address, reason: 'hard-bounce', code: 550, enhanced: '5.1.1', text: 'No such user (seeded for e2e)', firstAt: now, lastAt: now, createdAt: now },
            update: {},
            include: INCLUDE,
          });
          return { entityId: seeded.id, before: null, after: auditView(seeded), result: seeded };
        },
      );
      res.status(201).json(suppressionJson(row));
    }),
  );

  // POST /api/admin/suppressions/dev-clear — e2e only (same gate): removes the listed addresses, so a
  // spec that sends to a real-world address it reuses (example.org publishes a null MX, which hard-
  // bounces with 5.1.10 and is suppressed as it should be) starts from a clean list. Audited.
  router.post(
    '/dev-clear',
    handle(async (req, res) => {
      if (deps.env['POSTROOM_E2E_SEED'] !== '1') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const raw = (req.body as { addresses?: unknown } | undefined)?.addresses;
      const parsed = Array.isArray(raw) && raw.length <= 50 ? raw.map((a) => SuppressionAddress.safeParse(a)) : null;
      if (parsed === null || parsed.some((p) => !p.success)) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      const addresses = parsed.map((p) => suppressionKey(p.data as string));
      const removed = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.dev.clear-suppression', entityType: 'suppressed_recipient', context: getAuditContext(req) },
        async (tx) => {
          const gone = await tx.suppressedRecipient.deleteMany({ where: { address: { in: addresses } } });
          return { entityId: null, before: { addresses }, after: { removed: gone.count }, result: gone.count };
        },
      );
      res.status(200).json({ removed });
    }),
  );

  router.get(
    '/',
    handle(async (req, res) => {
      const parsed = SuppressionListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const { q, limit } = parsed.data;
      const where: Prisma.SuppressedRecipientWhereInput = q === undefined ? {} : { address: { contains: q.toLowerCase() } };
      const [rows, total] = await Promise.all([
        db.suppressedRecipient.findMany({ where, include: INCLUDE, orderBy: [{ lastAt: 'desc' }, { address: 'asc' }], take: limit ?? DEFAULT_LIMIT }),
        db.suppressedRecipient.count({ where }),
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ suppressions: rows.map(suppressionJson), total });
    }),
  );

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const parsed = AddSuppressionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
        return;
      }
      const me = currentSession(req);
      const address = suppressionKey(parsed.data.address);
      const { reason } = parsed.data;
      try {
        const row = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.suppression.add', entityType: 'suppressed_recipient', context: getAuditContext(req) },
          async (tx) => {
            const existing = await tx.suppressedRecipient.findUnique({ where: { address }, select: { id: true } });
            if (existing !== null) throw new AlreadyListed();
            const now = rt.now();
            const created = await tx.suppressedRecipient.create({
              data: { address, reason: 'manual', note: reason, createdByAccountId: me.accountId, bounceCount: 0, firstAt: now, lastAt: now, createdAt: now },
              include: INCLUDE,
            });
            return { entityId: created.id, before: null, after: { ...auditView(created), reason: 'manual', note: reason }, result: created };
          },
        );
        res.status(201).json(suppressionJson(row));
      } catch (error) {
        // A concurrent add of the same address loses on the unique key, and reads the same as a listed one.
        if (error instanceof AlreadyListed || (error as { code?: string } | null)?.code === 'P2002') {
          res.status(409).json({ error: 'already_suppressed', message: `${address} is already on the suppression list` });
          return;
        }
        throw error;
      }
    }),
  );

  router.delete(
    '/:id',
    requireStepUp(deps),
    handle(async (req, res) => {
      const params = SuppressionParams.safeParse(req.params);
      const body = RemoveSuppressionBody.safeParse(req.body);
      if (!params.success || !body.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      try {
        await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.suppression.remove', entityType: 'suppressed_recipient', context: getAuditContext(req) },
          async (tx) => {
            const row = await tx.suppressedRecipient.findUnique({ where: { id: params.data.id } });
            if (row === null) throw new NotListed();
            await tx.suppressedRecipient.delete({ where: { id: row.id } });
            return { entityId: row.id, before: auditView(row), after: { address: row.address, removed: true, reason: body.data.reason }, result: null };
          },
        );
      } catch (error) {
        if (error instanceof NotListed) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        throw error;
      }
      res.status(204).end();
    }),
  );

  return router;
}
