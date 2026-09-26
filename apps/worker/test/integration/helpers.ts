// Building spooled InboundMessages the way smtp-in's DATA seam does (apps/smtp-in/src/data.ts):
// the final blob, the spool row with its verdicts and resolved recipients, and the 'inbound' job,
// committed together.
import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@postroom/blobstore';
import { InboundState, type Db, type Prisma } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { INBOUND_QUEUE } from '../../src/pipeline.js';

export interface TestRecipient {
  rcpt: string;
  address: string;
  accountIds: string[];
  kind: 'mailbox' | 'alias' | 'plus' | 'masked' | 'service';
  tag?: string;
  siteTag?: string;
}

export const PASS_VERDICTS = {
  spf: { result: 'pass', domain: 'example.org', scope: 'mfrom', reasons: ['spf pass'] },
  dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', testing: false, reasons: ['body hash ok'] }],
  dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', sampled: true, reasons: ['aligned dkim pass'] },
  arc: { result: 'none', instances: 0, sealerDomains: [], temporary: false, reasons: [] },
  dnsbl: null,
  decision: { action: 'accept', rule: 'dmarc-pass', disposition: 'accept', reasons: ['DMARC pass'] },
};

export function plainMessage(opts: { from?: string; subject?: string; to?: string } = {}): Buffer {
  const subject = opts.subject ?? 'Hello';
  return Buffer.from(
    `Received: from mx.example.org by mx.d3cloud.io; Fri, 25 Sep 2026 12:00:00 +0000\r\n` +
      `From: Alice <${opts.from ?? 'alice@example.org'}>\r\n` +
      `To: ${opts.to ?? 'matt@d3cloud.io'}\r\n` +
      `Subject: ${subject}\r\n` +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${randomUUID()}@example.org>\r\n` +
      'References: <a@example.org> <b@example.org>\r\n' +
      'In-Reply-To: <b@example.org>\r\n' +
      '\r\n' +
      'hello\r\n',
    'utf8',
  );
}

export function messageWithAttachment(opts: { from: string; filename: string; contentType: string; data: Buffer }): Buffer {
  const boundary = `b-${randomUUID()}`;
  const b64 = opts.data.toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(
    `From: <${opts.from}>\r\n` +
      'To: matt@d3cloud.io\r\n' +
      'Subject: invoice\r\n' +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${randomUUID()}@example.org>\r\n` +
      'MIME-Version: 1.0\r\n' +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      '\r\n' +
      `--${boundary}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'see attached\r\n' +
      `--${boundary}\r\n` +
      `Content-Type: ${opts.contentType}\r\n` +
      `Content-Disposition: attachment; filename="${opts.filename}"\r\n` +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${b64}\r\n` +
      `--${boundary}--\r\n`,
    'latin1',
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export interface SpoolOptions {
  recipients: TestRecipient[];
  message?: Buffer;
  disposition?: 'accept' | 'quarantine';
  envelopeFrom?: string;
  verdicts?: Record<string, unknown>;
  maxAttempts?: number;
}

/** Spool one message exactly as smtp-in commits an accepted one. Returns the spool row id. */
export async function spool(db: Db, blobs: BlobStore, opts: SpoolOptions): Promise<{ id: string; sha256: string; jobId: string }> {
  const message = opts.message ?? plainMessage();
  const disposition = opts.disposition ?? 'accept';
  const id = randomUUID();
  return db.$transaction(async (tx) => {
    const blob = await blobs.put(message, { tx });
    await tx.inboundMessage.create({
      data: {
        id,
        envelopeFrom: opts.envelopeFrom ?? 'alice@example.org',
        recipients: json(opts.recipients),
        blobSha256: blob.sha256,
        size: blob.size,
        state: InboundState.spooled,
        verdicts: json(opts.verdicts ?? { ...PASS_VERDICTS, decision: { ...PASS_VERDICTS.decision, disposition } }),
        disposition,
        dispositionReason: disposition === 'quarantine' ? 'DMARC p=quarantine' : 'DMARC pass',
        smtpReply: `250 2.0.0 Queued as ${id}`,
      },
    });
    const job = await enqueue(tx, INBOUND_QUEUE, { inboundMessageId: id }, {
      idempotencyKey: `inbound:${id}`,
      ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    });
    if (job === null) throw new Error('job not enqueued');
    return { id, sha256: blob.sha256, jobId: job.id };
  });
}

/** A test clock: always at or after real time, so jobs enqueued "now" are due. */
export class Clock {
  offsetMs = 0;
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}
