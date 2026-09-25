// Property test: the evaluator never throws and never exceeds the SS4.6.4 processing limits,
// for arbitrary (often nonsensical or malformed) SPF record text and zone data.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateSpf, type SpfResult } from '../../src/index.js';
import { createZoneDns, type SpfZone } from './fixtures/spf/zone-dns.js';

const RESULTS: readonly SpfResult[] = ['none', 'neutral', 'pass', 'fail', 'softfail', 'temperror', 'permerror'];

const tokenArb = fc.constantFrom(
  'all',
  '-all',
  '~all',
  '?all',
  '+all',
  'a',
  'mx',
  'ptr',
  'include:next.example',
  'exists:next.example',
  'redirect=next.example',
  'exp=next.example',
  'ip4:1.2.3.4',
  'ip4:1.2.3.4/24',
  'ip6:::1',
  'ip6:::1/64',
  'a:next.example',
  'mx:next.example',
  'garbage',
  '=bad',
  'ip4:bad',
  '/24',
  '%{d}',
  '%{q}',
);

const recordArb = fc.array(tokenArb, { maxLength: 8 }).map((tokens) => `v=spf1 ${tokens.join(' ')}`);

const mxArb = fc.array(fc.record({ preference: fc.nat({ max: 20 }), exchange: fc.constant('next.example') }), { maxLength: 3 });

const zoneEntryArb = fc.record({
  txt: fc.option(fc.array(recordArb, { maxLength: 2 }), { nil: undefined }),
  a: fc.option(fc.array(fc.constantFrom('1.2.3.4', '9.9.9.9', '10.0.0.1'), { maxLength: 2 }), { nil: undefined }),
  mx: fc.option(mxArb, { nil: undefined }),
});

describe('evaluateSpf fuzz (fast-check)', () => {
  it('never throws and respects the lookup/void-lookup limits on arbitrary records', async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, zoneEntryArb, async (record, nextEntry) => {
        const zone: SpfZone = {
          'example.com': { txt: [record] },
          'next.example': nextEntry,
        };
        const dns = createZoneDns(zone);
        const res = await evaluateSpf({ ip: '1.2.3.4', mailFrom: 'user@example.com', helo: 'mail.example.com', dns });
        expect(RESULTS).toContain(res.result);
        if (res.result !== 'permerror') {
          expect(res.lookups).toBeLessThanOrEqual(10);
          expect(res.voidLookups).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 200 },
    );
  });
});
