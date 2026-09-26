// Accepting a message into the outbound queue. Called inside the submission server's transaction,
// so the message row, its recipients and their jobs commit together with whatever else accepted the
// message: once that commit returns, the message is in the queue and cannot be lost (PST-REQ-060).
import type { Db, OutboundMessage, Prisma } from '@postroom/db';
import { enqueue } from '@postroom/queue';

type Tx = Prisma.TransactionClient | Db;

export const OUTBOUND_QUEUE = 'outbound';

/** The job payload: one job per (message, recipient domain), so one SMTP transaction per domain. */
export interface OutboundJobPayload {
  messageId: string;
  domain: string;
}

/**
 * Idempotency key for the job of a domain group at a given generation. Generation 0 is the job
 * enqueued on acceptance; after an attempt that leaves recipients deferred, the next job carries
 * the highest attempt count in the group, so re-running a handler after a crash enqueues nothing new.
 */
export function outboundJobKey(messageId: string, domain: string, generation: number | string): string {
  return `outbound:${messageId}:${domain}:${String(generation)}`;
}

/** Transport policy: which transport a domain is sent through. Default: direct MX for everything. */
export type TransportPolicy = (domain: string) => 'direct' | 'ses';
export const directForEverything: TransportPolicy = () => 'direct';

export interface OutboundRecipientInput {
  address: string;
  /** RFC 3461 NOTIFY as given on RCPT TO; omitted = the default (FAILURE,DELAY). */
  notify?: string;
}

export interface EnqueueOutboundInput {
  accountId: string;
  appPasswordId?: string;
  envelopeFrom: string;
  headerFrom: string;
  messageId?: string;
  subject?: string;
  blobSha256: string;
  size: number;
  dsnRet?: string;
  dsnEnvid?: string;
  submittedVia: string;
  recipients: readonly OutboundRecipientInput[];
}

export interface EnqueueOutboundOptions {
  transportFor?: TransportPolicy;
  /** Clock, for tests: sets createdAt/nextAttemptAt/runAt so a fake clock can walk the schedule. */
  now?: Date;
}

export interface EnqueuedOutbound {
  message: OutboundMessage;
  recipients: number;
  domains: string[];
}

/** The domain of an address (after the last '@'), lowercased. Throws on an address with no domain. */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
  if (at < 1 || domain === '') throw new Error(`outbound recipient has no domain: "${address}"`);
  return domain;
}

/**
 * Create the OutboundMessage, one OutboundRecipient per distinct recipient, and one 'outbound' job
 * per recipient domain, all through `tx`. Pass a transaction client so they commit as one.
 */
export async function enqueueOutbound(tx: Tx, input: EnqueueOutboundInput, options: EnqueueOutboundOptions = {}): Promise<EnqueuedOutbound> {
  if (input.recipients.length === 0) throw new Error('an outbound message needs at least one recipient');
  const now = options.now ?? new Date();
  const policy = options.transportFor ?? directForEverything;

  // Same mailbox twice (differing only in domain case) is one recipient: RCPT once, deliver once.
  const byKey = new Map<string, { address: string; domain: string; notify: string | null }>();
  for (const r of input.recipients) {
    const domain = recipientDomain(r.address);
    const local = r.address.slice(0, r.address.lastIndexOf('@'));
    const address = `${local}@${domain}`;
    if (!byKey.has(address)) byKey.set(address, { address, domain, notify: r.notify ?? null });
  }

  const message = await tx.outboundMessage.create({
    data: {
      accountId: input.accountId,
      envelopeFrom: input.envelopeFrom,
      headerFrom: input.headerFrom,
      blobSha256: input.blobSha256,
      size: input.size,
      submittedVia: input.submittedVia,
      createdAt: now,
      ...(input.appPasswordId === undefined ? {} : { appPasswordId: input.appPasswordId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.dsnRet === undefined ? {} : { dsnRet: input.dsnRet }),
      ...(input.dsnEnvid === undefined ? {} : { dsnEnvid: input.dsnEnvid }),
    },
  });

  const recipients = [...byKey.values()];
  await tx.outboundRecipient.createMany({
    data: recipients.map((r) => ({
      outboundMessageId: message.id,
      address: r.address,
      domain: r.domain,
      state: 'queued' as const,
      nextAttemptAt: now,
      dsnNotify: r.notify,
      transport: policy(r.domain),
      createdAt: now,
      updatedAt: now,
    })),
  });

  const domains = [...new Set(recipients.map((r) => r.domain))].sort();
  for (const domain of domains) {
    const payload: OutboundJobPayload = { messageId: message.id, domain };
    await enqueue(tx, OUTBOUND_QUEUE, { ...payload }, { runAt: now, maxAttempts: 1000, idempotencyKey: outboundJobKey(message.id, domain, 0) });
  }
  return { message, recipients: recipients.length, domains };
}
