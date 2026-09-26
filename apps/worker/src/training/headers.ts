// Reads just the header block of a stored message (bounded: the first MAX_HEADER_BYTES), for the
// tokenizer's header tokens. The stream is destroyed as soon as the blank line is seen.
import type { BlobStore } from '@postroom/blobstore';
import type { HeaderLike } from '@postroom/classifier';
import { parseHeaderBlock } from '@postroom/mime';

export const MAX_HEADER_BYTES = 64 * 1024;

function headerEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

export function blobHeaderReader(blobs: Pick<BlobStore, 'get'>): (blobSha256: string) => Promise<HeaderLike[]> {
  return async (sha256) => {
    const stream = await blobs.get(sha256);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        chunks.push(b);
        size += b.length;
        if (size >= MAX_HEADER_BYTES || headerEnd(Buffer.concat(chunks)) >= 0) break;
      }
    } finally {
      stream.destroy();
    }
    const all = Buffer.concat(chunks).subarray(0, MAX_HEADER_BYTES);
    const end = headerEnd(all);
    const block = end < 0 ? all : all.subarray(0, end + 2);
    return parseHeaderBlock(block).fields.map((f) => ({ name: f.name, value: f.value }));
  };
}
