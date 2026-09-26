// /api/admin/service-accounts — PST-T-1.12 / PST-REQ-046: service mailboxes (alerts@, shipyard@)
// that ecosystem apps authenticate to over submission with their own app passwords and caps.
//
// This route creates only the mailbox: Account(kind 'service', no password) + Address(kind
// 'service') at the primary domain + the default mailboxes (the same set a person gets — reusing
// DEFAULT_MAILBOXES keeps IMAP, Sent-copy filing and Rejects working identically for a service
// account). It returns no secret. The app password itself is minted afterwards through the
// existing `POST /api/app-passwords?accountId=<id>` (app-passwords/index.ts's `targetOf` already
// restricts that query param to an admin acting on a *service* account) — so there is exactly one
// route in the whole API that ever answers with a plaintext credential.
//
// Mounted by app.ts behind requireAdmin; creating a new mail-sending identity is destructive
// enough to also require the same five-minute step-up every other admin-mutation route does.
import { randomInt } from 'node:crypto';
import { audited, getAuditContext } from '@postroom/audit';
import { AccountKind, AddressKind, DEFAULT_MAILBOXES, normalizeLocalPart, randomUidValidity, type Prisma } from '@postroom/db';
import { Router } from 'express';
import { z } from 'zod';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 200;

const CreateBody = z.object({
  localPart: z.string().trim().min(1).max(MAX_LOCAL_PART_LENGTH),
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  dailyRecipientCap: z.number().int().positive().max(1_000_000).nullable().optional(),
});

/** Thrown inside the creating transaction when the address is already taken; rolls the audit back too. */
class LocalPartTaken extends Error {}

/** Thrown when there is no primary domain yet (setup has not run). */
class NoPrimaryDomain extends Error {}

export function serviceAccountRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      let localPart: string;
      try {
        localPart = normalizeLocalPart(parsed.data.localPart);
      } catch {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const { displayName, dailyRecipientCap } = parsed.data;
      const me = currentSession(req);
      try {
        const created = await audited<{ accountId: string; address: string }>(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.service_account.create', entityType: 'account', context: getAuditContext(req) },
          async (tx: Prisma.TransactionClient) => {
            const domain = await tx.domain.findFirst({ where: { isPrimary: true } });
            if (domain === null) throw new NoPrimaryDomain();
            const taken = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId: domain.id } } });
            if (taken !== null) throw new LocalPartTaken();

            const account = await tx.account.create({ data: { displayName, isAdmin: false, kind: AccountKind.service } });
            await tx.address.create({
              data: { localPart, domainId: domain.id, kind: AddressKind.service, accountId: account.id },
            });
            for (const mb of DEFAULT_MAILBOXES) {
              await tx.mailbox.create({
                data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) },
              });
            }
            const address = `${localPart}@${domain.name}`;
            return {
              entityId: account.id,
              before: null,
              after: { address, displayName, kind: 'service' },
              result: { accountId: account.id, address },
            };
          },
        );
        res.status(201).json({
          accountId: created.accountId,
          address: created.address,
          displayName,
          dailyRecipientCap: dailyRecipientCap ?? null,
        });
      } catch (error) {
        if (error instanceof LocalPartTaken) {
          res.status(409).json({ error: 'local_part_taken' });
          return;
        }
        if (error instanceof NoPrimaryDomain) {
          res.status(503).json({ error: 'domain_not_configured' });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
