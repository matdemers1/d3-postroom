// RFC 3464 delivery status notifications, built as one multipart/report message (RFC 6522):
// a human-readable text/plain part, a machine-readable message/delivery-status part, and either
// the original message's headers (text/rfc822-headers, RET=HDRS) or the whole original
// (message/rfc822, RET=FULL — the caller decides that and hands the right buffer in).
//
// Every value that came from the outside world (an address, a diagnostic string) is sanitized
// before it reaches a header line: CR/LF is stripped so a DSN can never smuggle extra headers or
// extra parts (PST-REQ-049's smuggling concern applies here too, just with us as the sender).

import { randomBytes } from 'node:crypto';

export type DsnKind = 'delay' | 'failure';

/** One recipient's line in the machine-readable per-message report (RFC 3464 §2.3). */
export interface DsnRecipientReport {
  /** RFC 822 address, as `Final-Recipient: rfc822; <addr>`. */
  readonly finalRecipient: string;
  readonly action: 'delayed' | 'failed';
  /** An RFC 3463 enhanced status code, e.g. '4.3.0' or '5.1.1'. */
  readonly status: string;
  /** The remote MTA that gave the diagnostic, if any: `Remote-MTA: dns; <host>`. */
  readonly remoteMta?: string;
  /** Already formed as `smtp; 550 5.1.1 ...` (or `x-postroom; ...` when there was no SMTP reply). */
  readonly diagnosticCode?: string;
  readonly lastAttemptDate: Date;
  /** Delay reports only: when we stop retrying. */
  readonly willRetryUntil?: Date;
}

export interface BuildDsnInput {
  readonly kind: DsnKind;
  /** `Reporting-MTA: dns; <reportingMta>`. */
  readonly reportingMta: string;
  readonly arrivalDate: Date;
  /** RFC 3461 ENVID, echoed as `Original-Envelope-Id`. */
  readonly originalEnvelopeId?: string;
  /** Either just the original's header block, or the whole original — see `originalIsFullMessage`. */
  readonly originalMessageHeaders: Buffer;
  /** True when `originalMessageHeaders` is the entire original message (RET=FULL, under the cap). */
  readonly originalIsFullMessage?: boolean;
  readonly recipients: readonly DsnRecipientReport[];
  /** `From:` — always the postmaster, never a real mailbox, so a reply-to-DSN goes nowhere useful. */
  readonly from: string;
  /** `To:` — the original sender, so the DSN files into a real INBOX. */
  readonly to: string;
  readonly date: Date;
  /** Used to build `Message-ID: <messageId>`. */
  readonly messageId: string;
}

const CRLF = '\r\n';
const MAX_LINE = 78;

/** Strips CR/LF so a value can never inject an extra header or split into another MIME part. */
function sanitizeHeaderValue(value: string): string {
  return value.replaceAll(/[\r\n]+/g, ' ').trim();
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** Like isAscii, but for body text that still has its `\n` line endings (converted to CRLF later). */
function isAsciiText(value: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(value);
}

/** RFC 2047 encoded-word, only when needed: plain ASCII passes through unchanged. */
function encodeHeaderWord(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (isAscii(sanitized)) return sanitized;
  const b64 = Buffer.from(sanitized, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Folds `name: value` so no line exceeds MAX_LINE (RFC 5322 §2.2.3): greedily fills each line,
 * breaking at the last space within budget when there is one, and hard-breaking otherwise — a
 * value with no spaces at all (a long hostname) still folds rather than producing one long line.
 */
function foldHeader(name: string, value: string): string {
  const first = `${name}: `;
  if (first.length + value.length <= MAX_LINE) return first + value;
  const lines: string[] = [];
  let rest = value;
  let prefix = first;
  for (;;) {
    const budget = MAX_LINE - prefix.length;
    if (rest.length <= budget) {
      lines.push(prefix + rest);
      break;
    }
    const spaceAt = rest.lastIndexOf(' ', budget);
    const breakAt = spaceAt > 0 ? spaceAt : Math.max(budget, 1);
    lines.push(prefix + rest.slice(0, breakAt));
    rest = rest.slice(breakAt).trimStart();
    prefix = ' ';
  }
  return lines.join(CRLF);
}

/** RFC 5322 date-time in a fixed +0000 offset: every Postroom clock is UTC. */
function formatRfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const day = days[date.getUTCDay()] ?? 'Thu';
  const month = months[date.getUTCMonth()] ?? 'Jan';
  return `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function newBoundary(): string {
  return `postroom-dsn-${randomBytes(12).toString('hex')}`;
}

function humanText(kind: DsnKind, reportingMta: string, recipients: readonly DsnRecipientReport[]): string {
  const lines: string[] = [];
  if (kind === 'delay') {
    lines.push(`This is the mail system at host ${sanitizeHeaderValue(reportingMta)}.`);
    lines.push('');
    lines.push("Your message has not yet been delivered to one or more recipients. We'll");
    lines.push('keep trying; you will get a further notice if delivery still fails, or if');
    lines.push('the message is delivered.');
  } else {
    lines.push(`This is the mail system at host ${sanitizeHeaderValue(reportingMta)}.`);
    lines.push('');
    lines.push("I'm sorry to have to inform you that your message could not be delivered");
    lines.push('to one or more recipients. It is attached below.');
  }
  lines.push('');
  for (const r of recipients) {
    const diag = r.diagnosticCode !== undefined ? sanitizeHeaderValue(r.diagnosticCode) : r.status;
    const verb = kind === 'delay' ? 'is delayed' : 'could not be delivered';
    lines.push(`  ${sanitizeHeaderValue(r.finalRecipient)}: ${verb} - ${diag}`);
  }
  return lines.join('\n');
}

/** Only base64 is unconditionally 7-bit-safe without a line-ending-aware transform; used whenever the text is non-ASCII. */
function encodeTextPart(text: string): { body: string; encoding: '7bit' | 'base64' } {
  if (isAsciiText(text)) return { body: text.split('\n').join(CRLF), encoding: '7bit' };
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const wrapped = (b64.match(/.{1,76}/g) ?? []).join(CRLF);
  return { body: wrapped, encoding: 'base64' };
}

function deliveryStatusPart(input: BuildDsnInput): string {
  const lines: string[] = [];
  lines.push(foldHeader('Reporting-MTA', `dns; ${sanitizeHeaderValue(input.reportingMta)}`));
  if (input.originalEnvelopeId !== undefined) {
    lines.push(foldHeader('Original-Envelope-Id', sanitizeHeaderValue(input.originalEnvelopeId)));
  }
  lines.push(foldHeader('Arrival-Date', formatRfc5322Date(input.arrivalDate)));
  for (const r of input.recipients) {
    lines.push('');
    lines.push(foldHeader('Final-Recipient', `rfc822; ${sanitizeHeaderValue(r.finalRecipient)}`));
    lines.push(foldHeader('Action', r.action));
    lines.push(foldHeader('Status', sanitizeHeaderValue(r.status)));
    if (r.remoteMta !== undefined) lines.push(foldHeader('Remote-MTA', `dns; ${sanitizeHeaderValue(r.remoteMta)}`));
    if (r.diagnosticCode !== undefined) lines.push(foldHeader('Diagnostic-Code', sanitizeHeaderValue(r.diagnosticCode)));
    lines.push(foldHeader('Last-Attempt-Date', formatRfc5322Date(r.lastAttemptDate)));
    if (r.willRetryUntil !== undefined) lines.push(foldHeader('Will-Retry-Until', formatRfc5322Date(r.willRetryUntil)));
  }
  return lines.join(CRLF);
}

/** Builds an RFC 3464 delay or failure report as a full RFC 5322 message, CRLF throughout. */
export function buildDsn(input: BuildDsnInput): Buffer {
  const boundary = newBoundary();
  const subject = input.kind === 'delay' ? 'Delivery delayed' : 'Delivery Status Notification (Failure)';

  const headers: string[] = [
    foldHeader('From', sanitizeHeaderValue(input.from)),
    foldHeader('To', sanitizeHeaderValue(input.to)),
    foldHeader('Subject', encodeHeaderWord(subject)),
    foldHeader('Date', formatRfc5322Date(input.date)),
    foldHeader('Message-ID', `<${sanitizeHeaderValue(input.messageId)}>`),
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=delivery-status;${CRLF}\tboundary="${boundary}"`,
  ];

  const text = encodeTextPart(humanText(input.kind, input.reportingMta, input.recipients));
  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${text.encoding}`,
    '',
    text.body,
  ].join(CRLF);

  const statusPart = [
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    deliveryStatusPart(input),
  ].join(CRLF);

  const originalContentType = input.originalIsFullMessage === true ? 'message/rfc822' : 'text/rfc822-headers';
  const originalHeaders = input.originalMessageHeaders.toString('binary').replaceAll(/\r\n|\r|\n/g, CRLF);
  const originalPart = [
    `--${boundary}`,
    `Content-Type: ${originalContentType}`,
    '',
    originalHeaders,
  ].join(CRLF);

  const body = [headers.join(CRLF), '', textPart, statusPart, originalPart, `--${boundary}--`, ''].join(CRLF);
  return Buffer.from(body, 'binary');
}
