// The message the interpreter sees. It is an interface, not a parsed MIME tree, so the worker can
// hand over what it already holds (its parse stage has the headers; the body parts are only decoded
// if a script asks for `body`). `messageFromMime` builds one from raw bytes with @postroom/mime for
// callers — and tests — that have nothing better.

import { MimeParser, TextPartDecoder, type PartInfo } from '@postroom/mime';

export interface SieveEnvelope {
  /** MAIL FROM address without angle brackets; "" for the null reverse-path. */
  readonly from: string;
  /** The RCPT TO address that caused this delivery. */
  readonly to: string;
}

export interface SieveBodyPart {
  /** `type/subtype`, lowercased. */
  readonly contentType: string;
  /** Decoded content: transfer encoding removed and, for text parts, the charset decoded. */
  readonly content: string;
  /** Content-Disposition, lowercased, or null. */
  readonly disposition: string | null;
}

export interface SieveMessage {
  /** Size of the message in octets (RFC 5228 §5.9). */
  readonly size: number;
  readonly envelope: SieveEnvelope;
  /** Every value of the named header (case-insensitive), unfolded, in order; not RFC 2047-decoded. */
  header(name: string): readonly string[];
  /** The undecoded body — everything after the header block (RFC 5173 `:raw`). */
  rawBody(): string;
  /** Leaf MIME parts, decoded (RFC 5173 `:content` and `:text`). */
  bodyParts(): readonly SieveBodyPart[];
}

export interface FromMimeOptions {
  /** Decoded characters kept per body part (default 1 MiB). */
  readonly maxPartChars?: number;
  /** Characters of raw body kept for `:raw` (default 4 MiB). */
  readonly maxRawChars?: number;
}

function bodyStart(raw: Buffer): number {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x0a) continue;
    if (raw[i + 1] === 0x0a) return i + 2;
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return i + 3;
  }
  return raw.length;
}

/** Build a SieveMessage from raw RFC 5322 bytes. Never throws on malformed mail. */
export function messageFromMime(raw: Buffer | string, envelope: SieveEnvelope, options: FromMimeOptions = {}): SieveMessage {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const maxPart = options.maxPartChars ?? 1024 * 1024;
  const maxRaw = options.maxRawChars ?? 4 * 1024 * 1024;

  const headers = new Map<string, string[]>();
  const parts: SieveBodyPart[] = [];
  const open = new Map<string, { part: PartInfo; decoder: TextPartDecoder | null; pieces: string[]; length: number }>();

  const parser = new MimeParser((e) => {
    switch (e.type) {
      case 'headers':
        if (e.part.parent === null) {
          for (const f of e.headers.fields) {
            const list = headers.get(f.key);
            if (list === undefined) headers.set(f.key, [f.value]);
            else list.push(f.value);
          }
        }
        if (e.part.kind === 'leaf') {
          const text = e.part.contentType.startsWith('text/');
          open.set(e.part.id, { part: e.part, decoder: text ? new TextPartDecoder(e.part.charset) : null, pieces: [], length: 0 });
        }
        break;
      case 'body': {
        const o = open.get(e.part.id);
        if (o === undefined || o.length >= maxPart) break;
        const s = o.decoder === null ? e.chunk.toString('latin1') : o.decoder.write(e.chunk);
        const piece = s.slice(0, maxPart - o.length);
        o.pieces.push(piece);
        o.length += piece.length;
        break;
      }
      case 'end-part': {
        const o = open.get(e.part.id);
        if (o === undefined) break;
        open.delete(e.part.id);
        if (o.decoder !== null && o.length < maxPart) o.pieces.push(o.decoder.end().slice(0, maxPart - o.length));
        parts.push({ contentType: o.part.contentType, content: o.pieces.join(''), disposition: o.part.disposition });
        break;
      }
      default:
        break;
    }
  });
  parser.write(bytes);
  parser.end();

  const body = bytes.subarray(bodyStart(bytes));
  const rawBody = body.subarray(0, maxRaw).toString('latin1');

  return {
    size: bytes.length,
    envelope,
    header: (name) => headers.get(name.toLowerCase()) ?? [],
    rawBody: () => rawBody,
    bodyParts: () => parts,
  };
}
