// Accepting one submitted message — the "submission path", shared by the SMTP daemon (server.ts,
// RFC 6409 on 587/465) and the webmail composer (apps/api, POST /api/compose/send, PST-T-3.11), so
// both run exactly the same checks and writes:
//
//   PST-REQ-028  the From header must be one of the submitter's own addresses (553 / 403);
//   PST-REQ-038  DKIM-signed (Ed25519 + RSA) for the From domain, or refused — never sent unsigned;
//   PST-REQ-043  the authoritative recipient-cap check, inside the accepting transaction;
//   PST-REQ-060  the signed blob is fsynced and its queue rows, jobs and audit row committed as one;
//   PST-REQ-009  one `submission.accept` audit row per accepted message;
//   PST-REQ-138  after the commit, To/Cc recipients in none of the account's address books are
//                added to its "Collected" address book (@postroom/dav-store's harvest).
//
// What differs between the callers is passed in: who the submitter is (an app password, or a web
// session with none), how caps are enforced for them, the audit context, and an optional hook that
// runs inside the same transaction (the webmail files its Sent copy there, so a message is either
// queued AND in Sent, or neither).
import { Readable } from 'node:stream';
import { HeaderTooLargeError, signMessage, splitMessage, type HeaderField } from '@postroom/auth-checks';
import { recordAudit, type RequestContext } from '@postroom/audit';
import { contactIndexFor, DavStore, DEFAULT_DAV_LIMITS, harvestRecipients, type DavLimits } from '@postroom/dav-store';
import { tmpDir, type BlobStore } from '@postroom/blobstore';
import type { Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import { enqueueOutbound } from '@postroom/delivery';
import { parseMailboxes } from '@postroom/mime';
import { reply, type SmtpReply } from '@postroom/smtp-proto';
import { CapExceededError } from './caps-seam.js';
import { loadSigningKeys } from './dkim.js';
import { fieldValue, inspectHeaders, rewriteHeaders } from './headers.js';
import { Spool } from './spool.js';

export const AcceptReplies = {
  fromMissing: reply(553, '5.7.1', 'Message must have exactly one From header with your address'),
  fromNotOwned: reply(553, '5.7.1', 'From header address is not yours'),
  headerTooLarge: reply(552, '5.3.4', 'Header block too large'),
  dkimUnconfigured: reply(451, '4.3.5', 'DKIM keys not configured for the sender domain'),
} as const satisfies Record<string, SmtpReply>;

export interface SubmissionStorage {
  readonly blobs: BlobStore;
  readonly kek: Kek;
}

/** Who is submitting: the account, the credential (none from a web session), and what it may send as. */
export interface Submitter {
  readonly accountId: string;
  /** The app password that authenticated (SMTP). Absent for the webmail, which has a session instead. */
  readonly appPasswordId?: string;
  /** Lowercased `local@domain` the account may send as. */
  readonly addresses: ReadonlySet<string>;
}

/** Authoritative cap check, run inside the accepting transaction before anything is inserted. */
export type EnforceSubmitterCaps = (tx: Prisma.TransactionClient, recipients: readonly string[], now: Date) => Promise<void>;

/** What the in-transaction hook is told about the message it is being accepted with. */
export interface AcceptedMessage {
  readonly outboundId: string;
  readonly messageId: string;
  readonly headerFrom: string;
  readonly subject: string | undefined;
  readonly blobSha256: string;
  readonly size: number;
}

export interface AcceptDeps {
  readonly db: Db;
  /** Opened only once the headers have passed, as the daemon has always done. */
  readonly storage: () => SubmissionStorage;
  readonly now: () => Date;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
  readonly maxHeaderBytes?: number;
  /** Test seam: runs inside the accepting transaction, after every write, before the commit. */
  readonly beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** The DAV caps the contact harvest writes under (default: the DAV daemon's defaults). */
  readonly davLimits?: DavLimits;
}

export interface AcceptInput {
  readonly submitter: Submitter;
  /** RFC 5321 reverse-path, already checked against the submitter's addresses by the caller. */
  readonly envelopeFrom: string;
  readonly recipients: readonly { readonly address: string; readonly notify?: string }[];
  readonly dsnRet?: string | undefined;
  readonly dsnEnvid?: string | undefined;
  /** For log lines: the SMTP session id, or the HTTP request id. */
  readonly sessionId: string;
  /** outbound_message.submitted_via: 'submission' (SMTP) or 'webmail'. */
  readonly submittedVia: string;
  readonly enforceCaps: EnforceSubmitterCaps;
  readonly auditContext: RequestContext;
  /** Runs inside the accepting transaction, after the queue and audit writes (e.g. file the Sent copy). */
  readonly withinTransaction?: (tx: Prisma.TransactionClient, accepted: AcceptedMessage) => Promise<void>;
}

export type AcceptOutcome =
  | ({ readonly ok: true } & AcceptedMessage)
  | {
      readonly ok: false;
      readonly reason: 'header-too-large' | 'from-missing' | 'from-not-owned' | 'dkim-unconfigured' | 'cap-exceeded';
      readonly reply: SmtpReply;
    };

const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;
const DEFAULT_MAX_HEADER_BYTES = 1024 * 1024;

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * The account's live addresses (`local@domain`, lowercased): the ones it may send as. The same
 * query protocol login answers with (credentials' verifyProtocolLogin), for callers that have a web
 * session rather than an app password.
 */
export async function sendableAddresses(db: Db, accountId: string): Promise<string[]> {
  const rows = await db.address.findMany({
    where: { accountId, killedAt: null },
    select: { localPart: true, domain: { select: { name: true } } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((a) => `${a.localPart}@${a.domain.name}`.toLowerCase());
}

/**
 * Contact auto-harvest (PST-REQ-138), after the commit: the message is accepted whatever happens
 * here, so a failure is logged and never answered. Idempotent (one card per address, written
 * If-None-Match: *), so a retried submission cannot duplicate a card. To and Cc only — a Bcc
 * recipient was deliberately kept out of the message.
 */
async function harvestContacts(deps: AcceptDeps, kek: Kek, input: AcceptInput, fields: readonly HeaderField[]): Promise<void> {
  try {
    const named = fields.filter((f) => f.key === 'to' || f.key === 'cc').flatMap((f) => parseMailboxes(fieldValue(f)));
    if (named.length === 0) return;
    const store = new DavStore(deps.db, kek, deps.davLimits ?? DEFAULT_DAV_LIMITS);
    const result = await harvestRecipients(deps.db, store, contactIndexFor(deps.db, kek), {
      accountId: input.submitter.accountId,
      recipients: named,
      context: input.auditContext,
      now: deps.now(),
    });
    if (result.added.length > 0) deps.log('contacts-harvested', { session: input.sessionId, accountId: input.submitter.accountId, added: result.added.length });
  } catch (err) {
    deps.log('contacts-harvest-failed', { session: input.sessionId, accountId: input.submitter.accountId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Header check → keys → header fix-ups → encrypted spool → sign → one transaction (caps, blob,
 * queue, audit, hook). Resolves with the outcome; throws only on an unexpected failure (the caller
 * answers "not accepted"). `body` is the whole message, streamed; it is never held in memory.
 */
export async function acceptSubmission(body: Readable, input: AcceptInput, deps: AcceptDeps): Promise<AcceptOutcome> {
  const { submitter } = input;
  const owns = (address: string): boolean => submitter.addresses.has(address.toLowerCase());

  // 1. The header block (bounded), and the sender check on it (PST-REQ-028).
  let split;
  try {
    split = await splitMessage(body, { maxHeaderBytes: deps.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES });
  } catch (err) {
    if (err instanceof HeaderTooLargeError) return { ok: false, reason: 'header-too-large', reply: AcceptReplies.headerTooLarge };
    throw err;
  }
  const headers = inspectHeaders(split.headerBlock);
  if (!headers.ok) {
    deps.log('sender-refused', { session: input.sessionId, accountId: submitter.accountId, reason: headers.reason });
    return { ok: false, reason: 'from-missing', reply: AcceptReplies.fromMissing };
  }
  if (!headers.from.every(owns)) {
    deps.log('sender-refused', { session: input.sessionId, accountId: submitter.accountId, reason: 'header-from' });
    return { ok: false, reason: 'from-not-owned', reply: AcceptReplies.fromNotOwned };
  }
  const headerFrom = headers.from[0] ?? input.envelopeFrom;
  const signingDomain = domainOf(headerFrom);

  // 2. Keys before any work: never send unsigned (PST-REQ-038).
  const storage = deps.storage();
  const keys = await loadSigningKeys(deps.db, storage.kek, signingDomain, deps.now());
  if (keys === null) {
    deps.log('dkim-unconfigured', { session: input.sessionId, domain: signingDomain });
    return { ok: false, reason: 'dkim-unconfigured', reply: AcceptReplies.dkimUnconfigured };
  }

  // 3. Header fix-ups, then pass 1: the fixed message into the encrypted spool.
  const fixed = rewriteHeaders(headers.fields, { domain: signingDomain, now: deps.now() });
  const spool = await Spool.create(tmpDir(storage.blobs.root));
  try {
    await spool.write(
      (async function* message(): AsyncGenerator<Buffer> {
        yield fixed.block;
        yield Buffer.from('\r\n', 'latin1');
        for await (const chunk of split.body) yield chunk;
      })(),
    );

    // Pass 2: sign (one read of the spool; body hashed once for both keys).
    const signatures = await signMessage(spool.open(), { domain: signingDomain, keys, now: deps.now() });

    const recipients = input.recipients.map((r) => r.address);

    // Pass 3, inside the one accepting transaction: the authoritative cap check (PST-REQ-043/044
    // — advisory-locked, recounted against whatever is actually persisted, so a concurrent
    // submission for the same credential cannot both pass it), then signatures + spool → the
    // final blob (fsynced before put() returns), the queue rows and jobs, the audit row, the
    // caller's hook. Commit, then answer.
    try {
      const accepted = await deps.db.$transaction(async (dbTx) => {
        await input.enforceCaps(dbTx, recipients, deps.now());
        const blob = await storage.blobs.put(
          Readable.from(
            (async function* signed(): AsyncGenerator<Buffer> {
              for (const s of signatures) yield Buffer.from(s, 'latin1');
              for await (const chunk of spool.open()) yield chunk as Buffer;
            })(),
          ),
          { tx: dbTx },
        );
        const queued = await enqueueOutbound(dbTx, {
          accountId: submitter.accountId,
          ...(submitter.appPasswordId === undefined ? {} : { appPasswordId: submitter.appPasswordId }),
          envelopeFrom: input.envelopeFrom,
          headerFrom,
          messageId: fixed.messageId,
          ...(headers.subject === undefined ? {} : { subject: headers.subject.slice(0, 998) }),
          blobSha256: blob.sha256,
          size: blob.size,
          ...(input.dsnRet === undefined ? {} : { dsnRet: input.dsnRet }),
          ...(input.dsnEnvid === undefined ? {} : { dsnEnvid: input.dsnEnvid }),
          submittedVia: input.submittedVia,
          recipients: input.recipients,
        });
        await recordAudit(dbTx, {
          actor: { kind: 'account', accountId: submitter.accountId },
          action: 'submission.accept',
          entityType: 'outbound_message',
          entityId: queued.message.id,
          before: null,
          after: {
            appPasswordId: submitter.appPasswordId,
            ...(input.submittedVia === 'submission' ? {} : { submittedVia: input.submittedVia }),
            envelopeFrom: input.envelopeFrom,
            headerFrom,
            messageId: fixed.messageId,
            blobSha256: blob.sha256,
            size: blob.size,
            recipients: queued.recipients,
            domains: queued.domains,
            dkim: keys.map((k) => `${k.algorithm}:${k.selector}`),
            addedMessageId: fixed.addedMessageId,
            addedDate: fixed.addedDate,
            strippedBcc: fixed.strippedBcc,
          },
          context: input.auditContext,
        });
        const message: AcceptedMessage = {
          outboundId: queued.message.id,
          messageId: fixed.messageId,
          headerFrom,
          subject: headers.subject,
          blobSha256: blob.sha256,
          size: blob.size,
        };
        await input.withinTransaction?.(dbTx, message);
        await deps.beforeCommit?.(dbTx);
        return message;
      }, TX_OPTIONS);

      deps.log('accepted', { session: input.sessionId, accountId: submitter.accountId, outboundMessageId: accepted.outboundId, recipients: recipients.length });
      await harvestContacts(deps, storage.kek, input, headers.fields);
      return { ok: true, ...accepted };
    } catch (err) {
      if (err instanceof CapExceededError) {
        deps.log('caps-refused', { session: input.sessionId, accountId: submitter.accountId, stage: 'data' });
        // Only after the transaction has rolled back: alerting is a network call and must not
        // hold the advisory lock (or the row lock backing it) open.
        await err.alert?.();
        return { ok: false, reason: 'cap-exceeded', reply: err.reply };
      }
      throw err;
    }
  } finally {
    await spool.dispose();
  }
}
