// The end-of-DATA decision (PST-REQ-058): every branch, and every outcome carries its reasons.
import { describe, expect, it } from 'vitest';
import type { ArcResult, DmarcResult } from '@postroom/auth-checks';
import { decide, replyText } from '../../src/decide.js';

function dmarcOf(over: Partial<DmarcResult> = {}): DmarcResult {
  return {
    result: 'pass',
    fromDomain: 'example.com',
    fromDomains: ['example.com'],
    disposition: 'none',
    sampled: true,
    reasons: ['aligned DKIM pass'],
    authResults: 'dmarc=pass header.from=example.com',
    ...over,
  };
}

const failReject = (): DmarcResult =>
  dmarcOf({
    result: 'fail',
    disposition: 'reject',
    policy: 'reject',
    record: { v: 'DMARC1', p: 'reject', adkim: 'r', aspf: 'r', pct: 100, fo: ['0'], rf: ['afrf'], ri: 86400, rua: [], ruf: [] } as unknown as NonNullable<DmarcResult['record']>,
    reasons: ['SPF fail for example.com; no DKIM signature aligned'],
  });

const noArc: ArcResult = { result: 'none', instances: 0, sealerDomains: [], sets: [], temporary: false, reasons: ['no ARC header fields'], authResults: 'arc=none' };

function trustedArc(domain = 'google.com'): ArcResult {
  return {
    result: 'pass',
    instances: 1,
    oldestPass: 1,
    sealerDomains: [domain],
    sets: [{ instance: 1, sealDomain: domain, authResults: 'mx.google.com; dmarc=pass header.from=example.com', ams: 'pass', seal: 'pass', reasons: [] }],
    temporary: false,
    reasons: [],
    authResults: `arc=pass (i=1 sealed by ${domain})`,
  };
}

describe('decide', () => {
  it('accepts a DMARC pass, with reasons', () => {
    const d = decide({ dmarc: dmarcOf(), arc: noArc, trustedArcSealers: ['google.com'] });
    expect(d).toMatchObject({ action: 'accept', disposition: 'accept', rule: 'accept', reply: null });
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons).toContain('dmarc=pass disposition=none');
  });

  it('rejects DMARC fail with p=reject: 550 5.7.1 naming the domain and the reason', () => {
    const d = decide({ dmarc: failReject(), arc: noArc, trustedArcSealers: ['google.com'] });
    expect(d.action).toBe('reject');
    expect(d.rule).toBe('dmarc-reject');
    expect(d.reply?.code).toBe(550);
    expect(d.reply?.enhanced).toBe('5.7.1');
    expect(d.reply?.lines[0]).toContain('example.com (p=reject)');
    expect(d.reply?.lines[0]).toContain('SPF fail');
    expect(d.reasons).toContain('SPF fail for example.com; no DKIM signature aligned');
    expect(d.arcOverride?.overridden).toBe(false);
  });

  it('accepts a DMARC reject overridden by a trusted ARC chain, recording the override reason', () => {
    const d = decide({ dmarc: failReject(), arc: trustedArc(), trustedArcSealers: ['google.com'] });
    expect(d).toMatchObject({ action: 'accept', disposition: 'accept' });
    expect(d.arcOverride?.overridden).toBe(true);
    expect(d.reasons.some((r) => r.startsWith('DMARC fail overridden by ARC pass sealed by google.com'))).toBe(true);
  });

  it('does not override for an untrusted sealer', () => {
    const d = decide({ dmarc: failReject(), arc: trustedArc('evil.example'), trustedArcSealers: ['google.com'] });
    expect(d.action).toBe('reject');
    expect(d.reasons.some((r) => r.includes('not trusted'))).toBe(true);
  });

  it('defers a DMARC reject when ARC had a temporary failure', () => {
    const d = decide({ dmarc: failReject(), arc: { ...noArc, result: 'fail', temporary: true }, trustedArcSealers: ['google.com'] });
    expect(d).toMatchObject({ action: 'defer', rule: 'arc-temperror' });
    expect(d.reply?.code).toBe(451);
  });

  it('accepts p=quarantine with disposition quarantine', () => {
    const d = decide({ dmarc: dmarcOf({ result: 'fail', disposition: 'quarantine' }), arc: noArc, trustedArcSealers: [] });
    expect(d).toMatchObject({ action: 'accept', disposition: 'quarantine', rule: 'dmarc-quarantine' });
  });

  it('defers a DMARC temperror with 451 4.4.3', () => {
    const d = decide({ dmarc: dmarcOf({ result: 'temperror', reasons: ['SERVFAIL at _dmarc.example.com'] }), arc: noArc, trustedArcSealers: [] });
    expect(d).toMatchObject({ action: 'defer', rule: 'dmarc-temperror' });
    expect(d.reply).toMatchObject({ code: 451, enhanced: '4.4.3' });
    expect(d.reasons).toContain('SERVFAIL at _dmarc.example.com');
  });

  it('rejects a DNSBL-listed client with 554 5.7.1, before DMARC', () => {
    const d = decide({
      dmarc: dmarcOf(),
      arc: noArc,
      trustedArcSealers: [],
      dnsbl: { listed: true, zone: 'zen.spamhaus.org', reason: 'SBL' },
    });
    expect(d).toMatchObject({ action: 'reject', disposition: 'reject', rule: 'dnsbl' });
    expect(d.reply).toMatchObject({ code: 554, enhanced: '5.7.1' });
    expect(d.reasons[0]).toBe('client IP is listed on zen.spamhaus.org: SBL');
  });

  it('ignores a DNSBL verdict that is not listed', () => {
    const d = decide({ dmarc: dmarcOf(), arc: noArc, trustedArcSealers: [], dnsbl: { listed: false, zone: 'zen.spamhaus.org' } });
    expect(d.action).toBe('accept');
  });

  it('rejects a header section over the limit with 552 5.3.4', () => {
    const d = decide({ dmarc: dmarcOf(), arc: noArc, trustedArcSealers: [], headerTooLarge: true });
    expect(d).toMatchObject({ action: 'reject', rule: 'header-too-large' });
    expect(d.reply).toMatchObject({ code: 552, enhanced: '5.3.4' });
  });

  it('applies the strictest disposition of a multi-From permerror', () => {
    const d = decide({ dmarc: dmarcOf({ result: 'permerror', disposition: 'reject' }), arc: noArc, trustedArcSealers: ['google.com'] });
    expect(d.action).toBe('reject');
  });

  it('replyText keeps a reply to one bounded printable-ASCII line', () => {
    expect(replyText('a\r\nbéc')).toBe('a b c');
    expect(replyText('x'.repeat(500)).length).toBe(400);
  });
});
