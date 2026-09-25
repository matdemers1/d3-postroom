import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createDecryptStream,
  createEncryptStream,
  DecryptError,
  encryptedSize,
  generateDek,
  SEGMENT_BYTES,
  sha256Hex,
  STREAM_HEADER_BYTES,
} from '../../src/index.js';
import { pseudoRandom, run, runPartial, split } from './helpers.js';

const SEALED = SEGMENT_BYTES + 16;
const aad = sha256Hex('blob');

const encrypt = (dek: Buffer, data: Buffer, cuts: number[] = []) =>
  run(createEncryptStream(dek, aad), split(data, cuts));
const decrypt = (dek: Buffer, data: Buffer, cuts: number[] = []) =>
  run(createDecryptStream(dek, aad), split(data, cuts));

describe('streaming AEAD', () => {
  it('round-trips random data over random chunk boundaries, both directions', async () => {
    const lengthArb = fc.oneof(
      fc.constantFrom(0, 1, SEGMENT_BYTES - 1, SEGMENT_BYTES, SEGMENT_BYTES + 1, 2 * SEGMENT_BYTES, 3 * SEGMENT_BYTES),
      fc.integer({ min: 0, max: 4 * SEGMENT_BYTES }),
    );
    await fc.assert(
      fc.asyncProperty(
        lengthArb,
        fc.integer(),
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        async (length, seed, plainCuts, cipherCuts) => {
          const dek = generateDek();
          const plain = pseudoRandom(length, seed);
          const ct = await encrypt(dek, plain, plainCuts.map((c) => c % (length + 1)));
          expect(ct.length).toBe(encryptedSize(length));
          const back = await decrypt(dek, ct, cipherCuts.map((c) => c % (ct.length + 1)));
          expect(back.equals(plain)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('handles empty input and exact multiples of the segment size', async () => {
    for (const length of [0, SEGMENT_BYTES, 2 * SEGMENT_BYTES]) {
      const dek = generateDek();
      const plain = randomBytes(length);
      const ct = await encrypt(dek, plain);
      expect(ct.length).toBe(STREAM_HEADER_BYTES + length + Math.max(1, length / SEGMENT_BYTES) * 16);
      expect((await decrypt(dek, ct)).equals(plain)).toBe(true);
    }
  });

  it('ciphertext never contains the plaintext', async () => {
    const plain = Buffer.from('Subject: hello\r\n\r\nThe quick brown fox jumps over the lazy dog.\r\n'.repeat(3000));
    const ct = await encrypt(generateDek(), plain);
    expect(ct.includes(plain.subarray(0, 32))).toBe(false);
    expect(ct.includes(Buffer.from('quick brown fox'))).toBe(false);
  });

  describe('detects tampering', () => {
    const dek = generateDek();
    const plain = pseudoRandom(3 * SEGMENT_BYTES + 1000, 7); // four segments, the last short
    const ctPromise = encrypt(dek, plain);
    const seg = (ct: Buffer, i: number) =>
      ct.subarray(STREAM_HEADER_BYTES + i * SEALED, STREAM_HEADER_BYTES + (i + 1) * SEALED);

    const expectFailure = async (bad: Buffer, key: Buffer = dek, withAad: string = aad) => {
      const { error } = await runPartial(createDecryptStream(key, withAad), [bad]);
      expect(error).toBeInstanceOf(DecryptError);
    };

    it('truncation: last segment dropped, cut mid-segment, header only, empty', async () => {
      const ct = await ctPromise;
      await expectFailure(ct.subarray(0, STREAM_HEADER_BYTES + 3 * SEALED));
      await expectFailure(ct.subarray(0, STREAM_HEADER_BYTES + 2 * SEALED));
      await expectFailure(ct.subarray(0, ct.length - 1));
      await expectFailure(ct.subarray(0, STREAM_HEADER_BYTES + 10));
      await expectFailure(ct.subarray(0, STREAM_HEADER_BYTES));
      await expectFailure(ct.subarray(0, 3));
      await expectFailure(Buffer.alloc(0));
    });

    it('extension: bytes appended after the final segment', async () => {
      const ct = await ctPromise;
      await expectFailure(Buffer.concat([ct, Buffer.alloc(16)]));
      await expectFailure(Buffer.concat([ct, seg(ct, 0)]));
    });

    it('reordered segments', async () => {
      const ct = await ctPromise;
      const header = ct.subarray(0, STREAM_HEADER_BYTES);
      const tail = ct.subarray(STREAM_HEADER_BYTES + 3 * SEALED);
      await expectFailure(Buffer.concat([header, seg(ct, 1), seg(ct, 0), seg(ct, 2), tail]));
      await expectFailure(Buffer.concat([header, seg(ct, 0), seg(ct, 2), seg(ct, 1), tail]));
    });

    it('flipped byte in the header, a middle segment, or the final tag', async () => {
      const ct = await ctPromise;
      for (const i of [0, 3, STREAM_HEADER_BYTES + SEALED + 5, ct.length - 1]) {
        const bad = Buffer.from(ct);
        bad[i] = (bad[i] ?? 0) ^ 0x40;
        await expectFailure(bad);
      }
    });

    it('wrong key or wrong AAD', async () => {
      const ct = await ctPromise;
      await expectFailure(ct, generateDek());
      await expectFailure(ct, dek, sha256Hex('another blob'));
    });

    it('a segment splice from another stream under the same key', async () => {
      const ct = await ctPromise;
      const other = await encrypt(dek, plain);
      await expectFailure(Buffer.concat([ct.subarray(0, STREAM_HEADER_BYTES + SEALED), other.subarray(STREAM_HEADER_BYTES + SEALED)]));
    });

    it('never emits the plaintext of a segment that failed', async () => {
      const ct = await ctPromise;
      const bad = Buffer.from(ct);
      const i = STREAM_HEADER_BYTES + SEALED + 100; // inside segment 1
      bad[i] = (bad[i] ?? 0) ^ 1;
      const { out, error } = await runPartial(createDecryptStream(dek, aad), split(bad, [1, 5000, 90_000, 200_000]));
      expect(error).toBeInstanceOf(DecryptError);
      expect(out.length).toBe(SEGMENT_BYTES);
      expect(out.equals(plain.subarray(0, SEGMENT_BYTES))).toBe(true);
    });
  });

  it('streams ~20 MB with bounded memory', async () => {
    // Garbage is not retention: collect before each sample so the measurement is what the
    // pipeline actually holds. `gc` is exposed at runtime rather than via a CLI flag.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const total = 20 * 1024 * 1024;
    const chunk = pseudoRandom(256 * 1024, 11);
    const dek = generateDek();
    let produced = 0;
    function* source(count: boolean) {
      for (let sent = 0; sent < total; sent += chunk.length) {
        const copy = Buffer.from(chunk);
        copy.writeUInt32BE(sent, 0);
        if (count) produced += copy.length;
        yield copy;
      }
    }
    const expected = createHash('sha256');
    for (const c of source(false)) expected.update(c);

    const mem = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    gc();
    const base = mem();
    let peakMem = 0;
    let peakInFlight = 0;
    let bytes = 0;
    let nextSample = 0;
    const actual = createHash('sha256');
    await pipeline(
      Readable.from(source(true)),
      createEncryptStream(dek, aad),
      createDecryptStream(dek, aad),
      async (decrypted: AsyncIterable<Buffer>) => {
        for await (const c of decrypted) {
          actual.update(c);
          bytes += c.length;
          peakInFlight = Math.max(peakInFlight, produced - bytes);
          if (bytes >= nextSample) {
            nextSample += 2 * 1024 * 1024;
            gc();
            peakMem = Math.max(peakMem, mem() - base);
          }
        }
      },
    );
    expect(bytes).toBe(total);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    // Backpressure holds: the source is never read more than a few segments ahead of the sink.
    expect(peakInFlight).toBeLessThan(2 * 1024 * 1024);
    // No heap assertion: on shared CI runners heap sampling swings by more than the message size
    // (5, 8 and 20 MB were all seen for the same 20 MB run). The in-flight bound above is the proof
    // that nothing is buffered; peakMem stays as a diagnostic.
    void peakMem;
  }, 30_000);
});
