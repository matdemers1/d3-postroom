// Building the RFC 5322 message the webmail sends or saves (PST-T-3.11, PST-REQ-079). Pure except
// for the random boundary, so it is unit-tested byte for byte.
//
//   · Strict CRLF everywhere: the text the browser sends (LF, CRLF or CR) is normalised before it is
//     encoded, and every header line ends in CRLF.
//   · Non-ASCII header text is RFC 2047 encoded-words (UTF-8); display names in address headers
//     likewise, never the addresses. Long header values fold at whitespace.
//   · The body is text/plain; charset=utf-8: 7bit when it is ASCII with short lines, otherwise
//     quoted-printable.
//   · A forward attaches the original, unchanged, as a message/rfc822 part (streamed from its blob,
//     never buffered): headers, HTML and attachments all travel with it. The composer's own text
//     (which the prefill starts with an inline quote of the original) is the first part.
import { Readable } from 'node:stream';
import { encodeQuotedPrintable, formatHeader, formatMailbox, generateBoundary, parseMailboxes, type Mailbox } from '@postroom/mime';
import { formatRfc5322Date, parseAddressList } from '@postroom/submission';

const LINE = 78;

export interface OutgoingMessage {
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  /** Written only when `includeBcc` (a draft keeps its Bcc; a sent message never carries one). */
  readonly bcc: readonly Mailbox[];
  readonly includeBcc?: boolean;
  readonly subject: string;
  readonly text: string;
  /**
   * Sanitized HTML rendered from `text` (PST-T-9.2, PST-REQ-145). When present the body is sent as
   * multipart/alternative — `text` as text/plain, this as text/html — instead of a single text/plain
   * part; `text` is always what the account actually typed (the Markdown source), never dropped.
   */
  readonly html?: string | null;
  /** Bracketed msg-ids. */
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: Date;
  /** Extra header fields (ASCII names), e.g. the draft's X-Postroom-Draft-* metadata. */
  readonly extraHeaders?: readonly (readonly [string, string])[];
}

/** A msg-id as the header wants it: `<id>`. Accepts it with or without brackets; null when it is not one. */
export function bracketMsgId(value: string): string | null {
  const t = value.trim();
  const inner = t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
  if (inner === '' || inner.length > 900 || !/^[\x21-\x7e]+$/.test(inner) || /[<>]/.test(inner)) return null;
  return `<${inner}>`;
}

/** Is `address` something we may put on an envelope: `local@domain`, no whitespace or controls, no literal. */
export function isDeliverableAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1 || address.length > 320) return false;
  const domain = address.slice(at + 1);
  if (domain.startsWith('[')) return false; // PST-REQ-053's sibling: no address-literal recipients
  // eslint-disable-next-line no-control-regex
  if (!/^[^\s\x00-\x1f\x7f<>(),;:"\\]+$/.test(domain) || !domain.includes('.')) return false;
  const local = address.slice(0, at);
  // eslint-disable-next-line no-control-regex
  return !/[\s\x00-\x1f\x7f]/.test(local);
}

export type RecipientParse = { readonly ok: true; readonly mailboxes: Mailbox[] } | { readonly ok: false; readonly entry: string };

/**
 * Address-field entries as the composer sends them (each may itself be a comma-separated list):
 * parsed leniently, then each mailbox re-formatted and re-parsed with submission's strict parser so
 * what goes in the header is exactly what the envelope names.
 */
export function parseRecipients(entries: readonly string[]): RecipientParse {
  const out: Mailbox[] = [];
  for (const entry of entries) {
    if (entry.trim() === '') continue;
    const found = parseMailboxes(entry);
    if (found.length === 0) return { ok: false, entry };
    for (const m of found) {
      if (!isDeliverableAddress(m.address)) return { ok: false, entry };
      const strict = parseAddressList(formatMailbox(m));
      if (strict?.length !== 1 || strict[0] !== m.address) return { ok: false, entry };
      out.push(m);
    }
  }
  return { ok: true, mailboxes: out };
}

/** `Name: a, b, c`, folded between entries so lines stay near 78 characters. */
export function addressHeader(name: string, mailboxes: readonly Mailbox[]): string {
  const items = mailboxes.map(formatMailbox);
  let out = `${name}:`;
  let lineLen = out.length;
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item},` : item;
    if (lineLen + 1 + piece.length > LINE && i > 0) {
      out += `\r\n ${piece}`;
      lineLen = 1 + piece.length;
    } else {
      out += ` ${piece}`;
      lineLen += 1 + piece.length;
    }
  });
  return out;
}

/** `References: <a> <b>`, folded between ids. */
export function msgIdListHeader(name: string, ids: readonly string[]): string {
  let out = `${name}:`;
  let lineLen = out.length;
  ids.forEach((id, i) => {
    if (lineLen + 1 + id.length > LINE && i > 0) {
      out += `\r\n ${id}`;
      lineLen = 1 + id.length;
    } else {
      out += ` ${id}`;
      lineLen += 1 + id.length;
    }
  });
  return out;
}

/** Every line break → CRLF; always ends with exactly one CRLF (an empty text is just CRLF). */
export function toCrlf(text: string): string {
  const body = text.replace(/\r\n|\r|\n/g, '\r\n');
  return body.endsWith('\r\n') ? body : `${body}\r\n`;
}

/** 7bit when the text is ASCII with lines of at most 998 octets; quoted-printable otherwise. */
export function textPart(text: string): { encoding: '7bit' | 'quoted-printable'; body: string } {
  const crlf = toCrlf(text);
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x09\x0d\x0a\x20-\x7e]*$/.test(crlf);
  const short = crlf.split('\r\n').every((line) => line.length <= 998);
  if (ascii && short) return { encoding: '7bit', body: crlf };
  const qp = encodeQuotedPrintable(Buffer.from(crlf, 'utf8'), { binary: false });
  return { encoding: 'quoted-printable', body: qp.endsWith('\r\n') ? qp : `${qp}\r\n` };
}

/**
 * The message's main content: either a single text/plain part, or (when `html` is set) a
 * multipart/alternative of exactly two parts — text/plain with the Markdown source, text/html with
 * the sanitized rendering — in that order, plain first (RFC 2046 §5.1.4: alternatives are ordered
 * from least to most preferred rendering). Returns the header lines the caller places after the
 * message headers, and the body bytes that follow the blank line.
 */
function bodyContent(m: OutgoingMessage): { headerLines: string[]; body: string } {
  const plain = textPart(m.text);
  if (m.html === undefined || m.html === null) {
    return { headerLines: ['Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${plain.encoding}`], body: plain.body };
  }
  const html = textPart(m.html);
  const boundary = generateBoundary();
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${plain.encoding}`,
    '',
    plain.body,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    `Content-Transfer-Encoding: ${html.encoding}`,
    '',
    html.body,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { headerLines: [`Content-Type: multipart/alternative;\r\n boundary="${boundary}"`], body };
}

function headerBlock(m: OutgoingMessage): string[] {
  const lines = [addressHeader('From', [m.from])];
  if (m.to.length > 0) lines.push(addressHeader('To', m.to));
  if (m.cc.length > 0) lines.push(addressHeader('Cc', m.cc));
  if (m.includeBcc === true && m.bcc.length > 0) lines.push(addressHeader('Bcc', m.bcc));
  lines.push(m.subject === '' ? 'Subject:' : formatHeader('Subject', m.subject));
  lines.push(`Date: ${formatRfc5322Date(m.date)}`, `Message-ID: ${m.messageId}`);
  if (m.inReplyTo !== null) lines.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references.length > 0) lines.push(msgIdListHeader('References', m.references));
  for (const [name, value] of m.extraHeaders ?? []) lines.push(formatHeader(name, value));
  lines.push('MIME-Version: 1.0');
  return lines;
}

/** A text-only (or, with `html` set, multipart/alternative) message: a reply, a new message, a draft. */
export function buildTextMessage(m: OutgoingMessage): Buffer {
  const content = bodyContent(m);
  const lines = [...headerBlock(m), ...content.headerLines];
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${content.body}`, 'utf8');
}

/**
 * The message as a stream. With `original`, a multipart/mixed whose second part is the original
 * message, byte for byte, as message/rfc822 (a forward). `boundary` is for tests.
 */
export function buildOutgoingStream(m: OutgoingMessage, original: Readable | null, boundary: string = generateBoundary()): Readable {
  if (original === null) return Readable.from([buildTextMessage(m)]);
  const content = bodyContent(m);
  const head = [...headerBlock(m), `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`].join('\r\n');
  const first = [`${head}\r\n`, `--${boundary}`, ...content.headerLines, '', content.body].join('\r\n');
  const attachHead = [`--${boundary}`, 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="forwarded-message.eml"', 'Content-Transfer-Encoding: 8bit', '', ''].join('\r\n');
  return Readable.from(
    (async function* forward(): AsyncGenerator<Buffer> {
      // part.body ends in CRLF, which is the CRLF that belongs to the delimiter line after it.
      yield Buffer.from(`${first}${attachHead}`, 'utf8');
      // The last two bytes seen, however the chunks were cut.
      let tail = Buffer.alloc(0);
      for await (const chunk of original) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (b.length === 0) continue;
        tail = Buffer.concat([tail, b.subarray(Math.max(0, b.length - 2))]).subarray(-2);
        yield b;
      }
      const endsCrlf = tail.length === 2 && tail[0] === 0x0d && tail[1] === 0x0a;
      yield Buffer.from(`${endsCrlf ? '' : '\r\n'}\r\n--${boundary}--\r\n`, 'utf8');
    })(),
  );
}
