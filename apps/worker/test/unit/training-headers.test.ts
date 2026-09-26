// PST-T-5.3: the training consumer reads only a stored message's header block, bounded.
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { blobHeaderReader, MAX_HEADER_BYTES } from '../../src/training/headers.js';

function fakeBlobs(chunks: readonly Buffer[]): { get: (sha: string) => Promise<Readable>; pulled: () => number } {
  let pulled = 0;
  return {
    get: () =>
      Promise.resolve(
        Readable.from(
          (function* () {
            for (const c of chunks) {
              pulled++;
              yield c;
            }
          })(),
        ),
      ),
    pulled: () => pulled,
  };
}

describe('blobHeaderReader', () => {
  it('returns the header fields and stops at the blank line', async () => {
    const blobs = fakeBlobs([
      Buffer.from('From: a@example.com\r\nList-Unsubscribe: <mailto:u@example.com>\r\n'),
      Buffer.from('Subject: hi\r\n\r\nbody line\r\n'),
      Buffer.from('never read'),
    ]);
    const headers = await blobHeaderReader(blobs)('sha');
    expect(headers).toEqual([
      { name: 'From', value: 'a@example.com' },
      { name: 'List-Unsubscribe', value: '<mailto:u@example.com>' },
      { name: 'Subject', value: 'hi' },
    ]);
    expect(blobs.pulled()).toBe(2);
  });

  it('reads at most MAX_HEADER_BYTES of a message with no blank line', async () => {
    const line = Buffer.from(`X-Filler: ${'y'.repeat(1000)}\r\n`);
    const blobs = fakeBlobs(Array.from({ length: 1000 }, () => line));
    const headers = await blobHeaderReader(blobs)('sha');
    expect(blobs.pulled()).toBeLessThanOrEqual(Math.ceil(MAX_HEADER_BYTES / line.length) + 1);
    expect(headers.length).toBeGreaterThan(0);
  });
});
