// The DSN generation hook (PST-T-1.7): the delivery worker calls this once per DsnIntent, after it
// has committed the recipient's new state. We build an RFC 3464 report and file it straight into
// the sender's INBOX — Postroom's senders are local accounts, so "send the sender a DSN" never goes
// near SMTP.
import { Readable } from 'node:stream';
import type { BlobStore } from '@postroom/blobstore';
import { ActorKind, type Db } from '@postroom/db';
import { recordAudit } from '@postroom/audit';
import { buildDsn, fileLocalMessage, type DsnRecipientReport } from '@postroom/dsn';
import type { DsnIntent } from './state.js';
import type { DsnHook, Log } from './worker.js';

export interface CreateDsnHookOptions {
  db: Db;
  blobstore: BlobStore;
  now?: () => Date;
  /** Reporting-MTA in the report; the outbound MX identity. */
  reportingMta?: string;
  /** `From:` of the DSN itself; always the postmaster, never a real mailbox. */
  from?: string;
  log?: Log;
}

const HEADER_CAP_BYTES = 64 * 1024;
/** RET=FULL only embeds the whole original when it's no bigger than this; otherwise headers only. */
const FULL_MESSAGE_CAP_BYTES = 1024 * 1024;

/** Reads a stream up to and including the blank line ending the headers, bounded to `capBytes`. */
async function readHeaderBlock(stream: Readable, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      total += buf.length;
      const combined = Buffer.concat(chunks);
      const idx = combined.indexOf('\r\n\r\n');
      if (idx !== -1) return combined.subarray(0, idx + 2);
      if (total >= capBytes) return combined.subarray(0, capBytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

async function readWholeStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function diagnosticCode(code: number | null, enhanced: string | null, text: string): string | undefined {
  if (code === null && enhanced === null && text === '') return undefined;
  if (code === null) return `x-postroom; ${[enhanced, text].filter((s) => s !== null && s !== '').join(' ')}`;
  return `smtp; ${[code, enhanced, text].filter((s) => s !== null && s !== '').join(' ')}`;
}

/** A default enhanced status when the transport never gave one — 4.4.7/5.4.7 is "delivery time expired". */
function statusFor(kind: 'delay' | 'failure', enhanced: string | null): string {
  if (enhanced !== null && enhanced !== '') return enhanced;
  return kind === 'delay' ? '4.4.7' : '5.4.7';
}

/**
 * Builds the `onDsn` hook the delivery worker calls. Idempotent per (recipient, kind): if the
 * recipient's *DsnSentAt is already set for this kind, the hook is a no-op, so a retried call (the
 * worker's own retry-on-throw, or `sweep()` re-emitting an unconfirmed failure DSN) never files a
 * second copy. Generates no DSN for a null envelope sender (PST-REQ-034's "send the sender a DSN"
 * has no sender to send to, and RFC 3834 forbids replying to one).
 */
export function createDsnHook(options: CreateDsnHookOptions): DsnHook {
  const { db, blobstore } = options;
  const clock = options.now ?? (() => new Date());
  const reportingMta = options.reportingMta ?? 'mx.d3cloud.io';
  const log: Log = options.log ?? (() => undefined);

  return async (intent: DsnIntent): Promise<void> => {
    const recipient = await db.outboundRecipient.findUnique({ where: { id: intent.recipientId } });
    if (recipient === null) return;
    if (intent.kind === 'delay' && recipient.delayDsnSentAt !== null) return;
    if (intent.kind === 'failure' && recipient.failureDsnSentAt !== null) return;

    const message = await db.outboundMessage.findUnique({ where: { id: intent.outboundMessageId } });
    if (message === null) return;
    if (message.envelopeFrom === '') {
      // Null sender: never generate a DSN for a DSN (no bounce loops).
      log('dsn-skipped-null-sender', { recipientId: intent.recipientId, kind: intent.kind });
      return;
    }

    const latestAttempt = await db.deliveryAttempt.findFirst({
      where: { recipientId: intent.recipientId },
      orderBy: { startedAt: 'desc' },
    });

    const wantsFull = message.dsnRet === 'FULL';
    const originalStream = await blobstore.get(message.blobSha256);
    let originalMessageHeaders: Buffer;
    let originalIsFullMessage = false;
    if (wantsFull && message.size <= FULL_MESSAGE_CAP_BYTES) {
      originalMessageHeaders = await readWholeStream(originalStream);
      originalIsFullMessage = true;
    } else {
      originalMessageHeaders = await readHeaderBlock(originalStream, HEADER_CAP_BYTES);
    }

    const status = statusFor(intent.kind, intent.enhanced);
    const recipientReport: DsnRecipientReport = {
      finalRecipient: intent.address,
      action: intent.kind === 'delay' ? 'delayed' : 'failed',
      status,
      lastAttemptDate: intent.at,
      ...(latestAttempt?.mxHost !== null && latestAttempt?.mxHost !== undefined ? { remoteMta: latestAttempt.mxHost } : {}),
      ...(() => {
        const diag = diagnosticCode(intent.code, intent.enhanced, intent.text);
        return diag === undefined ? {} : { diagnosticCode: diag };
      })(),
      ...(intent.kind === 'delay' && intent.willRetryUntil !== undefined ? { willRetryUntil: intent.willRetryUntil } : {}),
    };

    const dsnBuffer = buildDsn({
      kind: intent.kind,
      reportingMta,
      arrivalDate: intent.queuedAt,
      ...(message.dsnEnvid !== null ? { originalEnvelopeId: message.dsnEnvid } : {}),
      originalMessageHeaders,
      originalIsFullMessage,
      recipients: [recipientReport],
      from: options.from ?? 'Mail Delivery System <mailer-daemon@d3cloud.io>',
      to: message.envelopeFrom,
      date: clock(),
      messageId: `dsn-${intent.recipientId}-${intent.kind}@${reportingMta}`,
    });

    await db.$transaction(async (tx) => {
      const put = await blobstore.put(dsnBuffer, { tx });
      const filed = await fileLocalMessage(tx, {
        accountId: message.accountId,
        mailbox: 'INBOX',
        blobSha256: put.sha256,
        size: put.size,
        internalDate: clock(),
      });
      await recordAudit(tx, {
        actor: { kind: ActorKind.system },
        action: intent.kind === 'delay' ? 'dsn.delay' : 'dsn.failure',
        entityType: 'outbound_recipient',
        entityId: intent.recipientId,
        after: { messageId: filed.id, mailboxId: filed.mailboxId, uid: filed.uid, address: intent.address },
      });
    });
    log('dsn-filed', { recipientId: intent.recipientId, kind: intent.kind, address: intent.address });
  };
}
