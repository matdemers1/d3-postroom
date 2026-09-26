// PST-T-6.5, PST-REQ-120: the webmail's phishing/lookalike warning banner. Sorting and labelling are
// pure and tested here; the rendered banner (role="alert" for `high`, a labelled region always, axe
// clean) is e2e/tests/phish-banner.spec.ts.
import { describe, expect, it } from 'vitest';
import type { PhishWarning } from '../../src/api';
import { phishWarningTitle, sortPhishWarnings } from '../../src/mail/phish';

function w(kind: PhishWarning['kind'], severity: PhishWarning['severity'], reason = `${kind} reason`): PhishWarning {
  return { kind, severity, reason };
}

describe('sortPhishWarnings (PST-REQ-120)', () => {
  it('orders high, then medium, then low', () => {
    const input = [w('link-mismatch', 'low'), w('auth-failure', 'high'), w('lookalike-domain', 'medium')];
    expect(sortPhishWarnings(input).map((x) => x.severity)).toEqual(['high', 'medium', 'low']);
  });

  it('is stable among warnings of the same severity', () => {
    const a = w('display-name-spoofing', 'high', 'first');
    const b = w('auth-failure', 'high', 'second');
    expect(sortPhishWarnings([a, b])).toEqual([a, b]);
    expect(sortPhishWarnings([b, a])).toEqual([b, a]);
  });

  it('does not mutate its input', () => {
    const input = [w('link-mismatch', 'low'), w('auth-failure', 'high')];
    const copy = [...input];
    sortPhishWarnings(input);
    expect(input).toEqual(copy);
  });

  it('is empty for no warnings', () => {
    expect(sortPhishWarnings([])).toEqual([]);
  });
});

describe('phishWarningTitle (PST-REQ-120)', () => {
  it('gives every warning kind a distinct, human heading', () => {
    const kinds: PhishWarning['kind'][] = ['display-name-spoofing', 'lookalike-domain', 'punycode-domain', 'first-time-brand-sender', 'auth-failure', 'link-mismatch'];
    const titles = kinds.map(phishWarningTitle);
    expect(new Set(titles).size).toBe(kinds.length);
    for (const title of titles) expect(title.length).toBeGreaterThan(0);
  });
});
