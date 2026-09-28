// Readers for the machine-readable part of a multipart/report (RFC 6522) that comes back to us
// (PST-T-11.15, PST-REQ-176): a remote MTA's delivery status notification (RFC 3464
// message/delivery-status, or RFC 6533 message/global-delivery-status) and an abuse feedback
// report (RFC 5965 message/feedback-report, "ARF").
//
// Both bodies are header-field shaped: `Name: value` lines with folding. A DSN is one block of
// per-message fields followed by one block per recipient, blocks separated by an empty line; an ARF
// report is a single block. Everything here is input from the outside world, so the readers are
// total — any bytes give a result, never an exception — and bounded: the text is cut at
// MAX_REPORT_BYTES, at most MAX_RECIPIENTS recipient blocks and MAX_FIELDS fields per block are
// read, and every kept value is cut at MAX_VALUE_CHARS. A value that does not have the shape its
// RFC gives it (a Status that is not an x.y.z code, a Feedback-Type that is not a token) is null
// rather than guessed at: the caller decides on these values (bounce a recipient, suppress an
// address), and a guess is not something to decide on.

/** The most of a report body that is read. A real DSN status part is a few hundred bytes. */
export const MAX_REPORT_BYTES = 64 * 1024;
/** Recipient blocks read from one DSN. */
export const MAX_RECIPIENTS = 100;
/** Fields read from one block. */
export const MAX_FIELDS = 64;
/** Any one kept value is cut to this many characters. */
export const MAX_VALUE_CHARS = 998;
/** Original-Rcpt-To / Reported-Domain values kept from one ARF report. */
const MAX_LIST = 20;

interface Field {
  readonly name: string;
  readonly value: string;
}

/** An RFC 3463 enhanced status code at the start of a value: class.subject.detail. */
const STATUS = /^([245])\.(\d{1,3})\.(\d{1,3})(?![\d.])/;
/** An RFC 5321 reply code at the start of a diagnostic, followed by a space, a dash or the end. */
const SMTP_CODE = /^([245]\d\d)(?:[\s-]|$)/;
/** An RFC 5965 Feedback-Type / RFC 3464 Action: an RFC 2045 token, in practice letters, digits, dashes. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function cut(value: string): string {
  return value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value;
}

function toText(input: string | Uint8Array): string {
  if (typeof input === 'string') return input.length > MAX_REPORT_BYTES ? input.slice(0, MAX_REPORT_BYTES) : input;
  const bytes = input.length > MAX_REPORT_BYTES ? input.subarray(0, MAX_REPORT_BYTES) : input;
  // UTF-8 (RFC 6533 allows it in message/global-delivery-status); invalid bytes become U+FFFD.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/**
 * The blocks of fields, in order. A block ends at an empty (or all-whitespace) line; a line
 * starting with space or tab continues the previous field; a line with no colon is skipped (a
 * stray line of prose must not end or corrupt the block around it). Empty blocks are dropped.
 */
function readBlocks(text: string, maxBlocks: number): Field[][] {
  const blocks: Field[][] = [];
  let block: Field[] = [];
  let name: string | null = null;
  let value = '';
  const endField = (): void => {
    if (name !== null && block.length < MAX_FIELDS) block.push({ name, value: cut(value.replace(/\s+/g, ' ').trim()) });
    name = null;
    value = '';
  };
  const endBlock = (): void => {
    endField();
    if (block.length > 0) blocks.push(block);
    block = [];
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (blocks.length >= maxBlocks) break;
    if (line.trim() === '') {
      endBlock();
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && name !== null) {
      // Bounded: a folded value never grows past what `cut` keeps, plus one line.
      if (value.length <= MAX_VALUE_CHARS) value += ` ${line.trim()}`;
      continue;
    }
    endField();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const n = line.slice(0, colon).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(n)) continue;
    name = n;
    value = line.slice(colon + 1);
  }
  if (blocks.length < maxBlocks) endBlock();
  return blocks;
}

function first(block: readonly Field[], name: string): string | null {
  const f = block.find((x) => x.name === name);
  return f === undefined || f.value === '' ? null : f.value;
}

function all(block: readonly Field[], name: string): string[] {
  return block.filter((x) => x.name === name && x.value !== '').map((x) => x.value);
}

/** `type; value` (Final-Recipient, Reporting-MTA, Diagnostic-Code, …): the type lowercased. */
export interface TypedValue {
  readonly type: string;
  readonly value: string;
}

function typed(value: string | null): TypedValue | null {
  if (value === null) return null;
  const semi = value.indexOf(';');
  if (semi < 0) return { type: '', value: value.trim() };
  return { type: value.slice(0, semi).trim().toLowerCase(), value: value.slice(semi + 1).trim() };
}

/** The value half of a `type; value` field, or null when it is empty. */
function typedValue(value: string | null): string | null {
  const t = typed(value);
  return t === null || t.value === '' ? null : t.value;
}

/** An address as it appears in a DSN or ARF field: angle brackets and surrounding space stripped. */
function bareAddress(value: string): string | null {
  let v = value.trim();
  const lt = v.lastIndexOf('<');
  const gt = v.lastIndexOf('>');
  if (lt >= 0 && gt > lt) v = v.slice(lt + 1, gt).trim();
  if (v === '' || /\s/.test(v) || v.length > 320) return null;
  return v;
}

function addressOf(value: string | null): string | null {
  const t = typed(value);
  return t === null ? null : bareAddress(t.value);
}

/** The x.y.z code at the start of a Status value, or null. */
export function statusCode(value: string | null): string | null {
  if (value === null) return null;
  const m = STATUS.exec(value.trim());
  return m === null ? null : `${m[1] ?? ''}.${String(Number(m[2]))}.${String(Number(m[3]))}`;
}

/** The SMTP reply code at the start of a diagnostic's text (`550 5.1.1 …` → 550), or null. */
export function smtpCodeOf(text: string | null): number | null {
  if (text === null) return null;
  const m = SMTP_CODE.exec(text.trim());
  return m === null ? null : Number(m[1]);
}

/** RFC 3461 §4 xtext: `+XX` is the byte XX. Anything malformed is left as written. */
export function decodeXtext(value: string): string {
  return value.replace(/\+([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export interface DsnRecipientStatus {
  /** Final-Recipient's address (the type is in `finalRecipientType`), or null when absent or malformed. */
  readonly finalRecipient: string | null;
  readonly finalRecipientType: string | null;
  readonly originalRecipient: string | null;
  /** failed | delayed | delivered | relayed | expanded (lowercased), or null. */
  readonly action: string | null;
  /** The enhanced status, normalised (`5.1.1`), or null when absent or not a code. */
  readonly status: string | null;
  /** The remote MTA's name (`dns; mx.example.org` → `mx.example.org`). */
  readonly remoteMta: string | null;
  /** Diagnostic-Code's type (`smtp`, `x-unix`, …) and its text. */
  readonly diagnosticType: string | null;
  readonly diagnostic: string | null;
  /** The reply code at the start of an `smtp;` diagnostic, or null. */
  readonly smtpCode: number | null;
  readonly lastAttemptDate: string | null;
}

export interface DeliveryStatusReport {
  /** Original-Envelope-Id as written (RFC 3461 ENVID, xtext). */
  readonly originalEnvelopeId: string | null;
  readonly reportingMta: string | null;
  readonly arrivalDate: string | null;
  readonly recipients: readonly DsnRecipientStatus[];
  /** Recipient blocks beyond MAX_RECIPIENTS were not read. */
  readonly truncated: boolean;
}

function recipientOf(block: readonly Field[]): DsnRecipientStatus {
  const final = typed(first(block, 'final-recipient'));
  const diag = typed(first(block, 'diagnostic-code'));
  const actionRaw = first(block, 'action');
  const action = actionRaw === null ? null : (actionRaw.split(/[\s(]/)[0] ?? '').toLowerCase();
  const diagnostic = diag === null || diag.value === '' ? null : diag.value;
  return {
    finalRecipient: final === null ? null : bareAddress(final.value),
    finalRecipientType: final === null || final.type === '' ? null : final.type,
    originalRecipient: addressOf(first(block, 'original-recipient')),
    action: action !== null && TOKEN.test(action) ? action : null,
    status: statusCode(first(block, 'status')),
    remoteMta: typedValue(first(block, 'remote-mta')),
    diagnosticType: diag === null || diag.type === '' ? null : diag.type,
    diagnostic,
    smtpCode: diag !== null && (diag.type === 'smtp' || diag.type === '') ? smtpCodeOf(diagnostic) : null,
    lastAttemptDate: first(block, 'last-attempt-date'),
  };
}

/**
 * Read an RFC 3464 message/delivery-status body. Total: any input gives a report (possibly with no
 * recipients). A block counts as a recipient block when it names a recipient or an action; the
 * first block that does neither is the per-message block.
 */
export function parseDeliveryStatus(input: string | Uint8Array): DeliveryStatusReport {
  const blocks = readBlocks(toText(input), MAX_RECIPIENTS + 2);
  let perMessage: readonly Field[] = [];
  const recipients: DsnRecipientStatus[] = [];
  let truncated = false;
  for (const [i, block] of blocks.entries()) {
    const isRecipient = first(block, 'final-recipient') !== null || first(block, 'action') !== null;
    if (!isRecipient) {
      if (i === 0) perMessage = block;
      continue;
    }
    if (recipients.length >= MAX_RECIPIENTS) {
      truncated = true;
      break;
    }
    recipients.push(recipientOf(block));
  }
  return {
    originalEnvelopeId: first(perMessage, 'original-envelope-id'),
    reportingMta: typedValue(first(perMessage, 'reporting-mta')),
    arrivalDate: first(perMessage, 'arrival-date'),
    recipients,
    truncated,
  };
}

export interface FeedbackReport {
  /** RFC 5965 §3.5 / RFC 6650: abuse, fraud, auth-failure, not-spam, other, virus (lowercased), or null. */
  readonly feedbackType: string | null;
  readonly userAgent: string | null;
  readonly version: string | null;
  readonly originalMailFrom: string | null;
  readonly originalRcptTo: readonly string[];
  readonly originalEnvelopeId: string | null;
  readonly arrivalDate: string | null;
  readonly reportingMta: string | null;
  readonly sourceIp: string | null;
  /** Incidents, when it is a whole number. */
  readonly incidents: number | null;
  readonly reportedDomain: readonly string[];
}

/** Read an RFC 5965 message/feedback-report body. Total, like parseDeliveryStatus. */
export function parseFeedbackReport(input: string | Uint8Array): FeedbackReport {
  const block = readBlocks(toText(input), 1)[0] ?? [];
  const typeRaw = first(block, 'feedback-type');
  const feedbackType = typeRaw === null ? null : typeRaw.toLowerCase();
  const incidentsRaw = first(block, 'incidents');
  const incidents = incidentsRaw !== null && /^\d{1,9}$/.test(incidentsRaw) ? Number(incidentsRaw) : null;
  const mailFrom = first(block, 'original-mail-from');
  return {
    feedbackType: feedbackType !== null && TOKEN.test(feedbackType) ? feedbackType : null,
    userAgent: first(block, 'user-agent'),
    version: first(block, 'version'),
    originalMailFrom: mailFrom === null ? null : bareAddress(mailFrom),
    originalRcptTo: all(block, 'original-rcpt-to')
      .map(bareAddress)
      .filter((a): a is string => a !== null)
      .slice(0, MAX_LIST),
    originalEnvelopeId: first(block, 'original-envelope-id'),
    arrivalDate: first(block, 'arrival-date') ?? first(block, 'received-date'),
    reportingMta: typedValue(first(block, 'reporting-mta')),
    sourceIp: first(block, 'source-ip'),
    incidents,
    reportedDomain: all(block, 'reported-domain').slice(0, MAX_LIST),
  };
}

/** The MIME types of the machine-readable part of a DSN (RFC 3464, RFC 6533). */
export const DELIVERY_STATUS_TYPES: readonly string[] = ['message/delivery-status', 'message/global-delivery-status'];
/** The MIME type of the machine-readable part of an ARF report (RFC 5965). */
export const FEEDBACK_REPORT_TYPE = 'message/feedback-report';
