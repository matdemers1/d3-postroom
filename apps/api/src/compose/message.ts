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
//   · Attachments (PST-T-15.10, PST-REQ-195, PST-ADR-013) make the message multipart/mixed: the body
//     part first, then each file in the order given, then — for a forward — the forwarded original
//     last. Each file is base64 in 76-column CRLF lines, encoded chunk by chunk as it streams from
//     its blob (never collected in memory), with an RFC 2231 filename (see attachmentHeaders).
import { Readable } from 'node:stream';
import { Base64Encoder, encodeQuotedPrintable, formatHeader, formatMailbox, generateBoundary, parseMailboxes, type Mailbox } from '@postroom/mime';
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

/** One file to attach: what the part is called, its type, and its bytes (opened when the part is written). */
export interface OutgoingAttachment {
  readonly filename: string;
  readonly contentType: string;
  /**
   * The file's plaintext bytes. Called once per build, when the builder reaches this part, so a
   * message built twice (the held blob and its Drafts copy) opens its own stream each time.
   */
  readonly open: () => Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;
}

const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * A browser-supplied Content-Type reduced to what a part may carry: `type/subtype`, lowercased,
 * parameters dropped. Anything else is application/octet-stream — and so are the composite types
 * (multipart/*, message/*), which RFC 2045 §6.4 forbids to be base64-encoded: an uploaded .eml
 * travels as an opaque file.
 */
export function sanitizeContentType(value: string | null | undefined): string {
  const head = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const slash = head.indexOf('/');
  if (slash <= 0) return 'application/octet-stream';
  const type = head.slice(0, slash);
  const subtype = head.slice(slash + 1);
  if (!MIME_TOKEN.test(type) || !MIME_TOKEN.test(subtype)) return 'application/octet-stream';
  if (type === 'multipart' || type === 'message') return 'application/octet-stream';
  return `${type}/${subtype}`;
}

/** The quoted-string fallback of a filename: each non-ASCII, control, quote or backslash character becomes `_`. */
export function asciiFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c > 0x7e || ch === '"' || ch === '\\' ? '_' : ch;
  }
  return out === '' ? 'attachment' : out;
}

// RFC 2231 §7 attribute-char: any token char except `*`, `'` and `%`. Everything else is %XX (UTF-8).
const ATTRIBUTE_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/** `name`'s UTF-8 bytes as RFC 2231 extended-value text (without the `utf-8''` prefix). */
export function rfc2231Encode(name: string): string {
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && ATTRIBUTE_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** An extended value split into sections of at most `max` characters, never inside a %XX escape. */
function sections(encoded: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < encoded.length) {
    let end = Math.min(encoded.length, i + max);
    // Back off so a section never ends in the middle of "%XX".
    const pct = encoded.lastIndexOf('%', end - 1);
    if (pct >= i && pct > end - 3 && end < encoded.length) end = pct;
    out.push(encoded.slice(i, end));
    i = end;
  }
  return out;
}

/** `Name: head; p1; p2`, each parameter on its own folded line when the whole would pass 78 characters. */
function paramHeader(name: string, head: string, params: readonly string[]): string {
  const one = [`${name}: ${head}`, ...params].join('; ');
  if (one.length <= LINE) return one;
  return [`${name}: ${head}`, ...params].join(';\r\n ');
}

/**
 * The header lines of one attachment part. The filename is always a quoted ASCII fallback
 * (`name=` on Content-Type for old clients, `filename=` on Content-Disposition); when the fallback
 * is not the name itself (non-ASCII, a quote or a backslash), the exact name follows as RFC 2231
 * `filename*=utf-8''…`, split into `filename*0*=`, `filename*1*=`… sections when it is long, so no
 * header line passes 78 characters on its account. A name that is plain printable ASCII has no
 * `filename*` form: the quoted one already says it exactly.
 */
export function attachmentHeaders(filename: string, contentType: string): string[] {
  const fallback = asciiFilename(filename);
  const disposition = [`filename="${fallback}"`];
  if (fallback !== filename) {
    const encoded = rfc2231Encode(filename);
    const single = `filename*=utf-8''${encoded}`;
    if (single.length + 1 <= LINE - 1) disposition.push(single);
    else sections(`utf-8''${encoded}`, 60).forEach((part, i) => disposition.push(`filename*${String(i)}*=${part}`));
  }
  return [
    paramHeader('Content-Type', sanitizeContentType(contentType), [`name="${fallback}"`]),
    paramHeader('Content-Disposition', 'attachment', disposition),
    'Content-Transfer-Encoding: base64',
  ];
}

function toBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  throw new TypeError('attachment sources must yield bytes');
}

/** One attachment part after its delimiter line: headers, blank line, base64 lines, closing CRLF. */
async function* attachmentPart(a: OutgoingAttachment): AsyncGenerator<Buffer> {
  yield Buffer.from(`${attachmentHeaders(a.filename, a.contentType).join('\r\n')}\r\n\r\n`, 'latin1');
  // Streamed: at most two input bytes and a line position are carried between chunks.
  const encoder = new Base64Encoder(76);
  for await (const chunk of await a.open()) {
    const b = toBytes(chunk);
    if (b.length === 0) continue;
    const text = encoder.write(b);
    if (text !== '') yield Buffer.from(text, 'latin1');
  }
  // The encoder emits no trailing CRLF; this one ends the last line (for an empty file it is the
  // CRLF that belongs to the delimiter after it, RFC 2046 §5.1.1, so the part is empty).
  yield Buffer.from(`${encoder.end()}\r\n`, 'latin1');
}

/**
 * The message as a stream. With `original`, a multipart/mixed whose last part is the original
 * message, byte for byte, as message/rfc822 (a forward). With `attachments`, multipart/mixed with
 * the body part first, then each file in order, then the forwarded original (if any). With neither,
 * exactly `buildTextMessage`. `boundary` is for tests.
 */
export function buildOutgoingStream(m: OutgoingMessage, original: Readable | null, boundary: string = generateBoundary(), attachments: readonly OutgoingAttachment[] = []): Readable {
  if (original === null && attachments.length === 0) return Readable.from([buildTextMessage(m)]);
  const content = bodyContent(m);
  const head = [...headerBlock(m), `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`].join('\r\n');
  const first = [`${head}\r\n`, `--${boundary}`, ...content.headerLines, '', content.body].join('\r\n');
  const attachHead = [`--${boundary}`, 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="forwarded-message.eml"', 'Content-Transfer-Encoding: 8bit', '', ''].join('\r\n');
  return Readable.from(
    (async function* compose(): AsyncGenerator<Buffer> {
      // part.body ends in CRLF, which is the CRLF that belongs to the delimiter line after it.
      yield Buffer.from(first, 'utf8');
      for (const a of attachments) {
        yield Buffer.from(`--${boundary}\r\n`, 'latin1');
        yield* attachmentPart(a);
      }
      if (original === null) {
        yield Buffer.from(`--${boundary}--\r\n`, 'latin1');
        return;
      }
      yield Buffer.from(attachHead, 'utf8');
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
