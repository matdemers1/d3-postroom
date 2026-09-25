// PST-REQ-050 / PST-T-2.1 doneWhen: a 100 MB message parses with bounded memory.
//
// The message is generated lazily in fresh 64 KiB chunks (so a parser that kept references to its
// input would show up in arrayBuffers), and consumed by a sink that only counts and hashes. Two
// assertions: the primary, structural one — the parser's own instrumented retained-bytes peak never
// exceeds its bound — and heap growth (heapUsed + arrayBuffers, sampled after forced GC) under 64 MB.

import { createHash, randomBytes } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { collectMessage, parseMessage } from '../../src/index.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const MiB = 1024 * 1024;
const RAW_PER_BLOCK = 57 * 840; // 840 base64 lines of 76 characters
const TARGET = 100 * MiB;

function makeBlock(raw: Buffer): Buffer {
  const b64 = raw.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
}

interface Generated {
  source: AsyncGenerator<Buffer>;
  blocks: number;
  raw: Buffer;
}

function hugeMessage(): Generated {
  const raw = randomBytes(RAW_PER_BLOCK);
  const block = makeBlock(raw);
  const head = Buffer.from(
    [
      'From: big@example.com',
      'Subject: a hundred megabytes',
      'Content-Type: multipart/mixed; boundary="huge-boundary"',
      '',
      'preamble',
      '--huge-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See the attachment.',
      '--huge-boundary',
      'Content-Type: application/octet-stream; name="big.bin"',
      'Content-Disposition: attachment; filename="big.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      '',
    ].join('\r\n'),
  );
  const tail = Buffer.from('--huge-boundary\r\nContent-Type: text/plain\r\n\r\nafter\r\n--huge-boundary--\r\n');
  const blocks = Math.ceil((TARGET - head.length - tail.length) / block.length);
  async function* source(): AsyncGenerator<Buffer> {
    yield head;
    for (let i = 0; i < blocks; i++) {
      // Like a socket: a fresh allocation every time, and the event loop turns now and then.
      if (i % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      yield Buffer.from(block);
    }
    yield tail;
  }
  return { source: source(), blocks, raw };
}

function memory(): number {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

describe('100 MB message', () => {
  it('parses end to end under a bounded buffer and < 64 MB heap growth', { timeout: 180_000 }, async () => {
    const { source, blocks, raw } = hugeMessage();
    const expectedHash = createHash('sha256');
    for (let i = 0; i < blocks; i++) expectedHash.update(raw);

    gc();
    const baseline = memory();
    let peakGrowth = 0;
    let bodyEvents = 0;
    const sizes = new Map<string, number>();
    const hash = createHash('sha256');
    let stats: { bytesIn: number; maxRetainedBytes: number; retainedBound: number } | null = null;
    let text = '';

    for await (const e of parseMessage(source)) {
      if (e.type === 'body') {
        sizes.set(e.part.id, (sizes.get(e.part.id) ?? 0) + e.chunk.length);
        if (e.part.id === '1.2') hash.update(e.chunk);
        else if (e.part.id === '1.1' || e.part.id === '1.3') text += e.chunk.toString();
        if (++bodyEvents % 200 === 0) {
          gc();
          peakGrowth = Math.max(peakGrowth, memory() - baseline);
        }
      } else if (e.type === 'end') {
        stats = e.stats;
      }
    }
    gc();
    peakGrowth = Math.max(peakGrowth, memory() - baseline);

    expect(stats).not.toBeNull();
    const s = stats as NonNullable<typeof stats>;
    expect(s.bytesIn).toBeGreaterThanOrEqual(TARGET);
    expect(sizes.get('1.2')).toBe(blocks * RAW_PER_BLOCK);
    expect(hash.digest('hex')).toBe(expectedHash.digest('hex'));
    expect(text).toBe('See the attachment.after');

    // Primary: the parser's instrumented peak stays within its structural bound — and, for a
    // message whose headers are tiny, within a couple of slices.
    expect(s.maxRetainedBytes).toBeLessThanOrEqual(s.retainedBound);
    expect(s.maxRetainedBytes).toBeLessThan(256 * 1024);
    // Secondary: the process heap did not grow with the message.
    console.log(
      `100 MB parse: bytesIn=${String(s.bytesIn)} maxRetained=${String(s.maxRetainedBytes)} bound=${String(s.retainedBound)} peakHeapGrowth=${(peakGrowth / MiB).toFixed(1)} MiB`,
    );
    expect(peakGrowth).toBeLessThan(64 * MiB);
  });

  it('collectMessage summarises it with bounded memory too', { timeout: 180_000 }, async () => {
    const { source, blocks } = hugeMessage();
    gc();
    const baseline = memory();
    const summary = await collectMessage(source);
    gc();
    expect(memory() - baseline).toBeLessThan(64 * MiB);
    expect(summary.text?.text).toBe('See the attachment.');
    expect(summary.attachments.map((a) => [a.partId, a.filename, a.size])).toEqual([
      ['1.2', 'big.bin', blocks * RAW_PER_BLOCK],
      ['1.3', null, 5],
    ]);
    expect(summary.attachments[0]?.firstBytes.length).toBe(512);
    expect(summary.stats?.maxRetainedBytes).toBeLessThan(256 * 1024);
  });
});
