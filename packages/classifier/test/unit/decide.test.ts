// One fixture per Priority branch (PST-REQ-102), its negations, People (PST-REQ-173), and Other —
// the doneWhen for PST-T-5.2: "Each Priority branch fixture classified correctly with reasons."
import { describe, expect, it } from 'vitest';
import { decide, extractSignals } from '../../src/index.js';
import { AUTH_FAIL, AUTH_PASS, account, directMessage, header } from './fixtures.js';

describe('Priority branches (PST-REQ-102)', () => {
  it('reply graph member, addressed directly, not bulk → priority', () => {
    const signals = extractSignals(directMessage({ account: account({ replyGraph: ['jane@example.com'] }) }));
    const decision = decide(signals);
    expect(decision.bucket).toBe('priority');
    expect(decision.reasons).toContain('sender in reply graph');
    expect(decision.reasons).toContain('addressed directly (To)');
  });

  it('contact, addressed directly, not bulk → priority', () => {
    const signals = extractSignals(directMessage({ account: account({ contacts: ['jane@example.com'] }) }));
    const decision = decide(signals);
    expect(decision.bucket).toBe('priority');
    expect(decision.reasons).toContain('sender in contacts');
  });

  it('authenticated VIP, addressed directly, not bulk → priority', () => {
    const signals = extractSignals(directMessage({ account: account({ pins: { vip: ['jane@example.com'] } }) }));
    const decision = decide(signals);
    expect(decision.bucket).toBe('priority');
    expect(decision.reasons).toContain('sender in VIP pins');
    expect(decision.reasons).toContain('DMARC pass (aligned SPF or DKIM)');
  });

  it('+tag and trailing-dot normalization still matches the reply graph', () => {
    const signals = extractSignals(
      directMessage({
        headers: [header('From', 'Jane Doe <jane+newsletter@example.com.>'), header('To', 'me@d3cloud.io')],
        account: account({ replyGraph: ['JANE@Example.com'] }),
      }),
    );
    const decision = decide(signals);
    expect(decision.bucket).toBe('priority');
  });
});

describe('Priority negations', () => {
  it('bulk via List-Id keeps a known, directly addressed sender out of priority', () => {
    const signals = extractSignals(
      directMessage({
        headers: [...directMessage().headers, header('List-Id', 'Jane Updates <updates.example.com>')],
        account: account({ replyGraph: ['jane@example.com'] }),
      }),
    );
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('List-Id present') && r.includes('bulk'))).toBe(true);
  });

  it('bulk via Precedence: bulk keeps a known, directly addressed sender out of priority', () => {
    const signals = extractSignals(
      directMessage({
        headers: [...directMessage().headers, header('Precedence', 'bulk')],
        account: account({ replyGraph: ['jane@example.com'] }),
      }),
    );
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('Precedence: bulk'))).toBe(true);
  });

  it('bulk via an ESP fingerprint header keeps a known, directly addressed sender out of priority', () => {
    const signals = extractSignals(
      directMessage({
        headers: [...directMessage().headers, header('X-SES-Outgoing', '2024.1.1-1.2.3.4')],
        account: account({ replyGraph: ['jane@example.com'] }),
      }),
    );
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('X-SES-Outgoing'))).toBe(true);
  });

  it('Cc-only, known sender → not priority', () => {
    const signals = extractSignals({
      headers: [header('From', 'Jane Doe <jane@example.com>'), header('Cc', 'me@d3cloud.io')],
      envelopeFrom: 'jane@example.com',
      authVerdicts: AUTH_PASS,
      account: account({ replyGraph: ['jane@example.com'] }),
    });
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('only on Cc'))).toBe(true);
  });

  it('account address absent from To or Cc (bcc/list) → not priority', () => {
    const signals = extractSignals({
      headers: [header('From', 'Jane Doe <jane@example.com>'), header('To', 'someoneelse@example.org')],
      envelopeFrom: 'jane@example.com',
      authVerdicts: AUTH_PASS,
      account: account({ replyGraph: ['jane@example.com'] }),
    });
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('not present in To or Cc'))).toBe(true);
  });

  it('DMARC-failing VIP spoof does not reach priority through the VIP channel', () => {
    const signals = extractSignals(directMessage({ authVerdicts: AUTH_FAIL, account: account({ pins: { vip: ['jane@example.com'] } }) }));
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('VIP match does not count unauthenticated'))).toBe(true);
  });

  it('automated noreply sender is never priority, even if directly addressed', () => {
    const signals = extractSignals(
      directMessage({
        headers: [header('From', 'no-reply@example.com'), header('To', 'me@d3cloud.io')],
        envelopeFrom: 'no-reply@example.com',
        account: account({ replyGraph: ['no-reply@example.com'] }),
      }),
    );
    const decision = decide(signals);
    expect(decision.bucket).not.toBe('priority');
    expect(decision.reasons.some((r) => r.includes('looks automated'))).toBe(true);
  });
});

describe('People (PST-REQ-173)', () => {
  it('a first-time human sender, not in reply graph/contacts/VIP, is People', () => {
    const signals = extractSignals(directMessage());
    const decision = decide(signals);
    expect(decision.bucket).toBe('people');
    expect(decision.reasons.some((r) => r.includes('not in reply graph, contacts'))).toBe(true);
  });

  it('a known sender who is only Cc is People, not Priority', () => {
    const signals = extractSignals({
      headers: [header('From', 'Jane Doe <jane@example.com>'), header('Cc', 'me@d3cloud.io')],
      envelopeFrom: 'jane@example.com',
      authVerdicts: AUTH_PASS,
      account: account({ contacts: ['jane@example.com'] }),
    });
    const decision = decide(signals);
    expect(decision.bucket).toBe('people');
  });
});

describe('Other', () => {
  it('a newsletter (bulk, ESP + List-Id) is Other', () => {
    const signals = extractSignals({
      headers: [
        header('From', 'Big Newsletter <news@newsletter.example.com>'),
        header('To', 'me@d3cloud.io'),
        header('List-Id', 'Big Newsletter <news.newsletter.example.com>'),
        header('List-Unsubscribe', '<mailto:unsub@newsletter.example.com>'),
      ],
      envelopeFrom: 'news@newsletter.example.com',
      authVerdicts: AUTH_PASS,
      account: account(),
    });
    const decision = decide(signals);
    expect(decision.bucket).toBe('other');
    expect(decision.reasons.some((r) => r.includes('not a human sender'))).toBe(true);
  });

  it('a blocked pin always lands in Other, even from a reply-graph member', () => {
    const signals = extractSignals(directMessage({ account: account({ replyGraph: ['jane@example.com'], pins: { vip: [], blocked: ['jane@example.com'] } }) }));
    const decision = decide(signals);
    expect(decision.bucket).toBe('other');
    expect(decision.reasons.some((r) => r.includes('blocked'))).toBe(true);
  });
});

describe('every filed decision stores non-empty reasons (PST-REQ-103)', () => {
  it.each([
    ['priority', directMessage({ account: account({ contacts: ['jane@example.com'] }) })],
    ['people', directMessage()],
    ['other (bulk)', directMessage({ headers: [...directMessage().headers, header('Precedence', 'bulk')] })],
  ] as const)('%s decision has reasons', (_label, input) => {
    const decision = decide(extractSignals(input));
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(decision.scores).length).toBeGreaterThan(0);
  });
});
