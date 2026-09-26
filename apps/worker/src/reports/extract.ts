// The candidate report attachments of one stored message (PST-T-7.1). Streams the blob through the
// MIME parser once and keeps the decoded bytes only of parts that could be a report — by type,
// filename or container magic — each capped at `maxPartBytes`, at most `maxParts` of them. A
// report sent as the whole body (Content-Type: application/gzip, no multipart) is a leaf too.
import type { BlobStore } from '@postroom/blobstore';
import { parseMessage } from '@postroom/mime';
import { looksLikeReport, DEFAULT_MAX_INPUT, type ReportAttachment } from '@postroom/reports';

export interface Candidate extends ReportAttachment {
  readonly partId: string;
  /** The part was larger than the cap; its bytes were dropped. */
  readonly oversize: boolean;
}

export interface ExtractOptions {
  maxPartBytes?: number;
  maxParts?: number;
}

const BODY_TYPES = new Set(['text/plain', 'text/html']);

export async function extractCandidates(blobs: Pick<BlobStore, 'get'>, sha256: string, options: ExtractOptions = {}): Promise<Candidate[]> {
  const maxPartBytes = options.maxPartBytes ?? DEFAULT_MAX_INPUT;
  const maxParts = options.maxParts ?? 8;
  const open = new Map<string, { filename: string | null; contentType: string; chunks: Buffer[]; size: number; decided: boolean; wanted: boolean }>();
  const out: Candidate[] = [];
  const stream = await blobs.get(sha256);
  for await (const event of parseMessage(stream as AsyncIterable<Uint8Array>)) {
    if (event.type === 'headers') {
      const p = event.part;
      if (p.kind !== 'leaf') continue;
      if (BODY_TYPES.has(p.contentType) && p.filename === null) continue;
      if (open.size + out.length >= maxParts) continue;
      open.set(p.id, { filename: p.filename, contentType: p.contentType, chunks: [], size: 0, decided: false, wanted: false });
    } else if (event.type === 'body') {
      const s = open.get(event.part.id);
      if (s === undefined) continue;
      if (!s.decided) {
        // Decided on the first chunk: the container magic is in its first bytes.
        s.decided = true;
        s.wanted = looksLikeReport({ filename: s.filename, contentType: s.contentType }, event.chunk.subarray(0, 4));
      }
      if (!s.wanted) continue;
      s.size += event.chunk.length;
      if (s.size <= maxPartBytes) s.chunks.push(event.chunk);
      else s.chunks = [];
    } else if (event.type === 'end-part') {
      const s = open.get(event.part.id);
      if (s === undefined) continue;
      open.delete(event.part.id);
      if (!s.wanted) continue;
      out.push({ partId: event.part.id, filename: s.filename, contentType: s.contentType, bytes: Buffer.concat(s.chunks), oversize: s.size > maxPartBytes });
    }
  }
  return out;
}
