// PST-REQ-050: a 100 MB message streams through the engine with bounded buffering.
//
// The message is generated lazily from one reused 64 KiB block (never 100 MB in memory), written
// with backpressure, and discarded by the hook. The engine's own instrumentation records the most
// the line reader and the body stream ever held; the process heap is sampled as it goes.

import { describe, expect, it } from 'vitest';
import { reply } from '../../src/index.js';
import { startSession } from './helpers.js';

const MB = 1024 * 1024;

function block(): { wire: Buffer; unstuffed: number } {
  const lines: string[] = [];
  let size = 0;
  let unstuffed = 0;
  for (let i = 0; size < 64 * 1024 - 200; i++) {
    // Every 7th line starts with a dot, so dot-unstuffing runs all the way through.
    const line = i % 7 === 0 ? `..${'s'.repeat(76)}\r\n` : `${'x'.repeat(78)}\r\n`;
    lines.push(line);
    size += line.length;
    unstuffed += i % 7 === 0 ? line.length - 1 : line.length;
  }
  return { wire: Buffer.from(lines.join(''), 'latin1'), unstuffed };
}

describe('streaming DATA (PST-REQ-050)', () => {
  it('receives a 100 MB message holding a bounded buffer and under 64 MB of heap', async () => {
    const { wire, unstuffed } = block();
    const repeats = Math.ceil((100 * MB) / unstuffed);
    const header = Buffer.from('Subject: big\r\n\r\n', 'latin1');
    const expected = header.length + repeats * unstuffed;

    const baseline = process.memoryUsage();
    let peakHeap = 0;
    let received = 0;
    let chunks = 0;
    const h = await startSession({
      maxSize: 120 * MB,
      hooks: {
        onData: async (body) => {
          for await (const c of body) {
            received += (c as Buffer).length;
            if (++chunks % 64 === 0) {
              const m = process.memoryUsage();
              peakHeap = Math.max(peakHeap, m.heapUsed - baseline.heapUsed);
            }
          }
          return reply(250, '2.0.0', 'Queued');
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example> SIZE=110000000\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
    expect((await h.replies.take(4)).map((r) => r.code)).toEqual([250, 250, 250, 354]);

    h.client.write(header);
    for (let i = 0; i < repeats; i++) {
      if (!h.client.write(wire)) await new Promise((r) => h.client.once('drain', r));
    }
    h.client.write('.\r\n');
    const final = await h.replies.next();
    expect(final.code).toBe(250);
    expect(received).toBe(expected);
    expect(received).toBeGreaterThan(100 * MB);

    // The reader never held more than one socket read plus one partial line; the body stream never
    // more than its high-water mark plus one chunk.
    expect(h.session.stats.maxReaderBuffered).toBeLessThanOrEqual(256 * 1024);
    expect(h.session.stats.maxBodyBuffered).toBeLessThanOrEqual(64 * 1024 + 256 * 1024);
    expect(peakHeap).toBeLessThan(64 * MB);
  }, 120_000);
});
