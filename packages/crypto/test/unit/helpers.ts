import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Split `data` at the given cut points (any order, clamped) into chunks. */
export function split(data: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => Math.min(Math.max(0, c), data.length)))].sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    if (p > prev) chunks.push(data.subarray(prev, p));
    prev = p;
  }
  if (prev < data.length) chunks.push(data.subarray(prev));
  return chunks;
}

/** Run chunks through a transform and collect the output. */
export async function run(transform: Transform, chunks: readonly Buffer[]): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from(chunks), transform, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) out.push(chunk);
  });
  return Buffer.concat(out);
}

/** Like run, but also returns what was emitted before an error. */
export async function runPartial(
  transform: Transform,
  chunks: readonly Buffer[],
): Promise<{ out: Buffer; error: unknown }> {
  const out: Buffer[] = [];
  try {
    await pipeline(Readable.from(chunks), transform, async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) out.push(chunk);
    });
    return { out: Buffer.concat(out), error: undefined };
  } catch (error) {
    return { out: Buffer.concat(out), error };
  }
}

/** Deterministic pseudo-random bytes (xorshift32), cheap to make large. */
export function pseudoRandom(length: number, seed: number): Buffer {
  const buf = Buffer.alloc(length);
  let x = seed | 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return buf;
}
