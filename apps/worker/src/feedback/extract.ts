// The report inside one stored message (PST-T-11.15): is it a multipart/report (RFC 6522) of type
// delivery-status (RFC 3464) or feedback-report (RFC 5965), and if so, its machine-readable part and
// the returned original's Message-ID. Streams the blob through the MIME parser once and stops at
// the first header block when the message is not a report — which is nearly every message — so the
// stage costs one header read for ordinary mail. Only the report's own direct children are read, and
// each at most MAX_REPORT_BYTES (PST-REQ-050: nothing buffers a whole message).
import type { BlobStore } from '@postroom/blobstore';
import { DELIVERY_STATUS_TYPES, FEEDBACK_REPORT_TYPE, MAX_REPORT_BYTES } from '@postroom/dsn';
import { parseHeaderBlock, parseMailboxes, parseMessage, parseMessageId } from '@postroom/mime';

export type ReportType = 'delivery-status' | 'feedback-report';

export interface ExtractedReport {
  readonly type: ReportType;
  /** The report message's own From address, lowercased, or null. */
  readonly from: string | null;
  /** The machine-readable part's decoded bytes (capped), or null when the report had none. */
  readonly body: Buffer | null;
  /** The returned original's Message-ID (without brackets), from message/rfc822 or text/rfc822-headers. */
  readonly originalMessageId: string | null;
}

const RETURNED_HEADERS = 'text/rfc822-headers';
const RETURNED_MESSAGE = new Set(['message/rfc822', 'message/global', 'message/global-headers']);

function reportTypeOf(params: Readonly<Record<string, string | undefined>>): ReportType | null {
  const t = (params['report-type'] ?? '').trim().toLowerCase();
  return t === 'delivery-status' || t === 'feedback-report' ? t : null;
}

/** Null when the stored message is not a delivery-status or feedback-report multipart/report. */
export async function extractReport(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<ExtractedReport | null> {
  const stream = await blobs.get(sha256);
  let type: ReportType | null = null;
  let from: string | null = null;
  let rootId = '';
  let body: Buffer | null = null;
  let originalMessageId: string | null = null;
  // Part id → what is being collected from it.
  const collecting = new Map<string, { kind: 'status' | 'headers'; chunks: Buffer[]; size: number }>();
  const wrappers = new Set<string>();
  for await (const event of parseMessage(stream as AsyncIterable<Uint8Array>)) {
    if (event.type === 'headers') {
      const p = event.part;
      if (p.parent === null) {
        if (p.kind !== 'multipart' || p.contentType !== 'multipart/report') return null;
        type = reportTypeOf(p.params);
        if (type === null) return null;
        rootId = p.id;
        const f = p.headers.get('from');
        from = f === null ? null : (parseMailboxes(f)[0]?.address.toLowerCase() ?? null);
        continue;
      }
      if (p.parent === rootId) {
        const isStatus = type === 'delivery-status' ? DELIVERY_STATUS_TYPES.includes(p.contentType) : p.contentType === FEEDBACK_REPORT_TYPE;
        if (isStatus && body === null && p.kind === 'leaf') collecting.set(p.id, { kind: 'status', chunks: [], size: 0 });
        else if (p.contentType === RETURNED_HEADERS && p.kind === 'leaf' && originalMessageId === null) collecting.set(p.id, { kind: 'headers', chunks: [], size: 0 });
        else if (RETURNED_MESSAGE.has(p.contentType)) {
          if (p.kind === 'message') wrappers.add(p.id);
          // message/global-headers, or an encoded message/rfc822 the parser left as a leaf: a header block.
          else if (originalMessageId === null) collecting.set(p.id, { kind: 'headers', chunks: [], size: 0 });
        }
        continue;
      }
      // The encapsulated original's own header block.
      if (wrappers.has(p.parent) && originalMessageId === null) {
        const mid = p.headers.get('message-id');
        originalMessageId = mid === null ? null : parseMessageId(mid);
      }
    } else if (event.type === 'body') {
      const c = collecting.get(event.part.id);
      if (c === undefined || c.size >= MAX_REPORT_BYTES) continue;
      const room = MAX_REPORT_BYTES - c.size;
      const chunk = event.chunk.length > room ? event.chunk.subarray(0, room) : event.chunk;
      c.chunks.push(chunk);
      c.size += chunk.length;
    } else if (event.type === 'end-part') {
      const c = collecting.get(event.part.id);
      if (c === undefined) continue;
      collecting.delete(event.part.id);
      const bytes = Buffer.concat(c.chunks);
      if (c.kind === 'status') body = bytes;
      else if (originalMessageId === null) {
        const mid = parseHeaderBlock(bytes).get('message-id');
        originalMessageId = mid === null ? null : parseMessageId(mid);
      }
    }
  }
  if (type === null) return null;
  return { type, from, body, originalMessageId };
}
