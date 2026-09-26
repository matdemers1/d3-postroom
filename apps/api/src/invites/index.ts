// iMIP invitations in the webmail (PST-T-8.4, PST-REQ-134): the reading pane's invite card, and
// Accept/Maybe/Decline. Mounted by app.ts at /api/messages behind a session, the CSRF guard and the
// audit guard, like delivery and unsubscribe.
//
// Responding does two things, in order, so a network failure never leaves them disagreeing:
//   1. builds the RFC 5546 REPLY and sends it through the SAME submission path the composer uses
//      (@postroom/submission's acceptSubmission) — DKIM-signed, queued, audited (submission.accept);
//   2. writes the event into the caller's default calendar through the SAME DavStore the DAV daemon
//      and the webmail's own calendar API write through — encrypted, etagged, sync-token bumped,
//      and audited (dav.resource.create/update) inside that write's own transaction.
// A CANCEL offers "Remove from calendar" instead: RFC 5546 has no reply for a cancellation, so only
// the stored event (when there is one) is marked STATUS:CANCELLED — and only when the CANCEL comes,
// authenticated, from the organizer of record with a SEQUENCE not older than the stored one
// (./cancel.ts).
//
// The reply's only recipient is the ORGANIZER, which @postroom/ical has already validated as exactly
// one RFC 5321 mailbox (no CR/LF, list, or brackets); an invite whose ORGANIZER fails is refused
// before anything is built. The recipient cap is the composer's own (PST-REQ-043): the same
// createWebmailCapsEnforcer, with the same env, inside the accepting transaction.
//
// Isolation: a message that is not the caller's own answers 404 — the same rule as every other mail
// route (apps/api/src/mail/index.ts).
import { getAuditContext } from '@postroom/audit';
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { envInt, envString } from '@postroom/daemon';
import { buildReply, matchAttendee, parseInvite, replyBlockReason, serializeReply, type ParsedInvite, type Partstat } from '@postroom/imip';
import { parseICalendar, serializeICalendar, type Component } from '@postroom/ical';
import { acceptSubmission, sendableAddresses, type AcceptOutcome, type SubmissionStorage } from '@postroom/submission';
import { createWebmailCapsEnforcer } from '@postroom/submission/caps';
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import { davFor } from '../contacts/dav.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { findOwnMessage } from '../mail/store.js';
import { cancelEligibility } from './cancel.js';
import { attendeePartstat, isCancelled, storedOrganizer, storedSequence, withAttendeePartstat, withCancelled } from './event.js';
import { buildReplyStream } from './message.js';
import { findCalendarPart } from './store.js';
import { IdParams, InviteView, RespondBody, type InviteViewJson } from './schemas.js';

const CALENDAR_SLUG = 'calendar';

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

function tryParse(data: Buffer): Component | null {
  try {
    return parseICalendar(data);
  } catch {
    return null;
  }
}

/** A display name safe for a header: control characters (RFC 6868 `^n` decodes to LF) become spaces. */
function displayName(cn: string | null): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return (cn ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim();
}

const REPLY_LABEL: Record<Partstat, string> = { ACCEPTED: 'Accepted', DECLINED: 'Declined', TENTATIVE: 'Tentative' };

/** How a submission refusal reads over HTTP (mirrors compose/index.ts's refusalStatus). */
function refusalStatus(outcome: Exclude<AcceptOutcome, { ok: true }>): { status: number; error: string } {
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

export function invitesRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ daemon: 'api', component: 'invites', event, ...fields })}\n`);
  };

  // The composer's cap enforcer (compose/index.ts), built from the same factory and the same env.
  const webmailCaps = createWebmailCapsEnforcer({
    db,
    hourlyDefault: envInt(deps.env, 'SUBMISSION_CAP_HOURLY', 100),
    dailyDefault: envInt(deps.env, 'SUBMISSION_CAP_DAILY', 500),
    sendAlert: createAlertSender(
      { url: envString(deps.env, 'MAIL_RELAY_URL', ''), token: envString(deps.env, 'MAIL_RELAY_TOKEN', ''), to: envString(deps.env, 'ALERT_TO', '') },
      { log },
    ),
    log,
  });

  let storage: SubmissionStorage | null = null;
  const storageFor = (res: Response): SubmissionStorage | null => {
    if (storage !== null) return storage;
    if (rt.kek === null) {
      res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
      return null;
    }
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    storage = { blobs: createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek }), kek: rt.kek };
    return storage;
  };
  const blobStore = (res: Response): BlobStore | null => storageFor(res)?.blobs ?? null;

  /** The caller's own message's invite, and the addresses it may reply/organize as; answers 404/409/503 on failure. */
  const loadInvite = async (
    req: Request,
    res: Response,
  ): Promise<{ accountId: string; addresses: string[]; invite: ParsedInvite; message: NonNullable<Awaited<ReturnType<typeof findOwnMessage>>> } | null> => {
    const params = parse(IdParams, req.params, res);
    if (params === null) return null;
    const accountId = currentSession(req).accountId;
    const message = await findOwnMessage(db, accountId, params.id);
    if (message === null) {
      notFound(res);
      return null;
    }
    const store = blobStore(res);
    if (store === null) return null;
    const raw = await findCalendarPart(await store.get(message.blobSha256));
    if (raw === null) {
      notFound(res);
      return null;
    }
    const addresses = await sendableAddresses(db, accountId);
    const invite = tryParseInvite(raw);
    if (invite === null) {
      res.status(409).json({ error: 'unreadable_invite', message: 'This message’s calendar part cannot be parsed.' });
      return null;
    }
    return { accountId, addresses, invite, message };
  };

  function tryParseInvite(raw: Buffer): ParsedInvite | null {
    try {
      return parseInvite(raw);
    } catch {
      return null;
    }
  }

  /** The stored calendar object for this UID in the caller's default calendar, if any. */
  const storedEvent = async (
    dav: NonNullable<ReturnType<typeof davFor>>,
    accountId: string,
    uid: string,
  ): Promise<{ calendar: Component; etag: string; name: string } | null> => {
    const calendar = await dav.store.getCollection(accountId, 'calendar', CALENDAR_SLUG);
    if (calendar === null) return null;
    const name = `${uid}.ics`;
    const meta = await dav.store.getMeta(calendar.id, name);
    if (meta === null) return null;
    const [resource] = await dav.store.getResources(calendar.id, [name]);
    if (resource === undefined) return null;
    const parsed = tryParse(resource.data);
    if (parsed === null) return null;
    return { calendar: parsed, etag: resource.etag, name };
  };

  router.get(
    '/:id/invite',
    handle(async (req, res) => {
      const found = await loadInvite(req, res);
      if (found === null) return;
      const { accountId, addresses, invite } = found;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const stored = await storedEvent(dav, accountId, invite.uid);
      const mine = matchAttendee(invite, addresses);
      const you =
        mine === null ? null : { email: mine.email, partstat: (stored === null ? null : attendeePartstat(stored.calendar, mine.email)) ?? mine.partstat };
      const cancelled = invite.method === 'CANCEL' || (stored !== null && isCancelled(stored.calendar));
      const json: InviteViewJson = {
        method: invite.method,
        uid: invite.uid,
        sequence: invite.sequence,
        summary: invite.summary,
        location: invite.location,
        allDay: invite.allDay,
        start: invite.start,
        end: invite.end,
        organizer: invite.organizer,
        attendees: [...invite.attendees],
        recurrenceId: invite.recurrenceId,
        you,
        cancelled,
        inCalendar: stored !== null,
      };
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(InviteView.parse(json));
    }),
  );

  router.post(
    '/:id/invite/respond',
    handle(async (req, res) => {
      const body = parse(RespondBody, req.body, res);
      if (body === null) return;
      const found = await loadInvite(req, res);
      if (found === null) return;
      const { accountId, addresses, invite } = found;
      if (invite.method !== 'REQUEST') {
        res.status(409).json({ error: 'not_a_request', message: 'Only a REQUEST can be answered with Accept/Maybe/Decline.' });
        return;
      }
      const mine = matchAttendee(invite, addresses);
      if (mine === null) {
        res.status(403).json({ error: 'not_invited', message: 'None of your addresses is invited to this event.' });
        return;
      }
      const blocked = replyBlockReason(invite);
      if (blocked !== null || invite.organizer.email === null) {
        res.status(409).json({ error: invite.organizerStatus === 'invalid' ? 'invalid_organizer' : 'no_organizer', message: blocked ?? 'This invitation has no ORGANIZER to reply to.' });
        return;
      }
      const organizerEmail = invite.organizer.email;
      const store = storageFor(res);
      if (store === null) return;
      const dav = davFor(deps, res);
      if (dav === null) return;
      const calendar = await dav.store.getCollection(accountId, 'calendar', CALENDAR_SLUG);
      if (calendar === null) {
        res.status(503).json({ error: 'no_default_calendar', message: 'No default calendar for this account.' });
        return;
      }

      const partstat: Partstat = body.partstat;
      const now = rt.now();
      const ctx = getAuditContext(req);
      const me = currentSession(req);

      // 1. The RFC 5546 REPLY, through the same submission path the composer uses.
      const reply = buildReply(invite, addresses, partstat, now);
      const domain = mine.email.slice(mine.email.lastIndexOf('@') + 1);
      const outboundStream = buildReplyStream({
        from: { name: '', address: mine.email },
        to: { name: displayName(invite.organizer.cn), address: organizerEmail },
        subject: `${REPLY_LABEL[partstat]}: ${invite.summary}`,
        text: `${REPLY_LABEL[partstat]}.`,
        ics: serializeReply(reply),
        messageId: `<${randomUUID()}@${domain}>`,
        date: now,
      });
      const outcome = await acceptSubmission(
        outboundStream,
        {
          submitter: { accountId: me.accountId, addresses: new Set(addresses) },
          envelopeFrom: mine.email,
          recipients: [{ address: organizerEmail }],
          sessionId: ctx.requestId,
          submittedVia: 'webmail',
          enforceCaps: (tx, recipients, at) => webmailCaps(tx, me.accountId, recipients, at),
          auditContext: ctx,
        },
        { db, storage: () => store, now: rt.now, log },
      );
      if (!outcome.ok) {
        const { status, error } = refusalStatus(outcome);
        res.status(status).json({ error, message: outcome.reply.lines.join(' ') });
        return;
      }

      // 2. The default calendar: create or update the event with this attendee's new PARTSTAT.
      const name = `${invite.uid}.ics`;
      const existing = await dav.store.getMeta(calendar.id, name);
      let base = invite.calendar;
      if (existing !== null) {
        const [resource] = await dav.store.getResources(calendar.id, [name]);
        const parsed = resource === undefined ? null : tryParse(resource.data);
        if (parsed !== null) base = parsed;
      }
      const data = Buffer.from(serializeICalendar(withAttendeePartstat(base, mine.email, partstat)), 'utf8');
      const putOutcome = await dav.store.putResource(
        { accountId, context: ctx },
        calendar,
        { name, uid: invite.uid, componentType: 'VEVENT', data, preconditions: existing === null ? { ifNoneMatch: '*' } : { ifMatch: `"${existing.etag}"` } },
      );
      if (putOutcome.status !== 'created' && putOutcome.status !== 'updated') {
        res.status(409).json({ error: 'calendar_write_failed', message: 'The calendar event changed at the same time; try again.' });
        return;
      }

      res.status(200).json({ ok: true, partstat, calendarName: name });
    }),
  );

  router.post(
    '/:id/invite/remove',
    handle(async (req, res) => {
      const found = await loadInvite(req, res);
      if (found === null) return;
      const { accountId, invite, message } = found;
      if (invite.method !== 'CANCEL') {
        res.status(409).json({ error: 'not_a_cancel', message: 'Only a CANCEL offers Remove from calendar.' });
        return;
      }
      const dav = davFor(deps, res);
      if (dav === null) return;
      const calendar = await dav.store.getCollection(accountId, 'calendar', CALENDAR_SLUG);
      if (calendar === null) {
        res.status(503).json({ error: 'no_default_calendar', message: 'No default calendar for this account.' });
        return;
      }
      const name = `${invite.uid}.ics`;
      const existing = await dav.store.getMeta(calendar.id, name);
      if (existing === null) {
        res.status(200).json({ ok: true, removed: false });
        return;
      }
      const [resource] = await dav.store.getResources(calendar.id, [name]);
      const stored = resource === undefined ? null : tryParse(resource.data);
      if (stored === null) {
        res.status(409).json({ error: 'calendar_unreadable', message: 'Not removed: the event in your calendar cannot be read.' });
        return;
      }
      const eligible = cancelEligibility({
        cancelOrganizer: invite.organizer.email,
        cancelSequence: invite.sequence,
        storedOrganizer: storedOrganizer(stored),
        storedSequence: storedSequence(stored),
        auth: message.verdict?.auth ?? null,
        fromAddress: message.fromAddress,
      });
      if (!eligible.ok) {
        res.status(eligible.status).json({ error: eligible.error, message: eligible.message });
        return;
      }
      const base = stored;
      const data = Buffer.from(serializeICalendar(withCancelled(base)), 'utf8');
      const ctx = getAuditContext(req);
      const putOutcome = await dav.store.putResource({ accountId, context: ctx }, calendar, { name, uid: invite.uid, componentType: 'VEVENT', data, preconditions: { ifMatch: `"${existing.etag}"` } });
      if (putOutcome.status !== 'updated' && putOutcome.status !== 'created') {
        res.status(409).json({ error: 'calendar_write_failed', message: 'The calendar event changed at the same time; try again.' });
        return;
      }
      res.status(200).json({ ok: true, removed: true });
    }),
  );

  return router;
}
