// POST /api/admin/dev/seed — files synthetic messages into the caller's own mailboxes, for the
// browser suite only (PST-T-3.10). The e2e stack runs in docker compose with no port for SMTP and no
// Postgres published to the runner, so a test cannot deliver mail the real way; this is the least
// invasive door: OFF unless POSTROOM_E2E_SEED=1 (set only in docker-compose.e2e.yml), mounted only
// then (app.ts), admin-only, same-account only, audited, and it files exactly as the worker's
// file + notify stages do — uid = uidnext and modseq = highestModseq + 1 under the mailbox row lock,
// an encrypted blob, then pg_notify so /api/events sees it.
import { randomUUID } from 'node:crypto';
import { audited, getAuditContext } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import type { Prisma } from '@postroom/db';
import { Router } from 'express';
import { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { MAILBOX_CHANNEL } from '../mail/store.js';

export function adminDevEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['POSTROOM_E2E_SEED'] === '1';
}

const Header = z.string().max(998).regex(/^[^\r\n]*$/, 'no line breaks in a header');

const SeedMessage = z.object({
  mailbox: z.enum(['inbox', 'archive', 'trash', 'sent', 'drafts', 'junk']).default('inbox'),
  from: Header.default('Sender <sender@example.org>'),
  to: Header.optional(),
  cc: Header.optional(),
  replyTo: Header.optional(),
  subject: Header,
  text: z.string().max(100_000).nullable().default('Hello.'),
  html: z.string().max(100_000).optional(),
  attachment: z.object({ filename: z.string().min(1).max(200).regex(/^[^"\\\r\n]+$/), contentType: Header.default('application/octet-stream'), content: z.string().max(100_000) }).optional(),
  flags: z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered'])).default([]),
  date: z.iso.datetime().optional(),
  /** Stored verbatim as this message's message_verdict.auth (PST-T-6.5, PST-REQ-120): the same
   * spf/dkim/dmarc/arc shape smtp-in stores. Presence alone creates the MessageVerdict row (an
   * empty object `{}` is a "no verdict yet" fixture with an authenticated-looking absence of
   * signal); its absence leaves the message without one, as real Sent/Drafts copies have none. */
  authVerdicts: z.record(z.string(), z.unknown()).optional(),
});
const SeedBody = z.object({ messages: z.array(SeedMessage).min(1).max(50) });

type Seed = z.output<typeof SeedMessage>;

const crlf = (lines: string[]): string => lines.join('\r\n');
const b64 = (s: string): string => (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/** A small, valid RFC 5322 message. Bodies are base64 so any text survives the strict-CRLF rules. */
export function buildMessage(seed: Seed, to: string, messageId: string, date: Date): Buffer {
  const head = [`From: ${seed.from}`, `To: ${seed.to ?? to}`];
  if (seed.cc !== undefined) head.push(`Cc: ${seed.cc}`);
  if (seed.replyTo !== undefined) head.push(`Reply-To: ${seed.replyTo}`);
  head.push(`Subject: ${seed.subject}`, `Date: ${date.toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0');
  const text = seed.text === null ? null : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(seed.text)];
  const html = seed.html === undefined ? null : ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(seed.html)];
  let body: string[];
  if (text !== null && html !== null) body = ['Content-Type: multipart/alternative; boundary="alt-b"', '', '--alt-b', ...text, '--alt-b', ...html, '--alt-b--'];
  else body = text ?? html ?? ['Content-Type: text/plain; charset=utf-8', '', ''];
  if (seed.attachment !== undefined) {
    const a = seed.attachment;
    body = [
      'Content-Type: multipart/mixed; boundary="mix-b"',
      '',
      '--mix-b',
      ...body,
      '--mix-b',
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64(a.content),
      '--mix-b--',
    ];
  }
  return Buffer.from(`${crlf([...head, ...body])}\r\n`, 'utf8');
}

const bareAddress = (value: string): string => (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

export function adminDevRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  let blobs: BlobStore | null = null;

  router.post(
    '/seed',
    handle(async (req, res) => {
      if (!adminDevEnabled(deps.env)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (rt.kek === null) {
        res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
        return;
      }
      const parsed = SeedBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const root = deps.env['BLOB_ROOT']?.trim() ?? '';
      blobs ??= createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
      const store = blobs;
      const me = currentSession(req);
      const address = await db.address.findFirst({ where: { accountId: me.accountId }, include: { domain: true }, orderBy: { createdAt: 'asc' } });
      const to = address === null ? 'me@localhost' : `${address.localPart}@${address.domain.name}`;
      const mailboxes = await db.mailbox.findMany({ where: { accountId: me.accountId } });

      const filed: { id: string; mailboxId: string; uid: number; subject: string; messageIdHeader: string }[] = [];
      for (const seed of parsed.data.messages) {
        const mailbox = mailboxes.find((m) => m.specialUse === seed.mailbox) ?? (seed.mailbox === 'inbox' ? mailboxes.find((m) => m.name === 'INBOX') : undefined);
        if (mailbox === undefined) {
          res.status(409).json({ error: 'no_such_mailbox', message: `this account has no ${seed.mailbox} mailbox` });
          return;
        }
        const date = seed.date === undefined ? new Date() : new Date(seed.date);
        const messageIdHeader = `<${randomUUID()}@e2e.postroom.invalid>`;
        const raw = buildMessage(seed, to, messageIdHeader, date);
        const message = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'dev.seed.message', entityType: 'message', context: getAuditContext(req) },
          async (tx) => {
            const put = await store.put(raw, { tx });
            const rows = await tx.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`
              SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailbox.id}::uuid FOR UPDATE`;
            const mb = rows[0];
            if (mb === undefined) throw new Error('mailbox vanished');
            const modseq = mb.highest_modseq + 1n;
            const created = await tx.message.create({
              data: {
                mailboxId: mailbox.id,
                uid: mb.uidnext,
                modseq,
                blobSha256: put.sha256,
                size: put.size,
                internalDate: new Date(),
                flags: seed.flags,
                subject: seed.subject,
                fromAddress: bareAddress(seed.from),
                sentAt: date,
                messageIdHeader,
              },
            });
            await tx.mailbox.update({ where: { id: mailbox.id }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
            if (seed.authVerdicts !== undefined) {
              const auth = JSON.parse(JSON.stringify(seed.authVerdicts)) as Prisma.InputJsonValue;
              await tx.messageVerdict.create({ data: { messageId: created.id, auth, bucket: 'people', reasons: ['e2e seed'] } });
            }
            await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${mailbox.id})`;
            const after = { mailboxId: mailbox.id, uid: created.uid, subject: seed.subject };
            return { entityId: created.id, before: null, after, result: created };
          },
        );
        filed.push({ id: message.id, mailboxId: message.mailboxId, uid: message.uid, subject: seed.subject, messageIdHeader });
      }
      res.status(201).json({ messages: filed });
    }),
  );
  return router;
}
