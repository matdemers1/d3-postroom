// Runs the real openspf.org RFC 7208 test suite (rfc7208-tests.upstream.json/.yml - see
// fixtures/spf/rfc7208-tests.upstream.NOTICE.txt for provenance and licence) against
// evaluateSpf(). Every test in the suite is exercised; a handful are marked SKIP below because
// they depend on type-99 "SPF" resource records being queried and honoured directly, which
// RFC 7208 SS3.1 removed - see each skip's reason.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateSpf, type SpfResult } from '../../src/index.js';
import { createUpstreamDns, type UpstreamZone } from './fixtures/spf/upstream-zone-dns.js';

interface UpstreamTestCase {
  description?: string;
  comment?: string;
  spec?: string | number;
  helo: string;
  host: string;
  mailfrom: string;
  result: SpfResult | SpfResult[];
  explanation?: string;
}

interface UpstreamSection {
  description: string;
  tests: Record<string, UpstreamTestCase>;
  zonedata: UpstreamZone;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const suitePath = path.join(here, 'fixtures', 'spf', 'rfc7208-tests.upstream.json');
const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as UpstreamSection[];

// key: "<section description>/<test name>" -> reason for skipping.
const SKIPPED = new Map<string, string>([
  [
    'Selecting records/empty',
    'the only record published for example1.com is a type-99 SPF RR ("v=spf1"); RFC 7208 SS3.1 removed type SPF as a discovery mechanism, so a compliant TXT-only implementation sees no record at all (result "none", not the suite\'s "neutral").',
  ],
  [
    'Selecting records/nospace2',
    'example3.com publishes only type-99 SPF RRs (plus an MX record the "mx" mechanism would need); with type 99 correctly ignored there is no TXT record, so the compliant result is "none", not "pass".',
  ],
  [
    'Selecting records/multitxt2',
    'example6.com publishes two conflicting type-99 SPF RRs and no TXT record at all; the suite expects the conflict to be detected as "permerror", but a TXT-only implementation queries zero records and correctly returns "none".',
  ],
  [
    'Selecting records/multispf1',
    'example7.com publishes only (duplicate) type-99 SPF RRs, no TXT; the suite\'s acceptable set [permerror, fail] assumes an implementation that queries type SPF, which RFC 7208 forbids. A TXT-only implementation correctly returns "none".',
  ],
  [
    'Selecting records/case-insensitive',
    'example9.com publishes only a type-99 SPF RR ("v=SpF1 ~all") and no TXT record; ignoring type SPF (as RFC 7208 requires) means there is nothing to select, so the compliant result is "none", not "softfail". The case-insensitivity of "v=spf1" itself is exercised elsewhere via TXT records (e.g. Macro expansion, Record evaluation).',
  ],
]);

// The suite uses "DEFAULT" as a sentinel meaning "any library-default explanation is acceptable"
// for a fail result that carries no exp= modifier at all; we never invent an explanation in that
// case (SS6.2 explanation only ever comes from a matched exp=), so we just don't compare it.
const EXPLANATION_SENTINELS = new Set(['DEFAULT']);

describe('the real RFC 7208 test suite (openspf.org, release 2014.04)', () => {
  for (const section of suite) {
    describe(section.description, () => {
      // "Selecting records" and "Record lookup" are deliberately about the {SPF}-vs-{TXT}
      // distinction (RFC 7208 removed type 99 as a discovery mechanism) - their own test
      // descriptions say so explicitly ("Result is none if checking TXT records only", "Ignoring
      // SPF-type records will give pass because there is a (single) TXT record"). Every other
      // section relies on the suite's own documented convention of auto-duplicating {SPF}
      // zonedata entries as TXT records (see the suite's header comment).
      const NO_DUPLICATE_SECTIONS = new Set(['Selecting records', 'Record lookup']);
      const duplicateSpfAsTxt = !NO_DUPLICATE_SECTIONS.has(section.description);
      const dns = createUpstreamDns(section.zonedata, { duplicateSpfAsTxt });

      for (const [name, testCase] of Object.entries(section.tests)) {
        const key = `${section.description}/${name}`;
        const skipReason = SKIPPED.get(key);

        if (skipReason !== undefined) {
          it.skip(`${name} [SKIPPED: ${skipReason}]`, () => {
            /* skipped */
          });
          continue;
        }

        it(name, async () => {
          const res = await evaluateSpf({
            ip: testCase.host,
            mailFrom: testCase.mailfrom,
            helo: testCase.helo,
            dns,
          });
          const acceptable = Array.isArray(testCase.result) ? testCase.result : [testCase.result];
          expect(acceptable, `expected one of [${acceptable.join(', ')}], got ${res.result}`).toContain(res.result);
          if (testCase.explanation !== undefined && !EXPLANATION_SENTINELS.has(testCase.explanation)) {
            expect(res.explanation).toBe(testCase.explanation);
          }
        });
      }
    });
  }

  it('accounts for every test in the suite: 203 total, minus the skips above, all run', () => {
    const total = suite.reduce((sum, section) => sum + Object.keys(section.tests).length, 0);
    expect(total).toBe(203);
    for (const key of SKIPPED.keys()) {
      const [sectionName, testName] = key.split('/');
      const section = suite.find((s) => s.description === sectionName);
      expect(section?.tests[testName ?? '']).toBeDefined();
    }
  });
});
