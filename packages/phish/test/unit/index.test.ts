import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectPhish, PACKAGE, type DetectPhishInput, type PhishAuthVerdicts } from '../../src/index.js';

describe('@postroom/phish', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/phish');
  });
});

const NO_AUTH: PhishAuthVerdicts = {};
const PASSING_AUTH: PhishAuthVerdicts = {
  spf: { result: 'pass' },
  dkim: [{ result: 'pass' }],
  dmarc: { result: 'pass', policy: 'reject' },
};

function base(overrides: Partial<DetectPhishInput> = {}): DetectPhishInput {
  return {
    from: { address: 'sender@example.com', displayName: 'Sender Example' },
    authVerdicts: NO_AUTH,
    account: { knownSenders: {} },
    ...overrides,
  };
}

describe('detectPhish: each fixture shows its reason', () => {
  it('display-name spoofing: an email address in the display name', () => {
    const result = detectPhish(
      base({
        from: { address: 'billing@evil-domain.example', displayName: 'PayPal <support@paypal.com>' },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'display-name-spoofing');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal.com');
    expect(w?.reason).toContain('evil-domain.example');
  });

  it('display-name spoofing: a bare domain named in the display name', () => {
    const result = detectPhish(
      base({
        from: { address: 'notice@evil-domain.example', displayName: 'amazon.com Order Update' },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'display-name-spoofing');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('amazon.com');
  });

  it('display-name spoofing: matches a contact by name but not by address', () => {
    const result = detectPhish(
      base({
        from: { address: 'jane.d.2024@webmail.example', displayName: 'Jane Doe' },
        account: { knownSenders: {}, contacts: [{ name: 'Jane Doe', address: 'jane@work.example' }] },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'display-name-spoofing');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('Jane Doe');
    expect(w?.reason).toContain('jane@work.example');
  });

  it('lookalike domain: homoglyph (Cyrillic а) skeleton match', () => {
    const result = detectPhish(
      base({
        from: { address: `support@pаypal.com`, displayName: 'PayPal' }, // Cyrillic а
        account: { knownSenders: { domains: ['paypal.com'] } },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'lookalike-domain');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal.com');
    expect(w?.reason.toLowerCase()).toContain('homoglyph');
  });

  it('lookalike domain: edit distance 1 from a known sender', () => {
    const result = detectPhish(
      base({
        from: { address: 'notice@paypall.com' },
        account: { knownSenders: { domains: ['paypal.com'] } },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'lookalike-domain');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal.com');
    expect(w?.reason).toContain('1 character');
  });

  it('punycode domain: mixed-script IDN', () => {
    // xn--pypal-4ve.com decodes to "pаypal.com" style mix; use a constructed IDN label that mixes
    // Cyrillic а into "paypal": punycode-encode "pаypal" by hand is complex, so encode "xn--"
    // for a label that decodes to a mixed-script string using a known test vector instead.
    const result = detectPhish(
      base({
        from: { address: 'login@xn--pypal-lkf.com', displayName: 'PayPal' },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'punycode-domain');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('punycode');
  });

  it('first-time sender claiming a known brand', () => {
    const result = detectPhish(
      base({
        from: { address: 'security@notreally-paypal.example', displayName: 'PayPal Security' },
        account: { knownSenders: {} },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'first-time-brand-sender');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal');
    expect(w?.reason).toContain('notreally-paypal.example');
  });

  it('authentication failure: DMARC fail with a reject policy', () => {
    const result = detectPhish(
      base({
        from: { address: 'sender@example.com' },
        authVerdicts: { dmarc: { result: 'fail', policy: 'reject' } },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'auth-failure');
    expect(w).toBeDefined();
    expect(w?.severity).toBe('high');
    expect(w?.reason).toContain('DMARC failed');
  });

  it('authentication failure: SPF fail', () => {
    const result = detectPhish(
      base({
        authVerdicts: { spf: { result: 'fail' } },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'auth-failure' && x.reason.includes('SPF'));
    expect(w).toBeDefined();
  });

  it('authentication failure: DKIM fail for a domain that normally passes', () => {
    const result = detectPhish(
      base({
        from: { address: 'sender@example.com' },
        authVerdicts: { dkim: [{ result: 'fail' }] },
        account: { knownSenders: { domains: ['example.com'] } },
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'auth-failure' && x.reason.includes('DKIM'));
    expect(w).toBeDefined();
    expect(w?.severity).toBe('high');
    expect(w?.reason).toContain('previously received authenticated mail');
  });

  it('link text/href mismatch', () => {
    const result = detectPhish(
      base({
        links: [{ text: 'https://paypal.com/verify', href: 'https://evil-domain.example/phish' }],
      }),
    );
    const w = result.warnings.find((x) => x.kind === 'link-mismatch');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal.com');
    expect(w?.reason).toContain('evil-domain.example');
  });
});

describe('detectPhish: benign fixtures produce no warnings', () => {
  it('a real-looking newsletter from an authenticated, known sender', () => {
    const result = detectPhish(
      base({
        from: { address: 'news@example.com', displayName: 'Example News' },
        authVerdicts: PASSING_AUTH,
        account: { knownSenders: { addresses: ['news@example.com'], domains: ['example.com'] } },
        subject: 'Your weekly digest',
        links: [{ text: 'Read more', href: 'https://example.com/digest' }],
      }),
    );
    expect(result.warnings).toEqual([]);
  });

  it('a colleague replying in a normal thread', () => {
    const result = detectPhish(
      base({
        from: { address: 'colleague@work.example', displayName: 'Colleague Name' },
        authVerdicts: PASSING_AUTH,
        account: {
          knownSenders: { addresses: ['colleague@work.example'], domains: ['work.example'] },
          contacts: [{ name: 'Colleague Name', address: 'colleague@work.example' }],
        },
        links: [{ text: 'the doc', href: 'https://docs.work.example/abc' }],
      }),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe('detectPhish: never throws, reasons never empty', () => {
  const address = fc.string({ minLength: 0, maxLength: 40 });
  const authResult = fc.record({ result: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }) }, { requiredKeys: [] });
  const input = fc.record({
    from: fc.record({ address, displayName: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }) }),
    replyTo: fc.option(fc.record({ address, displayName: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }) }), { nil: undefined }),
    returnPath: fc.option(address, { nil: undefined }),
    authVerdicts: fc.record(
      {
        spf: fc.option(authResult, { nil: undefined }),
        dkim: fc.option(fc.array(authResult, { maxLength: 4 }), { nil: undefined }),
        dmarc: fc.option(
          fc.record(
            { result: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }), policy: fc.option(fc.constantFrom('none', 'quarantine', 'reject'), { nil: undefined }) },
            { requiredKeys: [] },
          ),
          { nil: undefined },
        ),
        arc: fc.option(authResult, { nil: undefined }),
      },
      { requiredKeys: [] },
    ),
    account: fc.record({
      knownSenders: fc.record(
        { addresses: fc.option(fc.array(address, { maxLength: 5 }), { nil: undefined }), domains: fc.option(fc.array(address, { maxLength: 5 }), { nil: undefined }) },
        { requiredKeys: [] },
      ),
      contacts: fc.option(fc.array(fc.record({ name: fc.string({ maxLength: 20 }), address }), { maxLength: 5 }), { nil: undefined }),
    }),
    subject: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
    links: fc.option(fc.array(fc.record({ text: fc.string({ maxLength: 60 }), href: fc.string({ maxLength: 80 }) }), { maxLength: 5 }), { nil: undefined }),
  });

  it('never throws and every warning has a non-empty reason, over arbitrary input', () => {
    fc.assert(
      fc.property(input, (value) => {
        const result = detectPhish(value as DetectPhishInput);
        for (const w of result.warnings) expect(w.reason.trim().length).toBeGreaterThan(0);
      }),
    );
  });
});
