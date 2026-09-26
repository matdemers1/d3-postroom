// Stage 4, sieve (PST-T-9.5, PST-REQ-148): each recipient account's ACTIVE Sieve script — stored by
// ManageSieve or the webmail rules builder — runs against the message, and its decisions are
// recorded in this stage's marker for the file stage to carry out. The interpreter
// (@postroom/sieve) only decides; nothing here moves mail except a vacation reply.
//
// What each account's outcome holds, with its reasons (sorting decisions keep their reasons):
//   · deliveries — keep / fileinto (mailbox, imap4flags flags, :create), the implicit keep last;
//   · discard    — the file stage never deletes silently: a discard with nothing else to file lands
//                  in Trash with the reason (PST-REQ-148's "no silent deletion");
//   · redirects  — allowed only to an address the account itself owns (PST-REQ-053: Postroom never
//                  relays). An allowed redirect is delivered to that account's own INBOX; a refused
//                  one is recorded with its reason and the message is kept;
//   · bucket     — vnd.postroom.bucket, which overrides the classifier's bucket for a keep;
//   · vacation   — RFC 5230, sent here (see below);
//   · error      — a runtime error falls back to the implicit keep, and says so;
//   · trace      — what ran and what each test decided (bounded).
//
// Vacation (RFC 5230 §4). The interpreter already suppresses replies to lists, bulk and
// auto-submitted mail, null and automated senders, mail not addressed to the account, and senders
// already answered within :days (via the store below). This stage adds: no reply to mail the
// classifier put in Junk or smtp-in quarantined (no backscatter), a daily cap per account, and
// exactly-once. The reply goes through the submission path (@postroom/submission's
// acceptSubmission: From must be the account's own, DKIM-signed or not sent, queued and audited)
// with the null reverse-path (RFC 5230 §5.1) and Auto-Submitted: auto-replied. A reply row
// (sieve_vacation_reply, unique per account and inbound message) is inserted in the SAME transaction
// that queues it, so a replayed or resumed stage finds the row and never sends a second reply.
//
// Replay-safe: the script, the message and the store are the same on a re-run, so the recorded
// decisions are the same; the only side effect (vacation) is guarded by that row.
import { Readable } from 'node:stream';
import type { BlobStore } from '@postroom/blobstore';
import { Prisma, type Db } from '@postroom/db';
import { encodeQuotedPrintable, formatHeader, parseMessage, TextPartDecoder } from '@postroom/mime';
import {
  compileScript,
  execute,
  type SieveAction,
  type SieveBodyPart,
  type SieveMessage,
  type SieveResult as SieveRun,
  type VacationAction,
  type VacationStore,
} from '@postroom/sieve';
import { acceptSubmission, formatRfc5322Date, sendableAddresses, type SubmissionStorage } from '@postroom/submission';
import { accountAddresses } from './classify.js';
import { decisionFor, planCopies } from './file.js';
import type { ClassifyResult, Json, ParseResult, SieveAccountOutcome, SieveDeliveryJson, SieveResult, SieveVacationJson, SpooledRecipient, StageDeps, StageInput } from './types.js';

const DAY_MS = 86_400_000;
/** RFC 5230 :days is clamped to 1..30 by the interpreter; the store never needs older rows. */
const MAX_VACATION_DAYS = 30;
const MAX_TRACE = 100;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_RAW_BODY = 4 * 1024 * 1024;
const MAX_PART_CHARS = 1024 * 1024;
export const DEFAULT_VACATION_DAILY_CAP = 200;
export const VACATION_SUBMITTED_VIA = 'sieve-vacation';

/**
 * The message as the interpreter sees it, streamed out of the blob store once: top-level header
 * fields, decoded leaf parts (each capped) and the raw body (capped). Nothing holds the whole message.
 */
export async function sieveMessageFromBlob(blobs: BlobStore, sha256: string, size: number): Promise<Omit<SieveMessage, 'envelope'>> {
  const headers = new Map<string, string[]>();
  const parts: SieveBodyPart[] = [];
  const open = new Map<string, { contentType: string; disposition: string | null; decoder: TextPartDecoder | null; pieces: string[]; length: number }>();
  const head: Buffer[] = [];
  let headLength = 0;
  let inBody = false;
  const raw: Buffer[] = [];
  let rawLength = 0;

  const source = await blobs.get(sha256);
  // Tee: the MIME parser gets every byte; the raw body (after the header block) is kept up to a cap.
  const tee = async function* tee(): AsyncGenerator<Buffer> {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      let rest = chunk;
      if (!inBody) {
        head.push(chunk);
        headLength += chunk.length;
        const joined = Buffer.concat(head);
        const end = headerEnd(joined);
        if (end >= 0) {
          inBody = true;
          rest = joined.subarray(end);
          head.length = 0;
        } else {
          if (headLength > MAX_HEADER_BYTES) inBody = true;
          rest = Buffer.alloc(0);
        }
      }
      if (inBody && rawLength < MAX_RAW_BODY && rest.length > 0) {
        const piece = rest.subarray(0, MAX_RAW_BODY - rawLength);
        raw.push(piece);
        rawLength += piece.length;
      }
      yield chunk;
    }
  };

  for await (const e of parseMessage(tee())) {
    switch (e.type) {
      case 'headers':
        if (e.part.parent === null) {
          for (const f of e.headers.fields) {
            const list = headers.get(f.key);
            if (list === undefined) headers.set(f.key, [f.value]);
            else list.push(f.value);
          }
        }
        if (e.part.kind === 'leaf') {
          const text = e.part.contentType.startsWith('text/');
          open.set(e.part.id, { contentType: e.part.contentType, disposition: e.part.disposition, decoder: text ? new TextPartDecoder(e.part.charset) : null, pieces: [], length: 0 });
        }
        break;
      case 'body': {
        const o = open.get(e.part.id);
        if (o === undefined || o.length >= MAX_PART_CHARS) break;
        const s = o.decoder === null ? e.chunk.toString('latin1') : o.decoder.write(e.chunk);
        const piece = s.slice(0, MAX_PART_CHARS - o.length);
        o.pieces.push(piece);
        o.length += piece.length;
        break;
      }
      case 'end-part': {
        const o = open.get(e.part.id);
        if (o === undefined) break;
        open.delete(e.part.id);
        if (o.decoder !== null && o.length < MAX_PART_CHARS) o.pieces.push(o.decoder.end().slice(0, MAX_PART_CHARS - o.length));
        parts.push({ contentType: o.contentType, content: o.pieces.join(''), disposition: o.disposition });
        break;
      }
      default:
        break;
    }
  }
  const rawBody = Buffer.concat(raw).toString('latin1');
  return { size, header: (name) => headers.get(name.toLowerCase()) ?? [], rawBody: () => rawBody, bodyParts: () => parts };
}

function headerEnd(b: Buffer): number {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0x0a) continue;
    if (b[i + 1] === 0x0a) return i + 2;
    if (b[i + 1] === 0x0d && b[i + 2] === 0x0a) return i + 3;
  }
  return -1;
}

function actionReason(a: SieveAction, script: string): string {
  const where = a.line > 0 ? `sieve "${script}" line ${a.line}` : `sieve "${script}"`;
  switch (a.type) {
    case 'keep':
      return a.implicit ? `${where}: implicit keep${a.flags !== null && a.flags.length > 0 ? ` with flags ${a.flags.join(' ')}` : ''}` : `${where}: keep${a.flags !== null && a.flags.length > 0 ? ` with flags ${a.flags.join(' ')}` : ''}`;
    case 'fileinto':
      return `${where}: fileinto "${a.mailbox}"${a.create ? ' :create' : ''}${a.flags !== null && a.flags.length > 0 ? ` with flags ${a.flags.join(' ')}` : ''}`;
    case 'discard':
      return `${where}: discard`;
    case 'redirect':
      return a.allowed
        ? `${where}: redirect to ${a.address} — the account's own address, so delivered to this account's INBOX (Postroom never relays)`
        : `${where}: redirect to ${a.address} refused (${a.reason ?? 'not an address this account owns'}); the message is kept`;
    case 'vacation':
      return a.respond ? `${where}: vacation reply to ${a.to}` : `${where}: vacation reply suppressed (${a.suppressed ?? 'no reason given'})`;
  }
}

/** The account's own addresses (primary, masked, service, live): the only redirect targets allowed. */
async function ownedAddresses(db: Db, accountId: string): Promise<Set<string>> {
  const rows = await db.address.findMany({ where: { accountId, killedAt: null }, select: { localPart: true, domain: { select: { name: true } } } });
  return new Set(rows.map((a) => `${a.localPart}@${a.domain.name}`.toLowerCase()));
}

/** Vacation replies this account sent to `sender` in the last 30 days, apart from any for this message. */
async function vacationStore(db: Db, accountId: string, sender: string, inboundMessageId: string, now: Date): Promise<VacationStore> {
  const rows = await db.sieveVacationReply.findMany({
    where: {
      accountId,
      sender: sender.toLowerCase(),
      sentAt: { gte: new Date(now.getTime() - MAX_VACATION_DAYS * DAY_MS) },
      OR: [{ inboundMessageId: null }, { inboundMessageId: { not: inboundMessageId } }],
    },
    select: { handle: true, sentAt: true },
  });
  return {
    recentlyResponded: (s, handle, days) => s.toLowerCase() === sender.toLowerCase() && rows.some((r) => r.handle === handle && r.sentAt.getTime() >= now.getTime() - days * DAY_MS),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function crlf(text: string): string {
  const body = text.replace(/\r\n|\r|\n/g, '\r\n');
  return body.endsWith('\r\n') ? body : `${body}\r\n`;
}

/** A msg-id as the header wants it: `<id>` (the parse stage keeps ids without their brackets). */
function bracket(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

/** The RFC 5230 §5 reply: From the account, To the envelope sender, In-Reply-To/References, Auto-Submitted. */
export function buildVacationReply(input: {
  from: string;
  to: string;
  subject: string;
  reason: string;
  mime: boolean;
  inReplyTo: string | null;
  references: readonly string[];
  now: Date;
}): Buffer {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    formatHeader('Subject', input.subject),
    `Date: ${formatRfc5322Date(input.now)}`,
    'Auto-Submitted: auto-replied (vacation)',
    'Precedence: bulk',
  ];
  const inReplyTo = input.inReplyTo === null ? null : bracket(input.inReplyTo);
  if (inReplyTo !== null) lines.push(`In-Reply-To: ${inReplyTo}`);
  const refs = [...new Set([...input.references.map(bracket), ...(inReplyTo === null ? [] : [inReplyTo])])];
  if (refs.length > 0) lines.push(`References: ${refs.join('\r\n ')}`);
  lines.push('MIME-Version: 1.0');
  // :mime — the reason is a whole MIME entity (its own Content-Type and body), placed as is.
  if (input.mime) return Buffer.from(`${lines.join('\r\n')}\r\n${crlf(input.reason)}`, 'utf8');
  const qp = encodeQuotedPrintable(Buffer.from(crlf(input.reason), 'utf8'), { binary: false });
  lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${qp.endsWith('\r\n') ? qp : `${qp}\r\n`}`, 'utf8');
}

interface VacationContext {
  readonly deps: StageDeps;
  readonly input: StageInput;
  readonly parse: ParseResult;
  readonly accountId: string;
  /** The address this account received the message at: the reply's From when it can send as it. */
  readonly deliveredTo: string;
  readonly junk: boolean;
}

async function sendVacation(action: VacationAction, ctx: VacationContext): Promise<SieveVacationJson> {
  const { deps, input, accountId } = ctx;
  const inbound = input.inbound;
  const base: SieveVacationJson = { to: action.to, handle: action.handle, days: action.days, respond: action.respond, sent: false, reason: action.suppressed ?? '', outboundMessageId: null };
  if (!action.respond) return base;
  const done = await deps.db.sieveVacationReply.findUnique({ where: { accountId_inboundMessageId: { accountId, inboundMessageId: inbound.id } }, select: { outboundMessageId: true } });
  if (done !== null) return { ...base, sent: true, reason: 'already sent for this message (a replay sends nothing new)' };
  if (ctx.junk) return { ...base, respond: false, reason: 'suppressed: the message was filed as junk (no backscatter)' };
  if (inbound.disposition === 'quarantine') return { ...base, respond: false, reason: 'suppressed: the message was quarantined (no backscatter)' };
  const now = deps.now();
  const cap = deps.vacationDailyCap ?? DEFAULT_VACATION_DAILY_CAP;
  const sentToday = await deps.db.sieveVacationReply.count({ where: { accountId, sentAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  if (sentToday >= cap) return { ...base, respond: false, reason: `suppressed: this account's daily vacation cap (${cap}) is reached` };
  if (deps.kek === undefined) return { ...base, reason: 'not sent: the worker has no KEK to sign with' };

  const addresses = await sendableAddresses(deps.db, accountId);
  const own = new Set(addresses);
  const wanted = action.from === null ? null : (/<([^>]+)>/.exec(action.from)?.[1] ?? action.from).trim().toLowerCase();
  const from = wanted !== null && own.has(wanted) ? wanted : own.has(ctx.deliveredTo.toLowerCase()) ? ctx.deliveredTo.toLowerCase() : (addresses[0] ?? null);
  if (from === null) return { ...base, reason: 'not sent: the account has no address to send from' };
  const subject = action.subject !== '' ? action.subject : `Auto: ${ctx.parse.subject ?? ''}`.trim();
  const message = buildVacationReply({
    from,
    to: action.to,
    subject,
    reason: action.reason,
    mime: action.mime,
    inReplyTo: ctx.parse.messageId,
    references: ctx.parse.references,
    now,
  });
  const storage: SubmissionStorage = { blobs: deps.blobs, kek: deps.kek() };
  try {
    const outcome = await acceptSubmission(
      Readable.from([message]),
      {
        submitter: { accountId, addresses: own },
        // RFC 5230 §5.1: the null reverse-path, so a bounce of the reply never loops back.
        envelopeFrom: '',
        recipients: [{ address: action.to }],
        sessionId: `sieve-${inbound.id}`,
        submittedVia: VACATION_SUBMITTED_VIA,
        // The per-account daily cap above bounds vacation replies; the handle/:days store bounds them per sender.
        enforceCaps: () => Promise.resolve(),
        auditContext: { requestId: `sieve-vacation-${inbound.id}-${accountId}`, userAgent: 'worker/sieve' },
        withinTransaction: async (tx, accepted) => {
          await tx.sieveVacationReply.create({
            data: { accountId, sender: action.to.toLowerCase(), handle: action.handle, inboundMessageId: inbound.id, outboundMessageId: accepted.outboundId, sentAt: now },
          });
        },
      },
      { db: deps.db, storage: () => storage, now: deps.now, log: deps.log },
    );
    if (!outcome.ok) return { ...base, reason: `not sent: the submission path refused it (${outcome.reason})` };
    return { ...base, sent: true, reason: `sent from ${from} to ${action.to}`, outboundMessageId: outcome.outboundId };
  } catch (err) {
    if (isUniqueViolation(err)) return { ...base, sent: true, reason: 'already sent for this message (a concurrent run sent it)' };
    throw err;
  }
}

function deliveriesOf(run: SieveRun): SieveDeliveryJson[] {
  const out: SieveDeliveryJson[] = [];
  for (const a of run.actions) {
    if (a.type === 'keep') out.push({ kind: 'keep', mailbox: a.mailbox, flags: a.flags === null ? null : [...a.flags], create: false, implicit: a.implicit, line: a.line });
    if (a.type === 'fileinto') out.push({ kind: 'fileinto', mailbox: a.mailbox, flags: a.flags === null ? null : [...a.flags], create: a.create, implicit: false, line: a.line });
  }
  return out;
}

export async function sieveStage(
  input: StageInput,
  deps: StageDeps,
  prior: { parse: ParseResult; classify: ClassifyResult; recipients: readonly SpooledRecipient[] },
): Promise<SieveResult> {
  const { db } = deps;
  const inbound = input.inbound;
  const plans = planCopies(prior.recipients);
  const accounts: Record<string, SieveAccountOutcome> = {};
  const reasons: string[] = [];
  let base: Omit<SieveMessage, 'envelope'> | null = null;
  const now = deps.now();

  for (const plan of plans) {
    const { accountId } = plan;
    const script = await db.sieveScript.findFirst({ where: { accountId, active: true }, select: { name: true, content: true } });
    if (script === null) continue;
    const outcome: SieveAccountOutcome = {
      script: script.name,
      deliveries: [],
      discard: false,
      redirects: [],
      bucket: null,
      vacation: null,
      error: null,
      reasons: [],
      trace: [],
    };
    accounts[accountId] = outcome;

    let compiled;
    try {
      compiled = compileScript(script.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome.error = message;
      outcome.reasons.push(`sieve "${script.name}" no longer compiles (${message}); the message is kept`);
      outcome.deliveries.push({ kind: 'keep', mailbox: 'INBOX', flags: null, create: false, implicit: true, line: 0 });
      continue;
    }

    base ??= await sieveMessageFromBlob(deps.blobs, inbound.blobSha256, inbound.size);
    const rcpt = prior.recipients.find((r) => r.accountIds.includes(accountId));
    const deliveredTo = rcpt?.address ?? '';
    const message: SieveMessage = { ...base, envelope: { from: inbound.envelopeFrom, to: rcpt?.rcpt ?? deliveredTo } };
    const [userAddresses, owned, mailboxes, store] = await Promise.all([
      accountAddresses(db, accountId, prior.recipients),
      ownedAddresses(db, accountId),
      db.mailbox.findMany({ where: { accountId }, select: { name: true } }),
      vacationStore(db, accountId, inbound.envelopeFrom, inbound.id, now),
    ]);
    const names = new Set(mailboxes.map((m) => m.name));
    const run = execute(compiled, message, {
      userAddresses,
      ownsAddress: (address) => owned.has(address.toLowerCase()),
      mailboxExists: (name) => names.has(name) || (name.toUpperCase() === 'INBOX' && names.has('INBOX')),
      vacationStore: store,
    });

    outcome.reasons.push(`sieve: ran "${script.name}"`);
    outcome.deliveries = deliveriesOf(run);
    outcome.bucket = run.bucket;
    outcome.trace = run.trace.slice(0, MAX_TRACE).map((t) => `${t.line}:${t.column} ${t.event}`);
    if (run.error !== null) {
      outcome.error = run.error.message;
      outcome.reasons.push(`sieve "${script.name}": runtime error (${run.error.message}); fell back to the implicit keep`);
    }
    for (const a of run.actions) {
      if (a.type === 'discard') outcome.discard = true;
      if (a.type === 'redirect') outcome.redirects.push({ address: a.address, allowed: a.allowed, reason: a.reason, line: a.line });
      if (a.type !== 'vacation') outcome.reasons.push(actionReason(a, script.name));
    }
    if (run.bucket !== null) outcome.reasons.push(`sieve "${script.name}": bucket "${run.bucket}"`);
    const vacation = run.actions.find((a): a is VacationAction => a.type === 'vacation');
    if (vacation !== undefined) {
      const junk = decisionFor(prior.classify, accountId).bucket === 'junk';
      outcome.vacation = await sendVacation(vacation, { deps, input, parse: prior.parse, accountId, deliveredTo, junk });
      outcome.reasons.push(
        outcome.vacation.sent
          ? `sieve "${script.name}" line ${vacation.line}: vacation reply ${outcome.vacation.reason}`
          : `sieve "${script.name}" line ${vacation.line}: vacation reply ${outcome.vacation.respond ? outcome.vacation.reason : `suppressed (${outcome.vacation.reason})`}`,
      );
    }
  }

  const ran = Object.keys(accounts).length;
  const applied = ran > 0;
  reasons.push(applied ? `sieve: ${ran} of ${plans.length} recipient account(s) ran an active script` : 'sieve: no recipient account has an active script');
  return { applied, reasons, accounts: accounts as unknown as { [accountId: string]: Json } };
}
