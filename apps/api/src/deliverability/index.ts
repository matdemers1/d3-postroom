// /api/admin/deliverability — PST-T-7.1 / PST-REQ-122: DMARC aggregate and TLS-RPT reports,
// charted by day, by source and by reporting organization. Mounted by app.ts behind requireAdmin.
// Reads only; the rows are written by the worker's report sweep (apps/worker/src/reports), which
// reads every message filed to the report mailboxes (REPORTS_MAILBOX / TLSRPT_MAILBOX, default
// dmarc@ and tlsrpt@ the primary domain). Admin routes are not in openapi.json, by convention.
//
// POST /dev/seed exists only when POSTROOM_E2E_SEED=1 (the e2e stack; see admin-dev): it files a
// message carrying report attachments into the report mailbox — creating that service mailbox if
// the stack has none — so the browser suite exercises the real path: the worker's sweep reads it.
import { randomInt, randomUUID } from 'node:crypto';
import { audited, getAuditContext } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { AccountKind, AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db, type Prisma } from '@postroom/db';
import { buildMessage } from '@postroom/mime';
import { Router } from 'express';
import { z } from 'zod';
import { adminDevEnabled } from '../admin-dev/index.js';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { MAILBOX_CHANNEL } from '../mail/store.js';
import { aggregate, type Deliverability } from './aggregate.js';
import { reverseNames } from './rdns.js';

export type { Deliverability } from './aggregate.js';

const DAY_MS = 86_400_000;
const Query = z.object({ days: z.coerce.number().int().min(1).max(3660).default(30) });
const RDNS_SOURCES = 25;

const Header = z.string().min(1).max(998).regex(/^[^\r\n]*$/);
const SeedBody = z.object({
  messages: z
    .array(
      z.object({
        from: Header,
        subject: Header,
        attachments: z
          .array(z.object({ filename: z.string().min(1).max(200).regex(/^[^"\\\r\n]+$/), contentType: Header, contentBase64: z.string().max(700_000) }))
          .min(1)
          .max(4),
      }),
    )
    .min(1)
    .max(10),
});

/** The DMARC report address: the first of REPORTS_MAILBOX, else dmarc@<primary domain>. */
async function reportAddress(db: Db, env: NodeJS.ProcessEnv): Promise<string | null> {
  const configured = (env['REPORTS_MAILBOX'] ?? '').split(',').map((s) => s.trim().toLowerCase()).find((s) => s.includes('@'));
  if (configured !== undefined) return configured;
  const primary = await db.domain.findFirst({ where: { isPrimary: true }, select: { name: true } });
  return primary === null ? null : `dmarc@${primary.name}`;
}

export function deliverabilityRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  let blobs: BlobStore | null = null;

  router.get(
    '/',
    handle(async (req, res) => {
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const to = rt.now();
      const from = new Date(to.getTime() - parsed.data.days * DAY_MS);
      const body: Deliverability = { range: { from: from.toISOString(), to: to.toISOString(), days: parsed.data.days }, ...(await aggregate(db, from, to)) };
      if (deps.env['DELIVERABILITY_RDNS'] !== '0') {
        const busiest = body.dmarc.bySource.slice(0, RDNS_SOURCES);
        const names = await reverseNames(busiest.map((s) => s.sourceIp));
        for (const s of busiest) s.reverseDns = names.get(s.sourceIp) ?? null;
      }
      res.json({ ...body, mailboxes: { dmarc: await reportAddress(db, deps.env) } });
    }),
  );

  if (adminDevEnabled(deps.env)) {
    router.post(
      '/dev/seed',
      handle(async (req, res) => {
        if (rt.kek === null) {
          res.status(503).json({ error: 'blobstore_not_configured' });
          return;
        }
        const parsed = SeedBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_request' });
          return;
        }
        const address = await reportAddress(db, deps.env);
        if (address === null) {
          res.status(503).json({ error: 'domain_not_configured' });
          return;
        }
        const root = deps.env['BLOB_ROOT']?.trim() ?? '';
        blobs ??= createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
        const store = blobs;
        const me = currentSession(req);
        const at = address.lastIndexOf('@');
        const [localPart, domainName] = [address.slice(0, at), address.slice(at + 1)];

        const filed: { id: string; subject: string }[] = [];
        for (const m of parsed.data.messages) {
          const raw = buildMessage({
            headers: [
              ['From', `<${m.from}>`],
              ['To', `<${address}>`],
              ['Subject', m.subject],
              ['Date', new Date().toUTCString().replace('GMT', '+0000')],
              ['Message-ID', `<${randomUUID()}@e2e.postroom.invalid>`],
              ['MIME-Version', '1.0'],
            ],
            subtype: 'mixed',
            parts: [
              { contentType: 'text/plain', params: { charset: 'utf-8' }, body: 'This is an aggregate report.\r\n' },
              ...m.attachments.map((a) => ({ contentType: a.contentType, body: Buffer.from(a.contentBase64, 'base64'), filename: a.filename, disposition: 'attachment' as const, encoding: 'base64' as const })),
            ],
          });
          const message = await audited(
            db,
            { kind: 'account', accountId: me.accountId },
            { action: 'dev.seed.report', entityType: 'message', context: getAuditContext(req) },
            async (tx: Prisma.TransactionClient) => {
              const domain = await tx.domain.findUnique({ where: { name: domainName } });
              if (domain === null) throw new Error(`no domain ${domainName}`);
              let owner = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId: domain.id } }, select: { accountId: true } });
              if (owner?.accountId === null || owner === null) {
                const account = await tx.account.create({ data: { displayName: 'DMARC reports', kind: AccountKind.service } });
                await tx.address.create({ data: { localPart, domainId: domain.id, kind: AddressKind.service, accountId: account.id } });
                for (const mb of DEFAULT_MAILBOXES) {
                  await tx.mailbox.create({ data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) } });
                }
                owner = { accountId: account.id };
              }
              const inbox = await tx.mailbox.findFirstOrThrow({ where: { accountId: owner.accountId ?? '', name: 'INBOX' } });
              const put = await store.put(raw, { tx });
              const rows = await tx.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`
                SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${inbox.id}::uuid FOR UPDATE`;
              const mb = rows[0];
              if (mb === undefined) throw new Error('mailbox vanished');
              const modseq = mb.highest_modseq + 1n;
              const created = await tx.message.create({
                data: { mailboxId: inbox.id, uid: mb.uidnext, modseq, blobSha256: put.sha256, size: put.size, internalDate: new Date(), subject: m.subject, fromAddress: m.from.toLowerCase(), sentAt: new Date() },
              });
              await tx.mailbox.update({ where: { id: inbox.id }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
              await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${inbox.id})`;
              return { entityId: created.id, before: null, after: { mailboxId: inbox.id, uid: created.uid, subject: m.subject, to: address }, result: created };
            },
          );
          filed.push({ id: message.id, subject: m.subject });
        }
        res.status(201).json({ address, messages: filed });
      }),
    );
  }

  return router;
}
