// The composer's API (PST-T-3.11, PST-REQ-079): send, and drafts. Mounted by app.ts at
// /api/compose behind a session, the CSRF guard and the audit guard, like the mail routes.
//
// Sending goes through the SAME submission path as SMTP on 587/465 — @postroom/submission's
// acceptSubmission: the From-ownership check, DKIM signing (refused, never sent unsigned, while the
// domain has no keys), the authoritative recipient cap inside the accepting transaction, the
// encrypted spool, the outbound queue rows and jobs, and the `submission.accept` audit row. The
// webmail adds one thing inside that same transaction: the Sent copy, filed from the very blob that
// was queued (one more reference, not a second copy). After the commit the Sent copy is threaded, so
// a reply appears in its conversation.
//
// Drafts are real messages in the account's Drafts mailbox (\Draft \Seen), so IMAP clients see them
// too. Saving again REPLACES the draft: a new message is filed and the old one expunged in the same
// transaction (a message's bytes are immutable; that is how IMAP clients do it as well).
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { audited, getAuditContext, recordAudit } from '@postroom/audit';
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { envInt, envString } from '@postroom/daemon';
import { collectMessage, decodeEncodedWords, parseMailboxes, parseMessageIdList, type Mailbox } from '@postroom/mime';
import { acceptSubmission, sendableAddresses, type AcceptOutcome, type SubmissionStorage } from '@postroom/submission';
import { createWebmailCapsEnforcer } from '@postroom/submission/caps';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { bracketMsgId, buildOutgoingStream, buildTextMessage, parseRecipients, type OutgoingMessage } from './message.js';
import { DraftParams, DraftQuery, DraftRequest, SendRequest, type DraftJson, type DraftSavedJson, type SendResponseJson } from './schemas.js';
import { DRAFT_FLAGS, fileCopy, findOwnDraft, removeMessage, SENT_FLAGS, threadSentCopy, type Denorm } from './store.js';

const X_MODE = 'X-Postroom-Draft-Mode';
const X_SOURCE = 'X-Postroom-Draft-Source';
const X_FORWARD = 'X-Postroom-Forward-Of';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** How a refusal from the submission path reads over HTTP. */
export function refusalStatus(outcome: Exclude<AcceptOutcome, { ok: true }>): { status: number; error: string } {
  switch (outcome.reason) {
    case 'from-missing':
    case 'from-not-owned':
      return { status: 403, error: 'from_not_owned' };
    case 'header-too-large':
      return { status: 413, error: 'header_too_large' };
    case 'dkim-unconfigured':
      return { status: 503, error: 'dkim_unconfigured' };
    case 'cap-exceeded':
      return { status: 429, error: 'recipient_cap' };
  }
}

/** A mailbox as the composer's input field shows it: `Name <a@b>`, the name quoted only when it must be. */
function displayMailbox(m: Mailbox): string {
  if (m.name === '') return m.address;
  const name = /[",<>@;:()[\]\\]/.test(m.name) ? `"${m.name.replace(/(["\\])/g, '\\$1')}"` : m.name;
  return `${name} <${m.address}>`;
}

export function composeRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ daemon: 'api', component: 'compose', event, ...fields })}\n`);
  };
  const capsOptions = {
    db,
    hourlyDefault: envInt(deps.env, 'SUBMISSION_CAP_HOURLY', 100),
    dailyDefault: envInt(deps.env, 'SUBMISSION_CAP_DAILY', 500),
    sendAlert: createAlertSender(
      { url: envString(deps.env, 'MAIL_RELAY_URL', ''), token: envString(deps.env, 'MAIL_RELAY_TOKEN', ''), to: envString(deps.env, 'ALERT_TO', '') },
      { log },
    ),
    log,
  };
  const webmailCaps = createWebmailCapsEnforcer(capsOptions);
  const maxRecipients = envInt(deps.env, 'SUBMISSION_MAX_RECIPIENTS', 100);

  let storage: SubmissionStorage | null = null;
  const storageFor = (res: Response): SubmissionStorage | null => {
    if (storage !== null) return storage;
    if (rt.kek === null) {
      res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
      return null;
    }
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    const blobs: BlobStore = createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
    storage = { blobs, kek: rt.kek };
    return storage;
  };

  const reap = async (blobs: BlobStore, shas: readonly (string | null)[]): Promise<void> => {
    for (const sha of shas) if (sha !== null) await blobs.reap(sha).catch(() => undefined);
  };

  /** The sender as a header mailbox: the account's display name and one of its own addresses. */
  const senderFor = async (accountId: string, requested: string | undefined): Promise<{ from: Mailbox; addresses: Set<string> }> => {
    const addresses = await sendableAddresses(db, accountId);
    const wanted = (requested ?? addresses[0] ?? '').trim().toLowerCase();
    if (wanted === '' || !addresses.includes(wanted)) throw new HttpRefusal(403, 'from_not_owned', 'From must be one of your own addresses');
    const account = await db.account.findUnique({ where: { id: accountId }, select: { displayName: true } });
    return { from: { name: account?.displayName ?? '', address: wanted }, addresses: new Set(addresses) };
  };

  const recipientsOf = (field: string, entries: readonly string[]): Mailbox[] => {
    const parsed = parseRecipients(entries);
    if (!parsed.ok) throw new HttpRefusal(400, 'invalid_recipient', `${field}: "${parsed.entry.slice(0, 200)}" is not an address Postroom can send to`);
    return parsed.mailboxes;
  };

  const threading = (inReplyTo: string | null | undefined, references: readonly string[]): { inReplyTo: string | null; references: string[] } => {
    const irt = inReplyTo === null || inReplyTo === undefined ? null : bracketMsgId(inReplyTo);
    const refs = [...new Set(references.map(bracketMsgId).filter((r): r is string => r !== null))];
    // The References chain always ends with what this answers (RFC 5322 §3.6.4).
    if (irt !== null && !refs.includes(irt)) refs.push(irt);
    return { inReplyTo: irt, references: refs };
  };

  const answer = (res: Response, error: unknown): boolean => {
    if (error instanceof HttpRefusal) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return true;
    }
    return false;
  };

  // --- Send ------------------------------------------------------------------------------------

  router.post(
    '/send',
    handle(async (req, res) => {
      const body = parse(SendRequest, req.body, res);
      if (body === null) return;
      const store = storageFor(res);
      if (store === null) return;
      const me = currentSession(req);
      const ctx = getAuditContext(req);
      try {
        const { from, addresses } = await senderFor(me.accountId, body.from);
        const to = recipientsOf('to', body.to);
        const cc = recipientsOf('cc', body.cc);
        const bcc = recipientsOf('bcc', body.bcc);
        const envelope = [...new Set([...to, ...cc, ...bcc].map((m) => m.address))];
        if (envelope.length === 0) throw new HttpRefusal(400, 'no_recipients', 'Add at least one recipient');
        if (envelope.length > maxRecipients) throw new HttpRefusal(400, 'too_many_recipients', `At most ${String(maxRecipients)} recipients per message`);

        let original: Readable | null = null;
        if (body.forwardOf !== null && body.forwardOf !== undefined) {
          const source = await db.message.findFirst({ where: { id: body.forwardOf, mailbox: { accountId: me.accountId } }, select: { blobSha256: true } });
          if (source === null) throw new HttpRefusal(404, 'not_found', 'forwardOf is not one of your messages');
          original = await store.blobs.get(source.blobSha256);
        }

        const date = rt.now();
        const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
        const { inReplyTo, references } = threading(body.inReplyTo, body.references);
        const message: OutgoingMessage = {
          from,
          to,
          cc,
          bcc,
          subject: body.subject,
          text: body.text,
          messageId: `<${randomUUID()}@${domain}>`,
          inReplyTo,
          references,
          date,
        };
        const denorm: Denorm = {
          messageIdHeader: message.messageId,
          subject: body.subject,
          fromAddress: from.address,
          to: [...to, ...cc].map((m) => m.address).join(' '),
          sentAt: date,
          inReplyTo,
          references,
          bodyText: body.text,
        };

        let sent: { id: string; mailboxId: string } | null = null;
        let reaped: string | null = null;
        const outcome = await acceptSubmission(
          buildOutgoingStream(message, original),
          {
            submitter: { accountId: me.accountId, addresses },
            envelopeFrom: from.address,
            recipients: envelope.map((address) => ({ address })),
            sessionId: ctx.requestId,
            submittedVia: 'webmail',
            enforceCaps: (tx, recipients, at) => webmailCaps(tx, me.accountId, recipients, at),
            auditContext: ctx,
            withinTransaction: async (tx, accepted) => {
              const copy = await fileCopy(tx, {
                accountId: me.accountId,
                use: 'sent',
                blobSha256: accepted.blobSha256,
                size: accepted.size,
                flags: SENT_FLAGS,
                denorm,
                now: date,
                takeReference: true,
              });
              sent = copy;
              let draftRemoved: string | null = null;
              if (body.draftId !== null && body.draftId !== undefined) {
                const draft = await findOwnDraft(tx, me.accountId, body.draftId);
                if (draft !== null) {
                  reaped = await removeMessage(tx, store.blobs, draft);
                  draftRemoved = draft.id;
                }
              }
              await recordAudit(tx, {
                actor: { kind: 'account', accountId: me.accountId },
                action: 'compose.send',
                entityType: 'message',
                entityId: copy.id,
                before: draftRemoved === null ? null : { draftId: draftRemoved },
                after: { outboundId: accepted.outboundId, messageId: accepted.messageId, sentMailboxId: copy.mailboxId, uid: copy.uid, forwardOf: body.forwardOf ?? null },
                context: ctx,
              });
            },
          },
          { db, storage: () => store, now: rt.now, log },
        ).finally(() => {
          // A refusal stops reading part-way: let go of the original's blob stream too.
          original?.destroy();
        });
        if (!outcome.ok) {
          const { status, error } = refusalStatus(outcome);
          res.status(status).json({ error, message: outcome.reply.lines.join(' ') });
          return;
        }
        await reap(store.blobs, [reaped]);
        const filed = sent as { id: string; mailboxId: string } | null;
        if (filed === null) throw new Error('the Sent copy was not filed');

        let threadId: string | null = null;
        try {
          threadId = await threadSentCopy(db, {
            accountId: me.accountId,
            messageId: filed.id,
            messageIdHeader: outcome.messageId,
            inReplyTo,
            references,
            subject: body.subject,
            from: from.address,
            to: denorm.to,
            date,
          });
        } catch (error) {
          // The message is queued and in Sent; the thread sweep threads what this could not.
          log('thread-failed', { messageId: filed.id, error: error instanceof Error ? error.message : String(error) });
        }
        const json: SendResponseJson = { messageId: outcome.messageId, outboundId: outcome.outboundId, sentMessageId: filed.id, sentMailboxId: filed.mailboxId, threadId };
        res.status(201).json(json);
      } catch (error) {
        if (!answer(res, error)) throw error;
      }
    }),
  );

  // --- Drafts ----------------------------------------------------------------------------------

  const saveDraft = async (req: Request, res: Response, replaces: string | null): Promise<void> => {
    const body = parse(DraftRequest, req.body, res);
    if (body === null) return;
    const store = storageFor(res);
    if (store === null) return;
    const me = currentSession(req);
    try {
      const { from } = await senderFor(me.accountId, body.from);
      // A draft may be half-typed: keep what parses, and never refuse a save over an address.
      const lenient = (entries: readonly string[]): Mailbox[] => entries.flatMap((e) => parseMailboxes(e)).filter((m) => m.address.includes('@'));
      const to = lenient(body.to);
      const cc = lenient(body.cc);
      const bcc = lenient(body.bcc);
      const date = rt.now();
      const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
      const { inReplyTo, references } = threading(body.inReplyTo, body.references);
      const extra: [string, string][] = [];
      if (body.mode !== null && body.mode !== undefined) extra.push([X_MODE, body.mode]);
      if (body.sourceId !== null && body.sourceId !== undefined) extra.push([X_SOURCE, body.sourceId]);
      if (body.forwardOf !== null && body.forwardOf !== undefined) extra.push([X_FORWARD, body.forwardOf]);
      const message: OutgoingMessage = {
        from,
        to,
        cc,
        bcc,
        includeBcc: true,
        subject: body.subject,
        text: body.text,
        messageId: `<${randomUUID()}@${domain}>`,
        inReplyTo,
        references,
        date,
        extraHeaders: extra,
      };
      const raw = buildTextMessage(message);
      let reaped: string | null = null;
      const saved = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: replaces === null ? 'draft.save' : 'draft.replace', entityType: 'message', context: getAuditContext(req) },
        async (tx) => {
          let old = null;
          if (replaces !== null) {
            old = await findOwnDraft(tx, me.accountId, replaces);
            if (old === null) throw new HttpRefusal(404, 'not_found', 'no such draft');
          }
          const put = await store.blobs.put(raw, { tx });
          const copy = await fileCopy(tx, {
            accountId: me.accountId,
            use: 'drafts',
            blobSha256: put.sha256,
            size: put.size,
            flags: DRAFT_FLAGS,
            denorm: {
              messageIdHeader: message.messageId,
              subject: body.subject,
              fromAddress: from.address,
              to: [...to, ...cc].map((m) => m.address).join(' '),
              sentAt: date,
              inReplyTo,
              references,
              bodyText: body.text,
            },
            now: date,
            takeReference: false,
          });
          if (old !== null) reaped = await removeMessage(tx, store.blobs, old);
          return {
            entityId: copy.id,
            before: old === null ? null : { id: old.id, uid: old.uid },
            after: { id: copy.id, mailboxId: copy.mailboxId, uid: copy.uid, subject: body.subject },
            result: copy,
          };
        },
      );
      await reap(store.blobs, [reaped]);
      const json: DraftSavedJson = { id: saved.id, mailboxId: saved.mailboxId, uid: saved.uid, savedAt: date.toISOString() };
      res.status(replaces === null ? 201 : 200).json(json);
    } catch (error) {
      if (!answer(res, error)) throw error;
    }
  };

  router.post(
    '/drafts',
    handle(async (req, res) => {
      await saveDraft(req, res, null);
    }),
  );

  router.put(
    '/drafts/:id',
    handle(async (req, res) => {
      const params = parse(DraftParams, req.params, res);
      if (params === null) return;
      await saveDraft(req, res, params.id);
    }),
  );

  const draftJson = async (store: SubmissionStorage, m: { id: string; mailboxId: string; blobSha256: string; internalDate: Date }): Promise<DraftJson> => {
    const summary = await collectMessage(await store.blobs.get(m.blobSha256));
    const h = summary.headers;
    const list = (name: string): string[] => h.getAll(name).flatMap((v) => parseMailboxes(v)).map(displayMailbox);
    const uuidOr = (v: string | null): string | null => (v !== null && UUID.test(v.trim()) ? v.trim().toLowerCase() : null);
    const mode = h.get(X_MODE)?.trim() ?? null;
    const irt = h.get('In-Reply-To');
    const text = (summary.text?.text ?? '').replace(/\r\n/g, '\n');
    return {
      id: m.id,
      mailboxId: m.mailboxId,
      from: parseMailboxes(h.get('From') ?? '')[0]?.address ?? '',
      to: list('To'),
      cc: list('Cc'),
      bcc: list('Bcc'),
      subject: decodeEncodedWords(h.get('Subject') ?? '').trim(),
      // The builder always ends the text with one line break the user did not type.
      text: text.endsWith('\n') ? text.slice(0, -1) : text,
      inReplyTo: irt === null ? null : (parseMessageIdList(irt).map((id) => `<${id}>`)[0] ?? null),
      references: parseMessageIdList(h.get('References') ?? '').map((id) => `<${id}>`),
      forwardOf: uuidOr(h.get(X_FORWARD)),
      mode: mode === 'new' || mode === 'reply' || mode === 'replyall' || mode === 'forward' ? mode : null,
      sourceId: uuidOr(h.get(X_SOURCE)),
      savedAt: m.internalDate.toISOString(),
    };
  };

  router.get(
    '/drafts',
    handle(async (req, res) => {
      const query = parse(DraftQuery, req.query, res);
      if (query === null) return;
      const store = storageFor(res);
      if (store === null) return;
      const me = currentSession(req);
      const irt = query.inReplyTo === undefined ? null : bracketMsgId(query.inReplyTo);
      const key = irt === null ? null : irt.slice(1, -1);
      const rows = await db.message.findMany({
        where: {
          flags: { has: '\\Draft' },
          mailbox: { accountId: me.accountId, specialUse: 'drafts' },
          ...(key === null ? {} : { inReplyTo: { in: [key, `<${key}>`] } }),
        },
        orderBy: { internalDate: 'desc' },
        take: 50,
        select: { id: true, mailboxId: true, blobSha256: true, internalDate: true },
      });
      const drafts: DraftJson[] = [];
      for (const r of rows) drafts.push(await draftJson(store, r));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ drafts });
    }),
  );

  router.get(
    '/drafts/:id',
    handle(async (req, res) => {
      const params = parse(DraftParams, req.params, res);
      if (params === null) return;
      const store = storageFor(res);
      if (store === null) return;
      const draft = await findOwnDraft(db, currentSession(req).accountId, params.id);
      if (draft === null) {
        notFound(res);
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await draftJson(store, draft));
    }),
  );

  router.delete(
    '/drafts/:id',
    handle(async (req, res) => {
      const params = parse(DraftParams, req.params, res);
      if (params === null) return;
      const store = storageFor(res);
      if (store === null) return;
      const me = currentSession(req);
      let reaped: string | null = null;
      try {
        await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'draft.delete', entityType: 'message', context: getAuditContext(req) }, async (tx) => {
          const draft = await findOwnDraft(tx, me.accountId, params.id);
          if (draft === null) throw new HttpRefusal(404, 'not_found', 'no such draft');
          reaped = await removeMessage(tx, store.blobs, draft);
          return { entityId: draft.id, before: { id: draft.id, mailboxId: draft.mailboxId, uid: draft.uid }, after: null, result: null };
        });
      } catch (error) {
        if (!answer(res, error)) throw error;
        return;
      }
      await reap(store.blobs, [reaped]);
      res.status(204).end();
    }),
  );

  // --- e2e only ----------------------------------------------------------------------------------

  // The browser suite's stack has no operator step that creates DKIM keys, and submission refuses to
  // send unsigned — so, exactly like POST /api/admin/dev/seed, an admin-only, audited door that exists
  // only with POSTROOM_E2E_SEED=1 (never set outside docker-compose.e2e.yml).
  if (deps.env['POSTROOM_E2E_SEED'] === '1') {
    router.post(
      '/dev/dkim-keys',
      handle(async (req, res) => {
        const me = currentSession(req);
        if (!me.isAdmin) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        if (rt.kek === null) {
          res.status(503).json({ error: 'blobstore_not_configured' });
          return;
        }
        const addresses = await sendableAddresses(db, me.accountId);
        const domain = (addresses[0] ?? '').split('@')[1];
        if (domain === undefined) {
          res.status(409).json({ error: 'no_address' });
          return;
        }
        const keys = await ensureDkimKeys(db, rt.kek, domain);
        await recordAudit(db, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'dev.dkim.ensure',
          entityType: 'domain',
          entityId: null,
          after: { domain, selectors: keys.map((k) => k.selector) },
          context: getAuditContext(req),
        });
        res.status(201).json({ domain, keys: keys.map((k) => ({ selector: k.selector, algorithm: k.algorithm, created: k.created })) });
      }),
    );
  }

  return router;
}
