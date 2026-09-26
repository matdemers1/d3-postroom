import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decide, extractSignals, type AuthVerdicts, type HeaderLike } from '../../src/index.js';
import { account, header } from './fixtures.js';

const headerNames = ['From', 'To', 'Cc', 'List-Id', 'Precedence', 'Subject', 'X-Weird', 'In-Reply-To'];

const headerArb: fc.Arbitrary<HeaderLike> = fc
  .record({
    name: fc.constantFrom(...headerNames),
    value: fc.string({ maxLength: 60 }),
  })
  .map(({ name, value }) => header(name, value));

const headersArb = fc.array(headerArb, { maxLength: 12 });

const authArb: fc.Arbitrary<AuthVerdicts> = fc.record({
  spf: fc.record({ result: fc.constantFrom('pass', 'fail', 'none', 'temperror') }),
  dkim: fc.array(fc.record({ result: fc.constantFrom('pass', 'fail', 'none') }), { maxLength: 3 }),
  dmarc: fc.record({ result: fc.constantFrom('pass', 'fail', 'none', 'temperror') }),
  arc: fc.record({ result: fc.constantFrom('pass', 'fail', 'none') }),
});

describe('classifier properties', () => {
  it('extractSignals never throws on arbitrary header lists', () => {
    fc.assert(
      fc.property(headersArb, fc.string({ maxLength: 40 }), authArb, (headers, envelopeFrom, authVerdicts) => {
        expect(() => extractSignals({ headers, envelopeFrom: envelopeFrom === '' ? null : envelopeFrom, authVerdicts, account: account() })).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('decide never returns empty reasons', () => {
    fc.assert(
      fc.property(headersArb, authArb, (headers, authVerdicts) => {
        const signals = extractSignals({ headers, envelopeFrom: null, authVerdicts, account: account() });
        const decision = decide(signals);
        expect(decision.reasons.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('header name case never changes the result', () => {
    fc.assert(
      fc.property(headersArb, authArb, (headers, authVerdicts) => {
        const upper = headers.map((h) => header(h.name.toUpperCase(), h.value));
        const lower = headers.map((h) => header(h.name.toLowerCase(), h.value));
        const a = decide(extractSignals({ headers: upper, envelopeFrom: null, authVerdicts, account: account() }));
        const b = decide(extractSignals({ headers: lower, envelopeFrom: null, authVerdicts, account: account() }));
        expect(a.bucket).toBe(b.bucket);
        expect(a.reasons).toEqual(b.reasons);
      }),
      { numRuns: 300 },
    );
  });
});
