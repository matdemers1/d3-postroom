// The RFC 7208 evaluator, exercised against the reconstructed conformance suite in
// fixtures/spf/rfc7208-tests.ts (see that file's header for what is/isn't a literal copy of the
// upstream OpenSPF suite).
import { describe, expect, it } from 'vitest';
import { authResultsSpf, evaluateSpf, parseRecord, parseTerm, selectSpfRecord, SpfPermError, NO_SPF_RECORD } from '../../src/index.js';
import { createZoneDns } from './fixtures/spf/zone-dns.js';
import { rfc7208TestCases } from './fixtures/spf/rfc7208-tests.authored.js';

describe('evaluateSpf against the RFC 7208 test suite', () => {
  const bySection = new Map<string, typeof rfc7208TestCases>();
  for (const testCase of rfc7208TestCases) {
    const list = bySection.get(testCase.section) ?? [];
    list.push(testCase);
    bySection.set(testCase.section, list);
  }

  for (const [section, cases] of bySection) {
    describe(section, () => {
      for (const testCase of cases) {
        it(testCase.name, async () => {
          const dns = createZoneDns(testCase.zone, testCase.ptrZone);
          const res = await evaluateSpf({
            ip: testCase.ip,
            mailFrom: testCase.mailFrom ?? 'user@example.com',
            helo: testCase.helo ?? 'mail.example.com',
            dns,
          });
          expect(res.result).toBe(testCase.result);
          if (testCase.explanation !== undefined) {
            expect(res.explanation).toBe(testCase.explanation);
          }
        });
      }
    });
  }

  it('reports how many cases ran, for the doneWhen evidence', () => {
    expect(rfc7208TestCases.length).toBeGreaterThan(0);
    expect(bySection.size).toBeGreaterThan(0);
  });
});

describe('evaluateSpf never throws', () => {
  it('a genuinely broken record produces permerror, not an exception', async () => {
    const dns = createZoneDns({ 'example.com': { txt: ['v=spf1 ip4:not-an-ip -all'] } });
    const res = await evaluateSpf({ ip: '1.2.3.4', mailFrom: 'user@example.com', helo: 'mail.example.com', dns });
    expect(res.result).toBe('permerror');
  });

  it('a SERVFAIL deep in an include chain surfaces as temperror', async () => {
    const dns = createZoneDns({
      'example.com': { txt: ['v=spf1 include:broken.example -all'] },
      'broken.example': 'SERVFAIL',
    });
    const res = await evaluateSpf({ ip: '1.2.3.4', mailFrom: 'user@example.com', helo: 'mail.example.com', dns });
    expect(res.result).toBe('temperror');
  });
});

describe('authResultsSpf', () => {
  it('formats smtp.mailfrom for a MAIL FROM identity', async () => {
    const dns = createZoneDns({ 'example.com': { txt: ['v=spf1 +all'] } });
    const res = await evaluateSpf({ ip: '1.2.3.4', mailFrom: 'user@example.com', helo: 'mail.example.com', dns });
    expect(authResultsSpf(res)).toBe('spf=pass smtp.mailfrom=example.com');
  });

  it('formats smtp.helo for a null-sender identity', async () => {
    const dns = createZoneDns({ 'mail.example.com': { txt: ['v=spf1 -all'] } });
    const res = await evaluateSpf({ ip: '1.2.3.4', mailFrom: null, helo: 'mail.example.com', dns });
    expect(authResultsSpf(res)).toBe('spf=fail smtp.helo=mail.example.com');
  });
});

describe('parseRecord / parseTerm / selectSpfRecord', () => {
  it('parses every mechanism and modifier kind in one record', () => {
    const terms = parseRecord(
      'v=spf1 a mx ptr ip4:1.2.3.4 ip6:::1 exists:%{d} include:example.net redirect=example.org exp=exp.example.org all',
    );
    expect(terms.map((t) => (t.kind === 'mechanism' ? t.mechanism.type : t.modifier.type))).toEqual([
      'a',
      'mx',
      'ptr',
      'ip4',
      'ip6',
      'exists',
      'include',
      'redirect',
      'exp',
      'all',
    ]);
  });

  it('rejects a record that does not begin with v=spf1', () => {
    expect(() => parseRecord('v=spf2.0 mfrom')).toThrow(SpfPermError);
  });

  it('rejects an unrecognized term', () => {
    expect(() => parseTerm('bogus:thing')).toThrow(SpfPermError);
  });

  it('reports NO_SPF_RECORD for an empty set, and the record for one match', () => {
    expect(selectSpfRecord([])).toBe(NO_SPF_RECORD);
    expect(selectSpfRecord(['v=spf1 -all'])).toBe('v=spf1 -all');
  });
});
