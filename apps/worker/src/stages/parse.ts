// Stage 2, parse. Streams the stored message out of the blob store through the MIME parser and
// keeps a small, JSON-able summary: the header fields the Message row denormalises (Message-ID,
// subject, from, date), In-Reply-To and References for threading later (PST-P-3), and one line per
// attachment. Deterministic: the blob is immutable, so re-running it re-derives the same summary.
import { Readable } from 'node:stream';
import type { BlobStore } from '@postroom/blobstore';
import { collectMessage, parseDate, parseMailboxes, parseMessageId, parseMessageIdList, parseMessage, type MessageSummary } from '@postroom/mime';
import { htmlToText, truncateUtf8 } from '@postroom/search';
import type { ParseResult, StageInput } from './types.js';

/** The body text kept in the parse result for indexing (PST-T-3.13): the text/plain part, or the
 * html part converted to text when there is no text/plain, capped at 256 KiB on a UTF-8 boundary
 * so a huge message never bloats the pipeline marker JSON. Empty string when the message has
 * neither. */
const MAX_INDEXED_BODY_BYTES = 256 * 1024;

function indexedBody(collected: MessageSummary): string {
  const source = collected.text !== null ? collected.text.text : collected.html !== null ? htmlToText(collected.html.text) : '';
  return truncateUtf8(source, MAX_INDEXED_BODY_BYTES);
}

/** Stream a blob through collectMessage. Nothing is buffered beyond collectMessage's own caps. */
export async function collectBlob(blobs: BlobStore, sha256: string): Promise<MessageSummary> {
  const stream = await blobs.get(sha256);
  return collectMessage(stream as AsyncIterable<Uint8Array>);
}

/** One part's decoded bytes, streamed by re-parsing the blob (for the attachment policy's deep scan). */
export function openBlobPart(blobs: BlobStore, sha256: string, partId: string): Readable {
  return Readable.from(
    (async function* part(): AsyncGenerator<Buffer> {
      const stream = await blobs.get(sha256);
      for await (const event of parseMessage(stream as AsyncIterable<Uint8Array>)) {
        if (event.type === 'body' && event.part.id === partId) yield event.chunk;
      }
    })(),
  );
}

export function summarise(collected: MessageSummary): ParseResult {
  const h = collected.headers;
  const mid = h.get('message-id');
  const subject = h.getDecoded('subject');
  const from = h.get('from');
  const date = h.get('date');
  const sentAt = date === null ? null : parseDate(date);
  const inReplyTo = h.get('in-reply-to');
  const references = h.get('references');
  const to = h.get('to');
  return {
    messageId: mid === null ? null : parseMessageId(mid),
    subject: subject === null ? null : subject.slice(0, 998),
    fromAddress: from === null ? null : (parseMailboxes(from)[0]?.address ?? null),
    toAddress: to === null ? null : parseMailboxes(to).map((m) => m.address).join(', ') || null,
    sentAt: sentAt === null || Number.isNaN(sentAt.getTime()) ? null : sentAt.toISOString(),
    inReplyTo: inReplyTo === null ? [] : parseMessageIdList(inReplyTo),
    references: references === null ? [] : parseMessageIdList(references),
    hasText: collected.text !== null,
    hasHtml: collected.html !== null,
    bodyText: indexedBody(collected),
    attachments: collected.attachments.map((a) => ({
      partId: a.partId,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      sha256: a.sha256,
    })),
    warnings: collected.warnings.length,
  };
}

export async function parseStage(input: StageInput, blobs: BlobStore): Promise<ParseResult> {
  return summarise(await collectBlob(blobs, input.inbound.blobSha256));
}
