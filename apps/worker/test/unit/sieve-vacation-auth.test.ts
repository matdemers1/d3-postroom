// PST-T-11.14, PST-REQ-188: a Sieve vacation reply goes only to an envelope sender whose domain has
// an SPF pass (for the MAIL FROM identity) or an aligned DKIM pass — otherwise a forged envelope
// sender that still passed classification would get an auto-reply, making Postroom a backscatter
// source. sendVacation (apps/worker/src/stages/sieve.ts) calls this gate before the daily cap.
import { describe, expect, it } from 'vitest';
import { senderAuthorizedForVacation } from '../../src/stages/sieve.js';

describe('senderAuthorizedForVacation (PST-REQ-188)', () => {
  it('passes an envelope sender with an SPF pass for the MAIL FROM identity', () => {
    const verdicts = { spf: { result: 'pass', domain: 'example.org', scope: 'mfrom' } };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r).toMatchObject({ ok: true });
  });

  it('passes an envelope sender with an aligned DKIM pass even without SPF', () => {
    const verdicts = {
      spf: { result: 'fail', domain: 'example.org', scope: 'mfrom' },
      dkim: [{ result: 'pass', domain: 'example.org', testing: false }],
    };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r).toMatchObject({ ok: true });
  });

  it('passes a DKIM pass aligned to the organizational domain, not just an exact match', () => {
    const verdicts = { dkim: [{ result: 'pass', domain: 'mail.example.org', testing: false }] };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r).toMatchObject({ ok: true });
  });

  it('refuses when SPF failed and DKIM failed (fail case)', () => {
    const verdicts = {
      spf: { result: 'fail', domain: 'example.org', scope: 'mfrom' },
      dkim: [{ result: 'fail', domain: 'example.org', testing: false }],
    };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no SPF pass or aligned DKIM pass/);
  });

  it('refuses a forged envelope sender: SPF passed for a different domain and DKIM signed by a different domain', () => {
    // The classic forgery this closes: `MAIL FROM:<victim@example.org>` from a host whose own
    // domain (attacker.net) is what SPF and DKIM actually authenticate.
    const verdicts = {
      spf: { result: 'pass', domain: 'attacker.net', scope: 'mfrom' },
      dkim: [{ result: 'pass', domain: 'attacker.net', testing: false }],
    };
    const r = senderAuthorizedForVacation('victim@example.org', verdicts);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('example.org');
  });

  it('refuses a DKIM pass in testing mode (t=y): not a real signer commitment', () => {
    const verdicts = { dkim: [{ result: 'pass', domain: 'example.org', testing: true }] };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r.ok).toBe(false);
  });

  it('refuses an SPF pass for the HELO identity, not the MAIL FROM identity', () => {
    const verdicts = { spf: { result: 'pass', domain: 'example.org', scope: 'helo' } };
    const r = senderAuthorizedForVacation('alice@example.org', verdicts);
    expect(r.ok).toBe(false);
  });

  it('refuses a null envelope sender (no domain to check)', () => {
    const r = senderAuthorizedForVacation('', { spf: { result: 'pass', domain: 'example.org', scope: 'mfrom' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no domain to check/);
  });

  it('refuses when verdicts are missing entirely (defensive read of stored JSON)', () => {
    const r = senderAuthorizedForVacation('alice@example.org', {});
    expect(r.ok).toBe(false);
  });
});
