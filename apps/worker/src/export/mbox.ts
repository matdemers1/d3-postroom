// mboxrd composition for the full-data export (PST-T-10.1, PST-REQ-151): one folder's messages,
// concatenated with a "From " envelope line ahead of each, in the dialect Thunderbird and the
// Apple Mail importer expect.
//
//   - Every message is preceded by `From <envelope-sender> <asctime-date>\n` (mboxrd, RFC-ish; no
//     trailing "remote from <host>").
//   - The raw message is RFC 5322 with CRLF line endings; mbox is a Unix format, so CRLF -> LF.
//   - mboxrd quoting: any content line that would otherwise look like a "From " line — one that
//     matches `/^>*From /` — gets one more '>' prepended. Unquoting (for the round-trip test) drops
//     exactly one '>' from a line matching `/^>+From /`. This is reversible without touching a line
//     that never looked like "From " in the first place.
//   - Each entry ends with a blank line, so mbox readers (and this module's own parser) never mistake
//     two adjacent messages for one.
import type { Readable } from 'node:stream';

/** `Www Mmm d hh:mm:ss yyyy` — C's asctime(), the timestamp mboxrd's "From " line carries. Always UTC. */
export function toAsctime(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${day} ${time} ${date.getUTCFullYear()}`;
}

/** mboxrd quoting: `From `, `>From ` and deeper all gain one more leading `>`. Anything else is untouched. */
export function quoteFromLine(line: string): string {
  return /^>*From /.test(line) ? `>${line}` : line;
}

/** Inverse of {@link quoteFromLine}: drops one leading `>` from a line that has at least one and reads as From-quoted. */
export function unquoteFromLine(line: string): string {
  return /^>+From /.test(line) ? line.slice(1) : line;
}

export interface MboxMessageInput {
  /** RFC 5321 envelope sender; 'MAILER-DAEMON' when unknown, matching mbox convention. */
  envelopeFrom: string;
  date: Date;
  /** The raw RFC 5322 bytes, CRLF-terminated, as stored in the blob. */
  raw: Readable | AsyncIterable<Uint8Array>;
}

const escapeSender = (address: string): string => (address.trim() === '' ? 'MAILER-DAEMON' : address.replace(/[\r\n]/g, ' '));

/**
 * Streams one message as an mboxrd entry: the "From " line, the body with CRLF -> LF and "From "
 * quoting, and a trailing blank line. Processes the source one chunk at a time — a carry buffer
 * holds at most one incomplete line, never the whole message.
 */
export async function* mboxEntry(message: MboxMessageInput): AsyncGenerator<Buffer> {
  yield Buffer.from(`From ${escapeSender(message.envelopeFrom)} ${toAsctime(message.date)}\n`, 'utf8');

  let carry = '';
  for await (const piece of message.raw) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    if (chunk.length === 0) continue;
    carry += chunk.toString('latin1');
    // Split on LF; a trailing CR (from CRLF) is stripped per line. A line without CR is preserved
    // byte-for-byte (only the terminator changes), so non-CRLF content still round-trips.
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      yield Buffer.from(`${quoteFromLine(line)}\n`, 'latin1');
    }
  }
  if (carry.length > 0) {
    // A body that never ended in a newline still gets one, here.
    const line = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
    yield Buffer.from(`${quoteFromLine(line)}\n`, 'latin1');
  }
  // The mandatory blank separator line, so the next message's "From " line is never mistaken for
  // a continuation of this one's body — and an empty body still gets one line of its own.
  yield Buffer.from('\n', 'latin1');
}

/** Concatenates {@link mboxEntry} for every message in a folder, in order. */
export async function* mboxFolder(messages: AsyncIterable<MboxMessageInput>): AsyncGenerator<Buffer> {
  for await (const message of messages) {
    yield* mboxEntry(message);
  }
}

export interface ParsedMboxEntry {
  envelopeFrom: string;
  date: string;
  /** The body, LF-terminated, with mboxrd quoting undone — the byte-for-byte content this module wrote (sans the added trailing blank line). */
  body: string;
}

const FROM_LINE = /^From (\S*) (.+)$/;

/** Parses mboxrd text this module wrote, for the export's own round-trip test. Not a general parser. */
export function parseMbox(text: string): ParsedMboxEntry[] {
  const lines = text.length === 0 ? [] : text.split('\n');
  // split('\n') on a string ending in '\n' yields a trailing '' element; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const entries: ParsedMboxEntry[] = [];
  let current: { envelopeFrom: string; date: string; body: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    // Drop the one mandatory trailing blank separator line this module always writes.
    const body = current.body.length > 0 && current.body[current.body.length - 1] === '' ? current.body.slice(0, -1) : current.body;
    entries.push({ envelopeFrom: current.envelopeFrom, date: current.date, body: body.length === 0 ? '' : `${body.join('\n')}\n` });
    current = null;
  };
  for (const line of lines) {
    const m = FROM_LINE.exec(line);
    if (m !== null && !line.startsWith('>')) {
      flush();
      current = { envelopeFrom: m[1] ?? '', date: m[2] ?? '', body: [] };
      continue;
    }
    if (current !== null) current.body.push(unquoteFromLine(line));
  }
  flush();
  return entries;
}
