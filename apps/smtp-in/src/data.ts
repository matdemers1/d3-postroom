// The DATA seam. PST-T-2.6 owns this file and replaces the body with storage (blob + fsync + commit
// before 250, PST-REQ-060), DMARC and delivery to the recipients' mailboxes. Until then the body is
// drained (so the DKIM verifier sees all of it) and the message is refused with a temporary error:
// nothing is accepted that is not stored.
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { DkimResult, EvaluateSpfResult } from '@postroom/auth-checks';
import { reply, type SmtpReply } from '@postroom/smtp-proto';
import type { RecipientAccepted } from './recipients.js';

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
}

export type AcceptMessage = (ctx: InboundContext, body: Readable, verdicts: InboundVerdicts) => Promise<SmtpReply>;

export const STORAGE_PENDING = reply(451, '4.3.0', 'inbound storage arrives in PST-T-2.6');

export async function acceptMessage(_ctx: InboundContext, body: Readable, _verdicts: InboundVerdicts): Promise<SmtpReply> {
  await finished(body.resume());
  return STORAGE_PENDING;
}
