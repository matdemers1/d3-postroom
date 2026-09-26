// The DATA seam: durable acceptance (PST-REQ-060), the end-of-DATA decision (PST-REQ-058), the
// Rejects copy (PST-REQ-059) and the trace headers (PST-REQ-069).
//
// Storage choice. Authentication-Results carries DKIM, DMARC and ARC results that are only known
// once the body has ended, but the body must stream to disk as it arrives. So the raw body goes
// into an encrypted scratch spool (spool.ts) while the verifier hashes it; then the checks run;
// then the FINAL message — Received + Authentication-Results + the raw bytes — streams from the
// spool into the blob store, inside the transaction that records it. The stored blob is exactly
// what IMAP will serve: no reader has to re-assemble trace headers at read time.
//
// The contract with the client: 250 is sent only after that transaction has committed, and the
// blob store has fsynced the file (and its directory) before the commit. A crash at any point
// before the commit leaves no row — the client got no 250 and will retry; the orphan blob file and
// the scratch spool are removed by BlobStore.gc(). A crash after the commit loses nothing: the
// spool row (state 'spooled') and its 'inbound' job are already durable, so the worker files it.
//
// Every outcome that stores something stores its reasons: the spool row's `verdicts` holds SPF,
// DKIM, DMARC, ARC, the ARC override, the DNSBL input and the decision, each with its reasons.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Readable as ReadableStream } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  evaluateDmarc,
  verifyArc,
  type ArcResult,
  type DkimDns,
  type DkimResult,
  type DmarcDns,
  type DmarcResult,
  type EvaluateSpfResult,
} from '@postroom/auth-checks';
import { recordAudit } from '@postroom/audit';
import { tmpDir, type BlobStore } from '@postroom/blobstore';
import { ActorKind, InboundState, SpecialUse, type Db, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { parseDate, parseHeaderBlock, parseMailboxes, parseMessageId, type HeaderList } from '@postroom/mime';
import { enqueue } from '@postroom/queue';
import { reply, type SmtpReply } from '@postroom/smtp-proto';
import { decide, type Decision, type DnsblVerdict } from './decide.js';
import { buildAuthenticationResults } from './headers.js';
import type { RecipientAccepted } from './recipients.js';
import { HeaderTap, InboundSpool } from './spool.js';
import { streamFinalMessage } from './trace-rewrite.js';

export type { DnsblVerdict } from './decide.js';

export interface InboundRecipient {
  /** The address as the client wrote it in RCPT TO. */
  readonly rcpt: string;
  readonly resolution: RecipientAccepted;
}

export interface InboundContext {
  readonly sessionId: string;
  /** The transaction id, also written into Received as `id`. */
  readonly transactionId: string;
  readonly hostname: string;
  /** The real client IP (from PROXY v2 when the connection came through the edge). */
  readonly clientIp: string;
  readonly clientPort: number | undefined;
  /** True when the client address came from a PROXY v2 header (the connection came via the edge). */
  readonly proxied?: boolean;
  readonly helo: string | null;
  readonly rdns: string | null;
  readonly secure: boolean;
  /** MAIL FROM as `local@domain`, or null for `<>`. */
  readonly mailFrom: string | null;
  readonly smtputf8: boolean;
  readonly declaredSize: number | undefined;
  readonly recipients: readonly InboundRecipient[];
  readonly receivedAt: Date;
  /** The complete Received field (CRLF-terminated) to prepend. */
  readonly receivedHeader: string;
}

export interface InboundVerdicts {
  /** SPF, evaluated at MAIL FROM. A fail is recorded here, not rejected on (DMARC decides). */
  readonly spf: EvaluateSpfResult;
  /** DKIM results from the streaming verifier; resolves once `body` has been read to the end. */
  readonly dkim: Promise<DkimResult[]>;
  /** The client IP's DNSBL verdict; listed → 554. Supplied by the DNSBL client in PST-T-2.9. */
  readonly dnsbl?: DnsblVerdict | undefined;
}

export type AcceptMessage = (ctx: InboundContext, body: Readable, verdicts: InboundVerdicts) => Promise<SmtpReply>;

/** The seam's answer when no storage is configured: nothing is accepted that is not stored. */
export const STORAGE_PENDING = reply(451, '4.3.0', 'inbound storage is not configured');

/** Drain and refuse temporarily. Used only when the server has no storage (unit-style tests). */
export async function acceptMessage(_ctx: InboundContext, body: Readable, _verdicts: InboundVerdicts): Promise<SmtpReply> {
  await finished(body.resume());
  return STORAGE_PENDING;
}

/** How long a rejected message stays in Rejects (PST-REQ-059). The sweep arrives with retention (PST-T-7.7). */
export const REJECTS_RETENTION_DAYS = 14;

/** The job queue the spool feeds; PST-T-2.7's worker consumes it. */
export const INBOUND_QUEUE = 'inbound';

const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;

export type InboundDns = DmarcDns & DkimDns;

export interface InboundStorage {
  readonly db: Db;
  readonly blobs: BlobStore;
  /** TXT lookups for DMARC policy and ARC keys. */
  readonly dns: InboundDns;
  /** ARC sealer domains trusted to override a DMARC failure (TRUSTED_ARC_SEALERS). */
  readonly trustedArcSealers: readonly string[];
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Test seam: runs inside the accepting transaction, just before it commits. */
  readonly faults?: { readonly beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void> };
}

const ARC_FIELDS = ['arc-seal', 'arc-message-signature', 'arc-authentication-results'];

function formatSmtpReply(r: SmtpReply): string {
  return [String(r.code), ...(r.enhanced === undefined ? [] : [r.enhanced]), r.lines.join(' ')].join(' ');
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function spfVerdict(spf: EvaluateSpfResult) {
  return {
    result: spf.result,
    domain: spf.domain,
    scope: spf.scope,
    ...(spf.mechanism === undefined ? {} : { mechanism: spf.mechanism }),
    reasons: spf.trace,
  };
}

function dkimVerdict(results: readonly DkimResult[]) {
  return results.map((r) => ({
    result: r.result,
    ...(r.domain === undefined ? {} : { domain: r.domain }),
    ...(r.selector === undefined ? {} : { selector: r.selector }),
    ...(r.algorithm === undefined ? {} : { algorithm: r.algorithm }),
    testing: r.testing,
    reasons: r.reasons,
  }));
}

function dmarcVerdict(d: DmarcResult) {
  return {
    result: d.result,
    disposition: d.disposition,
    ...(d.fromDomain === undefined ? {} : { fromDomain: d.fromDomain }),
    ...(d.policy === undefined ? {} : { policy: d.policy }),
    ...(d.policySource === undefined ? {} : { policySource: d.policySource }),
    ...(d.recordDomain === undefined ? {} : { recordDomain: d.recordDomain }),
    sampled: d.sampled,
    reasons: d.reasons,
  };
}

function arcVerdict(a: ArcResult) {
  return { result: a.result, instances: a.instances, sealerDomains: a.sealerDomains, temporary: a.temporary, reasons: a.reasons };
}

interface Denormalised {
  readonly messageIdHeader: string | null;
  readonly subject: string | null;
  readonly fromAddress: string | null;
  readonly sentAt: Date | null;
}

function denormalise(headers: HeaderList | null): Denormalised {
  if (headers === null) return { messageIdHeader: null, subject: null, fromAddress: null, sentAt: null };
  const mid = headers.get('message-id');
  const subject = headers.getDecoded('subject');
  const from = headers.get('from');
  const date = headers.get('date');
  return {
    messageIdHeader: mid === null ? null : parseMessageId(mid),
    subject: subject === null ? null : subject.slice(0, 998),
    fromAddress: from === null ? null : (parseMailboxes(from)[0]?.address ?? null),
    sentAt: date === null ? null : parseDate(date),
  };
}

async function rejectsMailboxName(tx: Prisma.TransactionClient, accountId: string): Promise<string> {
  const mb = await tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse.rejects }, select: { name: true } });
  return mb?.name ?? 'Rejects';
}

/** The acceptor smtp-in uses in production: spool, check, decide, commit, then answer. */
export function createAcceptMessage(storage: InboundStorage): AcceptMessage {
  const { db, blobs } = storage;
  const log = storage.log ?? ((): void => undefined);

  return async (ctx, body, verdicts) => {
    const spool = await InboundSpool.create(tmpDir(blobs.root));
    try {
      // Pass 1: the body (through the DKIM verifier) into the encrypted spool.
      const tap = new HeaderTap();
      await spool.write(body, tap);
      const header = tap.finish();
      const dkim = await verdicts.dkim;
      const headers = header.block === null ? null : parseHeaderBlock(header.block);

      const dmarc = await evaluateDmarc({
        dns: storage.dns,
        from: headers?.getAll('from') ?? [],
        spf: { result: verdicts.spf.result, domain: verdicts.spf.domain },
        dkim,
      });
      // Pass 2 (only when there is a chain to check): ARC reads the spool once.
      const hasArc = headers !== null && ARC_FIELDS.some((f) => headers.has(f));
      const arc = await verifyArc(hasArc ? spool.open() : (header.block ?? Buffer.alloc(0)), { dns: storage.dns });

      const decision: Decision = decide({
        dmarc,
        arc,
        trustedArcSealers: storage.trustedArcSealers,
        dnsbl: verdicts.dnsbl,
        headerTooLarge: header.block === null,
      });

      if (decision.action === 'defer') {
        const r = decision.reply ?? reply(451, '4.3.0', 'Try again later');
        log('inbound-deferred', { session: ctx.sessionId, tx: ctx.transactionId, rule: decision.rule, reasons: decision.reasons });
        return r;
      }

      const authResults = buildAuthenticationResults({
        hostname: ctx.hostname,
        clientIp: ctx.clientIp,
        spf: verdicts.spf,
        dkim,
        extra: [dmarc.authResults, arc.authResults],
      });
      const trace = Buffer.from(ctx.receivedHeader + authResults, 'utf8');

      const id = randomUUID();
      const accepted = decision.action === 'accept';
      const answer = accepted ? reply(250, '2.0.0', `Queued as ${id}`) : (decision.reply ?? reply(550, '5.7.1', 'Rejected'));
      const rejectsExpireAt = new Date(ctx.receivedAt.getTime() + REJECTS_RETENTION_DAYS * 86_400_000);
      const recipients = ctx.recipients.map((r) => ({
        rcpt: r.rcpt,
        address: r.resolution.address,
        accountIds: r.resolution.accountIds,
        kind: r.resolution.kind,
        ...(r.resolution.tag === undefined ? {} : { tag: r.resolution.tag }),
        ...(r.resolution.siteTag === undefined ? {} : { siteTag: r.resolution.siteTag }),
      }));
      const accountIds = [...new Set(ctx.recipients.flatMap((r) => r.resolution.accountIds))];
      const auth = {
        spf: spfVerdict(verdicts.spf),
        dkim: dkimVerdict(dkim),
        dmarc: dmarcVerdict(dmarc),
        arc: arcVerdict(arc),
        ...(decision.arcOverride === undefined ? {} : { arcOverride: decision.arcOverride }),
      };
      const stored = {
        ...auth,
        dnsbl: verdicts.dnsbl ?? null,
        decision: { action: decision.action, rule: decision.rule, disposition: decision.disposition, reasons: decision.reasons },
        ...(accepted
          ? {}
          : { rejects: { retentionDays: REJECTS_RETENTION_DAYS, expiresAt: rejectsExpireAt.toISOString(), sweep: 'PST-T-7.7' } }),
      };

      // Pass 3, inside the one transaction: trace headers + spool → the final blob (fsynced before
      // put() returns), the session and spool rows, the job or the Rejects copies, the audit row.
      const outcome = await db.$transaction(async (tx) => {
        const blob = await blobs.put(ReadableStream.from(streamFinalMessage(trace, header, spool.open(), ctx.hostname)), { tx });
        await tx.inboundSession.upsert({
          where: { id: ctx.sessionId },
          create: {
            id: ctx.sessionId,
            clientIp: ctx.clientIp,
            proxied: ctx.proxied ?? false,
            helo: ctx.helo,
            rdns: ctx.rdns,
            tls: ctx.secure ? 'STARTTLS' : null,
          },
          update: {},
        });
        await tx.inboundMessage.create({
          data: {
            id,
            sessionId: ctx.sessionId,
            receivedAt: ctx.receivedAt,
            envelopeFrom: ctx.mailFrom ?? '',
            recipients: json(recipients),
            blobSha256: blob.sha256,
            size: blob.size,
            state: accepted ? InboundState.spooled : InboundState.rejected,
            verdicts: json(stored),
            disposition: decision.disposition,
            dispositionReason: decision.reasons.join('; '),
            smtpReply: formatSmtpReply(answer),
          },
        });

        const copies: { messageId: string; accountId: string; mailboxId: string; uid: number }[] = [];
        if (accepted) {
          await enqueue(tx, INBOUND_QUEUE, { inboundMessageId: id }, { idempotencyKey: `inbound:${id}` });
        } else {
          // No silent deletion: every local recipient keeps a copy in Rejects (PST-REQ-059).
          const denorm = denormalise(headers);
          for (const accountId of accountIds) {
            const filed = await fileLocalMessage(tx, {
              accountId,
              mailbox: await rejectsMailboxName(tx, accountId),
              blobSha256: blob.sha256,
              size: blob.size,
              internalDate: ctx.receivedAt,
            });
            await tx.message.update({ where: { id: filed.id }, data: { inboundMessageId: id, ...denorm } });
            await tx.messageVerdict.create({
              data: {
                messageId: filed.id,
                auth: json(auth),
                bucket: 'rejects',
                reasons: [...decision.reasons, `rejected with ${formatSmtpReply(answer)}`, `kept in Rejects until ${rejectsExpireAt.toISOString()}`],
              },
            });
            copies.push({ messageId: filed.id, accountId, mailboxId: filed.mailboxId, uid: filed.uid });
          }
          // Each Message holds its own reference to the blob; the spool row holds the first.
          if (copies.length > 0) {
            await tx.blob.update({ where: { sha256: blob.sha256 }, data: { refcount: { increment: copies.length } } });
          }
        }

        await recordAudit(tx, {
          actor: { kind: ActorKind.system, label: 'smtp-in' },
          action: accepted ? 'inbound.accept' : 'inbound.reject',
          entityType: 'inbound_message',
          entityId: id,
          before: null,
          after: {
            sessionId: ctx.sessionId,
            transactionId: ctx.transactionId,
            clientIp: ctx.clientIp,
            envelopeFrom: ctx.mailFrom,
            recipients: recipients.map((r) => r.address),
            blobSha256: blob.sha256,
            size: blob.size,
            disposition: decision.disposition,
            rule: decision.rule,
            reasons: decision.reasons,
            smtpReply: formatSmtpReply(answer),
            ...(accepted ? {} : { rejectsCopies: copies, rejectsExpireAt: rejectsExpireAt.toISOString() }),
          },
        });
        await storage.faults?.beforeCommit?.(tx);
        return { sha256: blob.sha256, size: blob.size, copies: copies.length };
      }, TX_OPTIONS);

      log(accepted ? 'inbound-accepted' : 'inbound-rejected', {
        session: ctx.sessionId,
        tx: ctx.transactionId,
        inboundMessageId: id,
        disposition: decision.disposition,
        rule: decision.rule,
        size: outcome.size,
        rejectsCopies: outcome.copies,
      });
      // Only now, with the blob fsynced and the transaction committed, may the client hear 250.
      return answer;
    } finally {
      await spool.dispose();
    }
  };
}
