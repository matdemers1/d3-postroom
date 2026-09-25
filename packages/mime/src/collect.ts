// `collectMessage`: the one-call summary the worker's parse stage and the attachment policy need —
// headers, the first text/plain and text/html bodies (decoded to strings, capped), and every other
// leaf part as attachment metadata (size, SHA-256, first bytes for sniffing). Streams throughout:
// attachments are hashed and counted, never stored.

import { createHash, type Hash } from 'node:crypto';
import { TextPartDecoder } from './charset.js';
import { HeaderList } from './header.js';
import { parseMessage, type MessageSource, type MimeWarning, type ParseOptions, type ParseStats, type PartInfo } from './parser.js';

export interface AttachmentSummary {
  readonly partId: string;
  readonly contentType: string;
  readonly filename: string | null;
  readonly disposition: string | null;
  readonly contentId: string | null;
  readonly encoding: string;
  readonly charset: string | null;
  /** Decoded size in bytes. */
  readonly size: number;
  /** Hex SHA-256 of the decoded content. */
  readonly sha256: string;
  /** The first decoded bytes (at most `firstBytes`, default 512), for content sniffing. */
  readonly firstBytes: Buffer;
  /** Set when the part is inside an encapsulated message (message/rfc822): the id of that message part. */
  readonly inMessage: string | null;
}

export interface BodySummary {
  readonly partId: string;
  readonly text: string;
  readonly charset: string | null;
  /** The decoder used (after alias resolution). */
  readonly encoding: string;
  /** True when the part was longer than the cap and the text stops early. */
  readonly truncated: boolean;
}

export interface MessageSummary {
  /** The top-level header block (empty when the message had none). */
  readonly headers: HeaderList;
  readonly root: PartInfo | null;
  readonly text: BodySummary | null;
  readonly html: BodySummary | null;
  readonly attachments: readonly AttachmentSummary[];
  readonly warnings: readonly MimeWarning[];
  readonly stats: ParseStats | null;
}

export interface CollectOptions extends ParseOptions {
  /** Decoded bytes of text/plain fed to the text decoder (default 4 MiB). */
  maxTextBytes?: number;
  /** Decoded bytes of text/html fed to the text decoder (default 4 MiB). */
  maxHtmlBytes?: number;
  /** Bytes kept per attachment for sniffing (default 512). */
  firstBytes?: number;
  /** Attachment summaries kept (default 1000); later ones are counted in a warning, not listed. */
  maxAttachments?: number;
}

interface TextState {
  kind: 'text' | 'html';
  decoder: TextPartDecoder;
  pieces: string[];
  fed: number;
  cap: number;
  truncated: boolean;
}

interface AttachmentState {
  hash: Hash;
  first: Buffer[];
  firstLen: number;
}

function isBodyCandidate(part: PartInfo, inMessage: boolean): 'text' | 'html' | null {
  if (inMessage || part.kind !== 'leaf') return null;
  if (part.disposition === 'attachment') return null;
  if (part.contentType === 'text/plain' && part.filename === null) return 'text';
  if (part.contentType === 'text/html' && part.filename === null) return 'html';
  return null;
}

/** Stream a message and summarise it. Never throws on malformed input; it records warnings instead. */
export async function collectMessage(source: MessageSource, options: CollectOptions = {}): Promise<MessageSummary> {
  const maxText = options.maxTextBytes ?? 4 * 1024 * 1024;
  const maxHtml = options.maxHtmlBytes ?? 4 * 1024 * 1024;
  const firstCap = options.firstBytes ?? 512;
  const maxAttachments = options.maxAttachments ?? 1000;

  let rootHeaders: HeaderList | null = null;
  let root: PartInfo | null = null;
  let text: BodySummary | null = null;
  let html: BodySummary | null = null;
  const attachments: AttachmentSummary[] = [];
  const warnings: MimeWarning[] = [];
  let stats: ParseStats | null = null;
  let droppedAttachments = 0;
  let textClaimed = false;
  let htmlClaimed = false;

  /** For each open part, the encapsulated message it sits in (or null), so descendants know. Entries are removed at end-part. */
  const messageOf = new Map<string, string | null>();
  const texts = new Map<string, TextState>();
  const attach = new Map<string, AttachmentState>();

  for await (const event of parseMessage(source, options)) {
    switch (event.type) {
      case 'headers': {
        const { part } = event;
        if (part.parent === null) {
          rootHeaders = event.headers;
          root = part;
        }
        const parentMessage = part.parent === null ? null : (messageOf.get(part.parent) ?? null);
        const enclosing = part.kind === 'message' ? part.id : parentMessage;
        messageOf.set(part.id, enclosing);
        if (part.kind !== 'leaf') break;
        const candidate = isBodyCandidate(part, parentMessage !== null);
        if (candidate === 'text' && !textClaimed) {
          textClaimed = true;
          texts.set(part.id, { kind: 'text', decoder: new TextPartDecoder(part.charset), pieces: [], fed: 0, cap: maxText, truncated: false });
        } else if (candidate === 'html' && !htmlClaimed) {
          htmlClaimed = true;
          texts.set(part.id, { kind: 'html', decoder: new TextPartDecoder(part.charset), pieces: [], fed: 0, cap: maxHtml, truncated: false });
        } else {
          attach.set(part.id, { hash: createHash('sha256'), first: [], firstLen: 0 });
        }
        break;
      }
      case 'body': {
        const id = event.part.id;
        const t = texts.get(id);
        if (t !== undefined) {
          const room = t.cap - t.fed;
          if (room <= 0) {
            t.truncated = true;
          } else {
            const piece = event.chunk.length > room ? event.chunk.subarray(0, room) : event.chunk;
            if (piece.length < event.chunk.length) t.truncated = true;
            t.fed += piece.length;
            t.pieces.push(t.decoder.write(piece));
          }
          break;
        }
        const a = attach.get(id);
        if (a !== undefined) {
          a.hash.update(event.chunk);
          if (a.firstLen < firstCap) {
            const take = event.chunk.subarray(0, firstCap - a.firstLen);
            a.first.push(Buffer.from(take));
            a.firstLen += take.length;
          }
        }
        break;
      }
      case 'end-part': {
        const { part } = event;
        const inMessage = part.parent === null ? null : (messageOf.get(part.parent) ?? null);
        messageOf.delete(part.id);
        const t = texts.get(part.id);
        if (t !== undefined) {
          texts.delete(part.id);
          t.pieces.push(t.decoder.end());
          const summary: BodySummary = { partId: part.id, text: t.pieces.join(''), charset: part.charset, encoding: t.decoder.encoding, truncated: t.truncated };
          if (t.decoder.unknownCharset !== null) {
            warnings.push({ code: 'unknown-charset', message: `unknown charset ${t.decoder.unknownCharset}; decoded as UTF-8`, partId: part.id });
          }
          if (t.kind === 'text') text = summary;
          else html = summary;
          break;
        }
        const a = attach.get(part.id);
        if (a !== undefined) {
          attach.delete(part.id);
          const summary: AttachmentSummary = {
            partId: part.id,
            contentType: part.contentType,
            filename: part.filename,
            disposition: part.disposition,
            contentId: part.contentId,
            encoding: part.encoding,
            charset: part.charset,
            size: event.size,
            sha256: a.hash.digest('hex'),
            firstBytes: Buffer.concat(a.first),
            inMessage,
          };
          if (attachments.length < maxAttachments) attachments.push(summary);
          else droppedAttachments++;
        }
        break;
      }
      case 'warning':
        warnings.push(event.warning);
        break;
      case 'end':
        stats = event.stats;
        break;
    }
  }
  if (droppedAttachments > 0) {
    warnings.push({ code: 'too-many-warnings', message: `${String(droppedAttachments)} further attachments were not listed`, partId: null });
  }
  return { headers: rootHeaders ?? new HeaderList(), root, text, html, attachments, warnings, stats };
}
