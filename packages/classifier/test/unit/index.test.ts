import { describe, expect, it } from 'vitest';
import { PACKAGE, decide, extractSignals } from '../../src/index.js';

describe('@postroom/classifier', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/classifier');
  });
});

describe('decide never returns empty reasons', () => {
  it('produces reasons even for the emptiest possible input', () => {
    const signals = extractSignals({ headers: [], envelopeFrom: null, authVerdicts: {}, account: { addresses: [], replyGraph: [], contacts: [], pins: { vip: [] } } });
    const decision = decide(signals);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
