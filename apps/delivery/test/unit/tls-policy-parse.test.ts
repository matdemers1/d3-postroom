// PST-T-7.5: the pure parts of MTA-STS (RFC 8461) and DANE (RFC 7672) — the TXT record, the policy
// text, MX pattern matching, TLSA usability, the setting-table cache — plus fast-check properties
// that the parsers never throw on arbitrary input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createSettingPolicyStore,
  isUsableTlsa,
  mxMatchesPattern,
  parsePolicy,
  parseStsTxt,
  tlsaName,
  verifyDane,
  type CachedMtaStsPolicy,
  type SettingDelegate,
} from '../../src/policy/index.js';

describe('parseStsTxt (RFC 8461 §3.1)', () => {
  it('takes the id from a valid record', () => {
    expect(parseStsTxt('v=STSv1; id=20160831085700Z;')).toBe('20160831085700Z');
    expect(parseStsTxt('v=STSv1;id=abc')).toBe('abc');
  });
  it('refuses a record that does not start with v=STSv1, or has no/invalid id', () => {
    expect(parseStsTxt('id=abc; v=STSv1')).toBeNull();
    expect(parseStsTxt('v=STSv1')).toBeNull();
    expect(parseStsTxt('v=STSv1; id=has-dash')).toBeNull();
    expect(parseStsTxt(`v=STSv1; id=${'a'.repeat(33)}`)).toBeNull();
    expect(parseStsTxt('v=STSv2; id=abc')).toBeNull();
  });
});

describe('parsePolicy (RFC 8461 §3.2)', () => {
  it('parses the RFC example, CRLF or LF', () => {
    const body = 'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmx: *.example.net\r\nmx: backupmx.example.com\r\nmax_age: 604800\r\n';
    expect(parsePolicy(body)).toEqual({ ok: true, policy: { mode: 'enforce', mx: ['mail.example.com', '*.example.net', 'backupmx.example.com'], maxAge: 604800 } });
    expect(parsePolicy(body.replace(/\r\n/g, '\n')).ok).toBe(true);
  });
  it('ignores unknown keys and lowercases mx', () => {
    expect(parsePolicy('version: STSv1\nmode: testing\nmx: MX.Example.COM.\nmax_age: 1\nfoo: bar\n')).toEqual({ ok: true, policy: { mode: 'testing', mx: ['mx.example.com'], maxAge: 1 } });
  });
  it('mode none needs no mx', () => {
    expect(parsePolicy('version: STSv1\nmode: none\nmax_age: 0\n').ok).toBe(true);
  });
  it('refuses a wrong version, a bad mode, a missing or oversized max_age, enforce without mx, and junk lines', () => {
    expect(parsePolicy('version: STSv2\nmode: enforce\nmx: a.b\nmax_age: 1\n').ok).toBe(false);
    expect(parsePolicy('version: STSv1\nmode: strict\nmx: a.b\nmax_age: 1\n').ok).toBe(false);
    expect(parsePolicy('version: STSv1\nmode: enforce\nmx: a.b\n').ok).toBe(false);
    expect(parsePolicy('version: STSv1\nmode: enforce\nmx: a.b\nmax_age: 31557601\n').ok).toBe(false);
    expect(parsePolicy('version: STSv1\nmode: enforce\nmax_age: 60\n').ok).toBe(false);
    expect(parsePolicy('<html>\nversion: STSv1\n').ok).toBe(false);
    expect(parsePolicy('version: STSv1\nmode: enforce\nmx: *.*.example.com\nmax_age: 60\n').ok).toBe(false);
  });
  it('never throws on arbitrary text (property)', () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => { parsePolicy(s); parseStsTxt(s); }), { numRuns: 500 });
    fc.assert(fc.property(fc.array(fc.constantFrom('version: STSv1', 'mode: enforce', 'mode: testing', 'mx: a.example', 'mx: *.x.example', 'max_age: 86400', 'x', ':', ''), { maxLength: 8 }), (lines) => {
      const r = parsePolicy(lines.join('\r\n'));
      if (r.ok) expect(r.policy.maxAge).toBeLessThanOrEqual(31_557_600);
    }));
  });
});

describe('mxMatchesPattern (RFC 8461 §4.1)', () => {
  it('matches exactly, case- and trailing-dot-insensitively', () => {
    expect(mxMatchesPattern('mail.example.com.', 'mail.example.com')).toBe(true);
    expect(mxMatchesPattern('MAIL.example.com', 'mail.example.com')).toBe(true);
    expect(mxMatchesPattern('mail2.example.com', 'mail.example.com')).toBe(false);
  });
  it('a wildcard covers exactly one left-most label', () => {
    expect(mxMatchesPattern('mx1.example.net', '*.example.net')).toBe(true);
    expect(mxMatchesPattern('a.mx1.example.net', '*.example.net')).toBe(false);
    expect(mxMatchesPattern('example.net', '*.example.net')).toBe(false);
    expect(mxMatchesPattern('evilexample.net', '*.example.net')).toBe(false);
  });
});

describe('TLSA usability (RFC 7672 §3.1.3)', () => {
  it('DANE-TA and DANE-EE with known selectors and correctly sized digests are usable; PKIX usages are not', () => {
    expect(isUsableTlsa({ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) })).toBe(true);
    expect(isUsableTlsa({ usage: 2, selector: 0, matchingType: 2, data: new Uint8Array(64) })).toBe(true);
    expect(isUsableTlsa({ usage: 3, selector: 1, matchingType: 0, data: new Uint8Array(91) })).toBe(true);
    expect(isUsableTlsa({ usage: 0, selector: 1, matchingType: 1, data: new Uint8Array(32) })).toBe(false);
    expect(isUsableTlsa({ usage: 1, selector: 1, matchingType: 1, data: new Uint8Array(32) })).toBe(false);
    expect(isUsableTlsa({ usage: 3, selector: 2, matchingType: 1, data: new Uint8Array(32) })).toBe(false);
    expect(isUsableTlsa({ usage: 3, selector: 1, matchingType: 3, data: new Uint8Array(32) })).toBe(false);
    expect(isUsableTlsa({ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(31) })).toBe(false);
  });
  it('names the TLSA RRset _25._tcp.<mx>', () => {
    expect(tlsaName('MX.Example.com.')).toBe('_25._tcp.mx.example.com');
  });
  it('an empty chain never verifies', () => {
    expect(verifyDane([{ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) }], [], ['mx.example']).ok).toBe(false);
  });
});

describe('createSettingPolicyStore', () => {
  it('persists under mta-sts:<domain>, reads back through a fresh store, and ignores malformed rows', async () => {
    const rows = new Map<string, unknown>();
    const setting: SettingDelegate = {
      findUnique: ({ where }) => Promise.resolve(rows.has(where.key) ? { value: rows.get(where.key) } : null),
      upsert: ({ where, create }) => { rows.set(where.key, create.value); return Promise.resolve(null); },
    };
    const entry: CachedMtaStsPolicy = { id: 'abc', policy: { mode: 'enforce', mx: ['mx.example.com'], maxAge: 60 }, fetchedAt: 1, expiresAt: 60_001 };
    await createSettingPolicyStore(setting).set('Example.COM.', entry);
    expect([...rows.keys()]).toEqual(['mta-sts:example.com']);
    expect(await createSettingPolicyStore(setting).get('example.com')).toEqual(entry);
    rows.set('mta-sts:bad.example', { id: 7 });
    expect(await createSettingPolicyStore(setting).get('bad.example')).toBeUndefined();
  });
});
