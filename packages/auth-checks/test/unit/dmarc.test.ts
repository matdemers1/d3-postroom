import { generateKeyPairSync } from 'node:crypto';
import { RCode } from '@postroom/dns';
import { describe, expect, it } from 'vitest';
import {
  createDkimVerifier,
  dnsRecordFor,
  evaluateDmarc,
  fetchDmarcPolicy,
  parseDmarcRecord,
  type DmarcDkimInput,
  type DmarcDns,
  type DmarcSpfInput,
  type EvaluateDmarcInput,
} from '../../src/index.js';
import { fakeDns, forgeSignature } from './fixtures/dkim/forge.js';

const dkimPass = (domain: string, testing = false): DmarcDkimInput => ({ result: 'pass', domain, testing });
const dkimFail = (domain: string): DmarcDkimInput => ({ result: 'fail', domain, testing: false });
const spf = (result: string, domain: string): DmarcSpfInput => ({ result, domain });

function run(
  records: Record<string, string | readonly string[]>,
  input: Partial<Omit<EvaluateDmarcInput, 'dns'>> & { from: readonly string[] },
  dnsExtra: Partial<DmarcDns> = {},
): ReturnType<typeof evaluateDmarc> {
  const dns = { ...fakeDns(records), ...dnsExtra };
  return evaluateDmarc({ dkim: [], ...input, dns });
}

describe('parseDmarcRecord', () => {
  it('parses every tag with defaults', () => {
    const p = parseDmarcRecord('v=DMARC1; p=Reject; rua=mailto:d@example.com,mailto:e@example.net!10m; fo=1:d');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.record).toMatchObject({
      p: 'reject',
      adkim: 'r',
      aspf: 'r',
      pct: 100,
      ri: 86400,
      rua: ['mailto:d@example.com', 'mailto:e@example.net!10m'],
      fo: ['1', 'd'],
      pAssumed: false,
    });
    expect(p.record.sp).toBeUndefined();
  });

  it('requires v=DMARC1 first, exactly', () => {
    expect(parseDmarcRecord('p=reject; v=DMARC1')).toMatchObject({ ok: false, isDmarc: false });
    expect(parseDmarcRecord('v=dmarc1; p=reject')).toMatchObject({ ok: false, isDmarc: false });
    expect(parseDmarcRecord('v=spf1 -all')).toMatchObject({ ok: false, isDmarc: false });
  });

  it('invalid p= with a valid rua= is treated as p=none (§6.6.3 step 6)', () => {
    const p = parseDmarcRecord('v=DMARC1; p=bogus; rua=mailto:r@example.com');
    expect(p).toMatchObject({ ok: true, record: { p: 'none', pAssumed: true } });
  });

  it('invalid p= without rua= means DMARC is not applied', () => {
    const p = parseDmarcRecord('v=DMARC1; p=bogus');
    expect(p).toMatchObject({ ok: false, isDmarc: true });
    expect(p.ok ? '' : p.reason).toMatch(/no valid rua=/);
  });

  it('bad optional tags fall back to defaults, with notes', () => {
    const p = parseDmarcRecord('v=DMARC1; p=none; adkim=x; pct=250; np=maybe');
    expect(p).toMatchObject({ ok: true, record: { adkim: 'r', pct: 100 } });
    expect(p.ok ? p.record.notes : []).toHaveLength(3);
  });
});

describe('policy discovery', () => {
  it('falls back from the From domain to the organizational domain', async () => {
    const dns = fakeDns({ '_dmarc.example.com': 'v=DMARC1; p=reject' });
    const lookup = await fetchDmarcPolicy(dns, 'mail.example.com');
    expect(lookup).toMatchObject({ kind: 'record', recordDomain: 'example.com', orgDomain: 'example.com' });
    expect(dns.queries).toEqual(['_dmarc.mail.example.com', '_dmarc.example.com']);
  });

  it('discards non-DMARC TXT records before counting', async () => {
    const dns = fakeDns({ '_dmarc.example.com': ['v=spf1 -all', 'v=DMARC1; p=quarantine', 'hello'] });
    expect(await fetchDmarcPolicy(dns, 'example.com')).toMatchObject({ kind: 'record', record: { p: 'quarantine' } });
  });

  it('interprets a @postroom/dns ResolverResult, SERVFAIL being a temperror', async () => {
    const dns: DmarcDns = {
      txt: () => Promise.resolve({ rcode: RCode.SERVFAIL, ad: false, answers: [], authority: [] }),
    };
    expect(await fetchDmarcPolicy(dns, 'example.com')).toMatchObject({ kind: 'temperror' });
  });
});

describe('evaluateDmarc: alignment', () => {
  const REJECT = { '_dmarc.example.com': 'v=DMARC1; p=reject' };

  it('relaxed SPF alignment: mail.example.com aligns with example.com', async () => {
    const r = await run(REJECT, { from: ['alice@example.com'], spf: spf('pass', 'mail.example.com') });
    expect(r.result).toBe('pass');
    expect(r.disposition).toBe('none');
    expect(r.alignment?.spf).toEqual({ mode: 'relaxed', result: 'pass', domain: 'mail.example.com', aligned: true });
    expect(r.authResults).toBe('dmarc=pass (p=reject sp=reject dis=none) header.from=example.com');
  });

  it('strict aspf=s: the same message fails', async () => {
    const r = await run(
      { '_dmarc.example.com': 'v=DMARC1; p=reject; aspf=s' },
      { from: ['alice@example.com'], spf: spf('pass', 'mail.example.com') },
    );
    expect(r.result).toBe('fail');
    expect(r.disposition).toBe('reject');
    expect(r.alignment?.spf.aligned).toBe(false);
    expect(r.reasons).toContain('SPF pass for mail.example.com is not strictly aligned with example.com');
  });

  it('relaxed DKIM alignment passes; adkim=s fails the same signature', async () => {
    const input = { from: ['alice@example.com'], dkim: [dkimPass('mail.example.com')] };
    const relaxed = await run(REJECT, input);
    expect(relaxed.result).toBe('pass');
    expect(relaxed.alignment?.dkim).toEqual({ mode: 'relaxed', alignedDomains: ['mail.example.com'], aligned: true });
    const strict = await run({ '_dmarc.example.com': 'v=DMARC1; p=reject; adkim=s' }, input);
    expect(strict.result).toBe('fail');
    expect(strict.alignment?.dkim.aligned).toBe(false);
  });

  it('strict DKIM alignment passes on an exact d=', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=reject; adkim=s' }, {
      from: ['alice@example.com'],
      dkim: [dkimPass('example.com')],
    });
    expect(r.result).toBe('pass');
  });

  it('relaxed alignment never crosses a public suffix (foo.github.io vs bar.github.io)', async () => {
    const r = await run({ '_dmarc.foo.github.io': 'v=DMARC1; p=reject' }, {
      from: ['x@foo.github.io'],
      dkim: [dkimPass('bar.github.io')],
    });
    expect(r.result).toBe('fail');
  });

  it('SPF pass but unaligned + DKIM fail → fail with p=reject disposition', async () => {
    const r = await run(REJECT, {
      from: ['alice@example.com'],
      spf: spf('pass', 'bounces.mailer.example.net'),
      dkim: [dkimFail('example.com')],
    });
    expect(r).toMatchObject({ result: 'fail', policy: 'reject', policySource: 'p', disposition: 'reject', sampled: true });
    expect(r.authResults).toBe('dmarc=fail (p=reject sp=reject dis=reject) header.from=example.com');
    expect(r.reasons).toEqual([
      'SPF pass for bounces.mailer.example.net is not relaxedly aligned with example.com',
      'DKIM fail for d=example.com: does not count',
      'neither SPF nor DKIM produced an aligned pass',
      'policy p=reject → disposition reject',
    ]);
  });

  it('a DKIM pass from a key in testing mode (t=y) does not count', async () => {
    const r = await run(REJECT, { from: ['alice@example.com'], dkim: [dkimPass('example.com', true)] });
    expect(r.result).toBe('fail');
    expect(r.reasons.join('\n')).toMatch(/testing mode \(t=y\): not counted/);
  });
});

describe('evaluateDmarc: which policy', () => {
  const ORG = { '_dmarc.example.com': 'v=DMARC1; p=reject; sp=quarantine' };

  it('p= applies to the organizational domain itself', async () => {
    const r = await run(ORG, { from: ['a@example.com'] });
    expect(r).toMatchObject({ result: 'fail', policy: 'reject', policySource: 'p', disposition: 'reject' });
  });

  it('sp= applies to subdomains', async () => {
    const r = await run(ORG, { from: ['a@news.example.com'] });
    expect(r).toMatchObject({
      result: 'fail',
      recordDomain: 'example.com',
      policy: 'quarantine',
      policySource: 'sp',
      disposition: 'quarantine',
    });
    expect(r.authResults).toBe('dmarc=fail (p=reject sp=quarantine dis=quarantine) header.from=news.example.com');
  });

  it('without sp=, subdomains get p=', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=reject' }, { from: ['a@news.example.com'] });
    expect(r).toMatchObject({ policy: 'reject', policySource: 'p' });
  });

  it("a subdomain's own record wins over the org's sp=", async () => {
    const r = await run({ ...ORG, '_dmarc.news.example.com': 'v=DMARC1; p=none' }, { from: ['a@news.example.com'] });
    expect(r).toMatchObject({ result: 'fail', recordDomain: 'news.example.com', policy: 'none', disposition: 'none' });
  });

  it('np= applies to a non-existent subdomain (RFC 9091)', async () => {
    const rec = { '_dmarc.example.com': 'v=DMARC1; p=none; sp=quarantine; np=reject' };
    const ghost = await run(rec, { from: ['a@ghost.example.com'] }, { exists: () => Promise.resolve(false) });
    expect(ghost).toMatchObject({ policy: 'reject', policySource: 'np', disposition: 'reject' });
    const real = await run(rec, { from: ['a@real.example.com'] }, { exists: () => Promise.resolve(true) });
    expect(real).toMatchObject({ policy: 'quarantine', policySource: 'sp' });
    const unknown = await run(rec, { from: ['a@x.example.com'] });
    expect(unknown).toMatchObject({ policySource: 'sp' });
    expect(unknown.reasons.join('\n')).toMatch(/existence is unknown; np= not applied/);
  });
});

describe('evaluateDmarc: pct sampling', () => {
  it('pct=0: reject is downgraded to quarantine', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=reject; pct=0' }, { from: ['a@example.com'], random: () => 0 });
    expect(r).toMatchObject({ result: 'fail', policy: 'reject', disposition: 'quarantine', sampled: false });
    expect(r.authResults).toBe('dmarc=fail (p=reject sp=reject dis=quarantine pct=0 not-sampled) header.from=example.com');
  });

  it('pct=0: quarantine is downgraded to none', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=quarantine; pct=0' }, { from: ['a@example.com'] });
    expect(r).toMatchObject({ disposition: 'none', sampled: false });
  });

  it('pct=50 uses the injected random source', async () => {
    const rec = { '_dmarc.example.com': 'v=DMARC1; p=reject; pct=50' };
    expect(await run(rec, { from: ['a@example.com'], random: () => 0.2 })).toMatchObject({ disposition: 'reject', sampled: true });
    expect(await run(rec, { from: ['a@example.com'], random: () => 0.7 })).toMatchObject({ disposition: 'quarantine', sampled: false });
  });

  it('a pass never draws', async () => {
    let draws = 0;
    await run({ '_dmarc.example.com': 'v=DMARC1; p=reject; pct=10' }, {
      from: ['a@example.com'],
      dkim: [dkimPass('example.com')],
      random: () => {
        draws++;
        return 0;
      },
    });
    expect(draws).toBe(0);
  });
});

describe('evaluateDmarc: none, temperror, permerror', () => {
  it('no record → none', async () => {
    const r = await run({}, { from: ['a@mail.example.com'] });
    expect(r).toMatchObject({ result: 'none', disposition: 'none' });
    expect(r.reasons).toEqual(['no DMARC record at _dmarc.mail.example.com or _dmarc.example.com']);
    expect(r.authResults).toBe(
      'dmarc=none (no DMARC record at _dmarc.mail.example.com or _dmarc.example.com) header.from=mail.example.com',
    );
  });

  it('two records → none', async () => {
    const r = await run({ '_dmarc.example.com': ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] }, { from: ['a@example.com'] });
    expect(r).toMatchObject({ result: 'none', disposition: 'none' });
    expect(r.reasons[0]).toMatch(/2 DMARC records/);
  });

  it('invalid p= and no rua= → none', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=maybe' }, { from: ['a@example.com'] });
    expect(r.result).toBe('none');
  });

  it('DNS failure → temperror (no fallback to the org domain)', async () => {
    const dns = fakeDns({ '_dmarc.mail.example.com': 'SERVFAIL', '_dmarc.example.com': 'v=DMARC1; p=reject' });
    const r = await evaluateDmarc({ dns, from: ['a@mail.example.com'], dkim: [] });
    expect(r).toMatchObject({ result: 'temperror', disposition: 'none' });
    expect(r.reasons[0]).toMatch(/DNS temporary failure/);
    expect(dns.queries).toEqual(['_dmarc.mail.example.com']);
  });

  it('no From header → permerror', async () => {
    expect(await run({}, { from: [] })).toMatchObject({ result: 'permerror', reasons: ['message has no From header'] });
  });

  it('a From address without a domain → permerror', async () => {
    expect(await run({}, { from: ['undisclosed'] })).toMatchObject({ result: 'permerror' });
  });

  it('several addresses in one From, same domain, evaluate normally', async () => {
    const r = await run({ '_dmarc.example.com': 'v=DMARC1; p=reject' }, {
      from: ['a@example.com, b@Example.COM'],
      dkim: [dkimPass('example.com')],
    });
    expect(r.result).toBe('pass');
  });
});

describe('multiple From (RFC 6376 §8.15, RFC 7489 §6.6.1)', () => {
  const RECORDS = {
    '_dmarc.example.com': 'v=DMARC1; p=reject',
    '_dmarc.paypal.example': 'v=DMARC1; p=quarantine',
  };

  it('two From fields → permerror, each domain failed per its policy, strictest wins', async () => {
    const r = await run(RECORDS, {
      from: ['ceo@paypal.example', 'alice@example.com'],
      dkim: [dkimPass('example.com')],
    });
    expect(r.result).toBe('permerror');
    expect(r.disposition).toBe('reject');
    expect(r.fromDomains).toEqual(['paypal.example', 'example.com']);
    expect(r.reasons[0]).toMatch(/^message has 2 From headers; alignment is ambiguous \(RFC 6376 §8\.15\)/);
    expect(r.perDomain?.map((p) => [p.fromDomain, p.result, p.disposition])).toEqual([
      ['paypal.example', 'fail', 'quarantine'],
      ['example.com', 'fail', 'reject'],
    ]);
    expect(r.authResults).toMatch(/^dmarc=permerror \(message has 2 From headers/);
  });

  it('two From fields in the same domain are still a failure per policy, even with an aligned pass', async () => {
    const r = await run(RECORDS, { from: ['ceo@example.com', 'noreply@example.com'], dkim: [dkimPass('example.com')] });
    expect(r).toMatchObject({ result: 'permerror', disposition: 'reject' });
  });

  it('one From field with two domains is a permerror too', async () => {
    const r = await run(RECORDS, { from: ['ceo@paypal.example, alice@example.com'], dkim: [dkimPass('example.com')] });
    expect(r).toMatchObject({ result: 'permerror', disposition: 'reject' });
    expect(r.reasons[0]).toMatch(/From header names 2 domains/);
  });

  it('with no policy published anywhere, the disposition stays none', async () => {
    const r = await run({}, { from: ['a@one.example', 'b@two.example'] });
    expect(r).toMatchObject({ result: 'permerror', disposition: 'none' });
  });

  it('end to end: a From injected above a validly signed one — DKIM notes it, DMARC rejects', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const original =
      'From: Alice <alice@example.com>\r\nTo: bob@example.org\r\nSubject: invoice\r\n' +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\nMessage-ID: <1@example.com>\r\n\r\nPay the usual account.\r\n';
    const sig = forgeSignature(original, {
      key: privateKey,
      algorithm: 'ed25519-sha256',
      domain: 'example.com',
      selector: 's1',
      headers: ['from', 'to', 'subject', 'date', 'message-id'],
    });
    const dkimDns = fakeDns({
      's1._domainkey.example.com': dnsRecordFor('ed25519-sha256', publicKey),
      ...RECORDS,
    });
    const verifier = createDkimVerifier({ dns: dkimDns, now: new Date('2026-09-25T12:00:00Z') });

    const clean = await verifier.verifyStream(Buffer.from(sig + original, 'latin1'));
    expect(clean[0]?.result).toBe('pass');
    expect(clean[0]?.reasons).toEqual([]);

    // The attacker's From goes on top; the signature still selects the bottom (original) From.
    const injected = `From: CEO <ceo@paypal.example>\r\n${sig}${original}`;
    const rs = await verifier.verifyStream(Buffer.from(injected, 'latin1'));
    expect(rs[0]?.result).toBe('pass');
    expect(rs[0]?.fromDomain).toBeUndefined();
    expect(rs[0]?.reasons).toEqual(['message has 2 From headers; alignment is ambiguous (RFC 6376 §8.15)']);

    const dmarc = await evaluateDmarc({
      dns: dkimDns,
      from: ['CEO <ceo@paypal.example>', 'Alice <alice@example.com>'],
      dkim: rs,
    });
    expect(dmarc).toMatchObject({ result: 'permerror', disposition: 'reject' });
    expect(dmarc.reasons[0]).toMatch(/2 From headers; alignment is ambiguous/);
  });

  it('DKIM notes a message with no From header', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const msg = 'From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n';
    const sig = forgeSignature(msg, { key: privateKey, algorithm: 'ed25519-sha256', domain: 'example.com', selector: 's1', headers: ['from', 'subject'] });
    const dns = fakeDns({ 's1._domainkey.example.com': dnsRecordFor('ed25519-sha256', publicKey) });
    const stripped = (sig + msg).replace('From: a@example.com\r\n', '');
    const rs = await createDkimVerifier({ dns }).verifyStream(Buffer.from(stripped, 'latin1'));
    expect(rs[0]?.reasons).toContain('message has no From header; alignment is impossible (RFC 5322 §3.6 requires one)');
  });
});
