// The RFC 6047 REPLY message: multipart/alternative, a short text/plain first, then the
// `text/calendar; method=REPLY; charset=UTF-8` part carrying the RFC 5546 VCALENDAR — sent through
// the same accept path the composer uses (PST-T-8.4, PST-REQ-134). Pure except for the random
// boundary and message-id, so it is unit-tested byte for byte.
import { Readable } from 'node:stream';
import { formatHeader, generateBoundary, type Mailbox } from '@postroom/mime';
import { formatRfc5322Date } from '@postroom/submission';
import { addressHeader, textPart, toCrlf } from '../compose/message.js';

export interface ReplyMessageInput {
  readonly from: Mailbox;
  readonly to: Mailbox;
  readonly subject: string;
  readonly text: string;
  readonly ics: string;
  readonly messageId: string;
  readonly date: Date;
}

/** The REPLY as a full RFC 5322 message, bytes ready to submit. `boundary` is for tests. */
export function buildReplyMessage(m: ReplyMessageInput, boundary: string = generateBoundary()): Buffer {
  const headers = [
    addressHeader('From', [m.from]),
    addressHeader('To', [m.to]),
    formatHeader('Subject', m.subject),
    `Date: ${formatRfc5322Date(m.date)}`,
    `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative;\r\n boundary="${boundary}"`,
  ].join('\r\n');
  const text = textPart(m.text);
  const ics = toCrlf(m.ics);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${text.encoding}`,
    '',
    text.body,
    `--${boundary}`,
    'Content-Type: text/calendar; method=REPLY; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    ics,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8');
}

/** `buildReplyMessage`'s output as a stream, for `acceptSubmission`. */
export function buildReplyStream(m: ReplyMessageInput, boundary?: string): Readable {
  return Readable.from([buildReplyMessage(m, boundary)]);
}

/** `Name <a@b>` for a plain address with no display name. */
export function mailboxOf(address: string, name = ''): Mailbox {
  return { name, address };
}
