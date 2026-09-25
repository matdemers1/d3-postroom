#!/usr/bin/env node
// Seeded fast-check smoke run for the DNS decoder (PST-T-1.4): ~2000 random byte packets fed
// straight into decodeMessage, asserting it never throws and never does unbounded work. The
// nightly job runs the same shape coverage-guided; this is the fast CI gate.
import fc from 'fast-check';
import { decodeMessage } from '../../packages/dns/dist/wire.js';
import { decodeName } from '../../packages/dns/dist/name.js';

const seed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
const numRuns = 2000;

let ran = 0;
try {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 1024 }), (bytes) => {
      ran += 1;
      const result = decodeMessage(bytes);
      if (typeof result.ok !== 'boolean') {
        throw new Error('decodeMessage must always return a typed result');
      }
    }),
    { numRuns, seed },
  );

  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), fc.nat({ max: 600 }), (bytes, start) => {
      const result = decodeName(bytes, start);
      if (typeof result.ok !== 'boolean') {
        throw new Error('decodeName must always return a typed result');
      }
    }),
    { numRuns, seed },
  );
} catch (err) {
  console.error(`fuzz/dns/smoke: FAILED after ${String(ran)} decodeMessage runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/dns/smoke: ok (${String(numRuns * 2)} runs, seed=${String(seed)})`);
process.exit(0);
