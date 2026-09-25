import { describe, expect, it } from 'vitest';
import type { DkimResult, EvaluateSpfResult } from '@postroom/auth-checks';
import {
  buildAuthenticationResults,
  buildReceived,
  foldHeader,
  formatRfc5322Date,
  receivedProtocol,
} from '../../src/headers.js';

const DATE = new Date('2026-09-25T08:05:09Z');

function lines(field: string): string[] {
  expect(field.endsWith('\r\n')).toBe(true);
  return field.slice(0, -2).split('\r\n');
}

describe('foldHeader', () => {
  it('folds at 78 columns on whitespace with a leading tab', () => {
    const value = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(' ');
    const out = lines(foldHeader('X-Test', value));
    expect(out.length).toBeGreaterThan(1);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(78);
    for (const l of out.slice(1)) expect(l.startsWith('\t')).toBe(true);
    // Unfolding gives the value back.
    expect(out.join('\r\n').replace(/\r\n\t/g, ' ')).toBe(`X-Test: ${value}`);
  });

  it('leaves a single overlong token whole', () => {
    const token = 'x'.repeat(120);
    expect(lines(foldHeader('X', `a ${token} b`))).toEqual(['X: a', `\t${token}`, '\tb']);
  });

  it('strips CR, LF and other controls so a value cannot start a new field', () => {
    const out = foldHeader('X', 'evil\r\nBcc: victim@example.com\0');
    expect(out).toBe('X: evil Bcc: victim@example.com\r\n');
  });
});

describe('formatRfc5322Date', () => {
  it('formats UTC with a numeric zone', () => {
    expect(formatRfc5322Date(DATE)).toBe('Fri, 25 Sep 2026 08:05:09 +0000');
  });
});

describe('receivedProtocol', () => {
  it('names SMTP, ESMTP, ESMTPS and the UTF8 variants', () => {
    expect(receivedProtocol({ ehlo: false, secure: false, smtputf8: false })).toBe('SMTP');
    expect(receivedProtocol({ ehlo: true, secure: false, smtputf8: false })).toBe('ESMTP');
    expect(receivedProtocol({ ehlo: true, secure: true, smtputf8: false })).toBe('ESMTPS');
    expect(receivedProtocol({ ehlo: true, secure: false, smtputf8: true })).toBe('UTF8SMTP');
    expect(receivedProtocol({ ehlo: true, secure: true, smtputf8: true })).toBe('UTF8SMTPS');
  });
});

describe('buildReceived', () => {
  const base = {
    helo: 'mail.example.com',
    rdns: 'out1.example.com',
    ip: '203.0.113.7',
    hostname: 'mx.d3cloud.io',
    protocol: 'ESMTPS' as const,
    id: 'abc123',
    recipients: ['matt@d3cloud.io'],
    date: DATE,
  };

  it('records helo, rDNS, IP, protocol, id, the single recipient and the date', () => {
    const field = buildReceived(base);
    const unfolded = field.replace(/\r\n\t/g, ' ');
    expect(unfolded).toBe(
      'Received: from mail.example.com (out1.example.com [203.0.113.7]) by mx.d3cloud.io (Postroom) with ESMTPS id abc123 for <matt@d3cloud.io>; Fri, 25 Sep 2026 08:05:09 +0000\r\n',
    );
    for (const l of lines(field)) expect(l.length).toBeLessThanOrEqual(78);
  });

  it('writes unknown when there is no rDNS, and omits for with several recipients', () => {
    const field = buildReceived({ ...base, rdns: null, recipients: ['a@d3cloud.io', 'b@d3cloud.io'] });
    expect(field).toContain('(unknown [203.0.113.7])');
    expect(field).not.toContain(' for ');
  });

  it('cannot be broken by a hostile HELO or rDNS name', () => {
    const field = buildReceived({
      ...base,
      helo: 'x\r\nX-Injected: yes',
      rdns: 'evil) (by fake\r\nX-Other: 1',
    });
    const ls = lines(field);
    for (const l of ls.slice(1)) expect(l.startsWith('\t')).toBe(true);
    expect(field).not.toMatch(/\r\nX-/);
    expect(field).not.toMatch(/\r(?!\n)|(?<!\r)\n|\r\n(?!\t|$)/);
    // The comment stays balanced: the rDNS text cannot close it.
    expect(field.replace(/\r\n\t/g, ' ')).toContain('(evil_ _by fake X-Other: 1 [203.0.113.7])');
    expect(field.replace(/\r\n\t/g, ' ')).toMatch(/^Received: from x_X-Injected:_yes /);
  });
});

describe('buildAuthenticationResults', () => {
  const spf: EvaluateSpfResult = {
    result: 'pass',
    domain: 'example.com',
    scope: 'mfrom',
    mechanism: '+ip4:203.0.113.0/24',
    lookups: 1,
    voidLookups: 0,
    trace: [],
  };
  const dkim: DkimResult = {
    result: 'pass',
    index: 0,
    domain: 'example.com',
    headerD: 'example.com',
    selector: 's1',
    algorithm: 'ed25519-sha256',
    headerB: 'AbCdEfGh',
    bodyHashMatches: true,
    testing: false,
    reasons: [],
  };

  it('records spf with its reason and each dkim signature', () => {
    const field = buildAuthenticationResults({ hostname: 'mx.d3cloud.io', clientIp: '203.0.113.7', spf, dkim: [dkim] });
    expect(field.replace(/\r\n\t/g, ' ')).toBe(
      'Authentication-Results: mx.d3cloud.io; spf=pass (sender IP 203.0.113.7; matched +ip4:203.0.113.0/24) smtp.mailfrom=example.com; dkim=pass header.d=example.com header.s=s1 header.a=ed25519-sha256 header.b=AbCdEfGh\r\n',
    );
    for (const l of lines(field)) expect(l.length).toBeLessThanOrEqual(78);
  });

  it('says none when nothing was checked, and carries extra methods', () => {
    const field = buildAuthenticationResults({
      hostname: 'mx.d3cloud.io',
      clientIp: '192.0.2.1',
      spf: null,
      dkim: [],
      extra: ['dmarc=pass header.from=example.com'],
    });
    expect(field.replace(/\r\n\t/g, ' ')).toBe(
      'Authentication-Results: mx.d3cloud.io; spf=none; dkim=none; dmarc=pass header.from=example.com\r\n',
    );
  });

  it('uses smtp.helo for a null sender and keeps a failure reason', () => {
    const field = buildAuthenticationResults({
      hostname: 'mx.d3cloud.io',
      clientIp: '192.0.2.1',
      spf: { ...spf, result: 'temperror', scope: 'helo', domain: 'helo.example', mechanism: undefined, trace: ['aborted: timeout\r\nX: y'] },
      dkim: null,
    });
    const unfolded = field.replace(/\r\n\t/g, ' ');
    expect(unfolded).toContain('spf=temperror (sender IP 192.0.2.1; aborted: timeout X: y) smtp.helo=helo.example');
    expect(unfolded).toContain('dkim=none');
  });
});
