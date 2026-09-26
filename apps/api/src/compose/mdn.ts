// RFC 8098 Message Disposition Notifications (PST-T-9.2, PST-REQ-146): a multipart/report;
// report-type=disposition-notification with a human-readable part and a machine-readable
// message/disposition-notification part. Pure: building the bytes never touches the database or the
// network, so it is unit-tested by parsing the result back with @postroom/mime. Built by hand (not
// through @postroom/mime's generic buildMessage) because multipart/report needs a report-type
// Content-Type parameter that writer's MultipartSpec has no slot for.
import { formatHeader, formatMailbox, generateBoundary, type Mailbox } from '@postroom/mime';
import { formatRfc5322Date } from '@postroom/submission';

export interface MdnInput {
  readonly from: Mailbox;
  readonly to: Mailbox;
  readonly subject: string;
  /** The Message-ID (bracketed, e.g. `<id@host>`) of the message this reports on. */
  readonly originalMessageId: string;
  /** The address the notification is Final-Recipient for (the account's own address). */
  readonly finalRecipient: string;
  readonly reportingUa: string;
  readonly date: Date;
  /** This MDN's own Message-ID (bracketed). */
  readonly messageId: string;
}

const CRLF = '\r\n';

/**
 * Build an RFC 8098 MDN: `Content-Type: multipart/report; report-type=disposition-notification`
 * with a human-readable text/plain part and a machine-readable message/disposition-notification
 * part. `Disposition: manual-action/MDN-sent-manually; displayed` — the person chose to send it from
 * the read-receipt prompt, which is the only disposition Postroom ever reports.
 */
export function buildMdn(input: MdnInput): Buffer {
  const boundary = generateBoundary();
  const subjectLine = input.subject === '' ? 'Read receipt' : `Read: ${input.subject}`;

  const headers = [
    `From: ${formatMailbox(input.from)}`,
    `To: ${formatMailbox(input.to)}`,
    formatHeader('Subject', subjectLine),
    `Date: ${formatRfc5322Date(input.date)}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report;\r\n report-type=disposition-notification;\r\n boundary="${boundary}"`,
  ].join(CRLF);

  const human = [
    'This is a Message Disposition Notification.',
    '',
    `Your message${input.subject === '' ? '' : ` "${input.subject}"`} was displayed.`,
    '',
    'This notification only confirms that the message was displayed; there is no guarantee that',
    'the content has been read or understood.',
    '',
  ].join(CRLF);

  const machine = [
    `Reporting-UA: ${input.reportingUa}`,
    `Final-Recipient: rfc822; ${input.finalRecipient}`,
    `Original-Message-ID: ${input.originalMessageId}`,
    'Disposition: manual-action/MDN-sent-manually; displayed',
    '',
  ].join(CRLF);

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    human,
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    'Content-Transfer-Encoding: 7bit',
    '',
    machine,
    `--${boundary}--`,
    '',
  ].join(CRLF);

  return Buffer.from(`${headers}${CRLF}${CRLF}${body}`, 'utf8');
}
