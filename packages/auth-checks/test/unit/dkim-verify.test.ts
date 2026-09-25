import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ResolverResult } from '@postroom/dns';
import { describe, expect, it } from 'vitest';
import {
  authResultsDkim,
  createDkimVerifier,
  createDkimVerifierStream,
  dnsRecordFor,
  HeaderTooLargeError,
  signMessage,
  type DkimDns,
  type DkimResult,
  type DkimVerifierOptions,
} from '../../src/index.js';
import { fakeDns, forgeSignature, type ForgeOptions } from './fixtures/dkim/forge.js';
import { DNS_BRISBANE, DNS_TEST, SIGNED } from './fixtures/rfc8463.js';

const RFC8463_DNS = fakeDns({
  'brisbane._domainkey.football.example.com': DNS_BRISBANE,
  'test._domainkey.football.example.com': DNS_TEST,
});

const NOW = new Date('2026-09-25T12:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);

function verify(message: string, dns: DkimDns, extra: Partial<DkimVerifierOptions> = {}): Promise<DkimResult[]> {
  return createDkimVerifier({ dns, now: NOW, ...extra }).verifyStream(Buffer.from(message, 'latin1'));
}

const brief = (rs: readonly DkimResult[]): string[] => rs.map((r) => `${r.algorithm ?? '?'}:${r.result}`);

// ---------------------------------------------------------------------------------------------
// RFC vectors

describe('RFC 8463 Appendix A', () => {
  it('both published signatures pass with the A.2 DNS records', async () => {
    const rs = await verify(SIGNED, RFC8463_DNS);
    expect(brief(rs)).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
    const [ed, rsa] = rs;
    expect(ed).toMatchObject({
      index: 0,
      domain: 'football.example.com',
      selector: 'brisbane',
      identity: '@football.example.com',
      bodyHashMatches: true,
      testing: false,
      fromDomain: 'football.example.com',
      reasons: [],
    });
    // The A.2 RSA key is 1024 bits: accepted (RFC 8301), with a note.
    expect(rsa?.keyBits).toBe(1024);
    expect(rsa?.reasons).toEqual(['weak key: 1024-bit RSA (RFC 8301 recommends 2048)']);
    expect(RFC8463_DNS.queries).toContain('brisbane._domainkey.football.example.com');
  });

  it('writes Authentication-Results method strings', async () => {
    const rs = await verify(SIGNED, RFC8463_DNS);
    expect(authResultsDkim(rs)).toEqual([
      'dkim=pass header.d=football.example.com header.i=@football.example.com header.s=brisbane header.a=ed25519-sha256 header.b="/gCrinpc"',
      'dkim=pass (weak key: 1024-bit RSA [RFC 8301 recommends 2048]) header.d=football.example.com header.i=@football.example.com header.s=test header.a=rsa-sha256 header.b=F45dVWDf',
    ]);
    expect(authResultsDkim([])).toEqual(['dkim=none']);
  });

  it('flipping one body byte fails both with a body hash mismatch', async () => {
    const at = SIGNED.indexOf('hungry');
    const flipped = `${SIGNED.slice(0, at)}H${SIGNED.slice(at + 1)}`;
    const rs = await verify(flipped, RFC8463_DNS);
    expect(rs.map((r) => [r.result, r.bodyHashMatches, r.reasons[0]])).toEqual([
      ['fail', false, 'body hash mismatch'],
      ['fail', false, 'body hash mismatch'],
    ]);
  });

  it('changing the Subject fails both signatures (body hash still matches)', async () => {
    const rs = await verify(SIGNED.replace('Is dinner ready?', 'Is dinner ready!'), RFC8463_DNS);
    expect(rs.map((r) => [r.result, r.bodyHashMatches])).toEqual([
      ['fail', true],
      ['fail', true],
    ]);
    expect(rs[0]?.reasons[0]).toMatch(/^signature did not verify/);
  });
});

// RFC 6376 Appendix A.2's published signature is known not to verify (errata), and Appendix C's
// private key is not reproduced here, so the appendix message is signed with a fresh key using the
// appendix's exact tags (simple/simple, q=dns/txt, i= a subdomain of d=, Received signed).
const RFC6376_MESSAGE = [
  'Received: from client1.football.example.com  [192.0.2.1]',
  '      by submitserver.example.com with SUBMISSION;',
  '      Fri, 11 Jul 2003 21:01:54 -0700 (PDT)',
  'From: Joe SixPack <joe@football.example.com>',
  'To: Suzie Q <suzie@shopping.example.net>',
  'Subject: Is dinner ready?',
  'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
  'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
  '',
  'Hi.',
  '',
  'We lost the game. Are you hungry yet?',
  '',
  'Joe.',
  '',
].join('\r\n');

const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa1024 = generateKeyPairSync('rsa', { modulusLength: 1024 });
const rsa512 = generateKeyPairSync('rsa', { modulusLength: 512 });
const ed = generateKeyPairSync('ed25519');

const rsaTxt = (k: KeyObject, extra = ''): string => `${dnsRecordFor('rsa-sha256', k)}${extra}`;
const edTxt = (extra = ''): string => `${dnsRecordFor('ed25519-sha256', ed.publicKey)}${extra}`;

describe('RFC 6376 Appendix A message', () => {
  it('verifies with the appendix tags (simple/simple, i= under d=, Received signed)', async () => {
    const sig = forgeSignature(RFC6376_MESSAGE, {
      key: rsa2048.privateKey,
      algorithm: 'rsa-sha256',
      domain: 'example.com',
      selector: 'brisbane',
      canon: 'simple/simple',
      tags: { q: 'dns/txt', i: 'joe@football.example.com' },
      headers: ['Received', 'From', 'To', 'Subject', 'Date', 'Message-ID'],
    });
    const dns = fakeDns({ 'brisbane._domainkey.example.com': rsaTxt(rsa2048.publicKey) });
    const rs = await verify(sig + RFC6376_MESSAGE, dns);
    expect(rs).toEqual([
      expect.objectContaining({ result: 'pass', domain: 'example.com', identity: 'joe@football.example.com', keyBits: 2048, reasons: [] }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures shaped like real providers' mail

const GMAIL_LIKE = [
  'MIME-Version: 1.0',
  'From: Alice Example <alice@gmail.example>',
  'Date: Wed, 24 Sep 2026 09:15:02 -0700',
  'Message-ID: <CAF=x1Yq3kP0vQ@mail.gmail.example>',
  'Subject: Re: plans for Saturday',
  'To: matt@d3cloud.io',
  'Content-Type: multipart/alternative; boundary="000000000000a1b2c3"',
  '',
  '--000000000000a1b2c3',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Sounds good.  See you at 10?\t',
  '',
  '--000000000000a1b2c3',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div dir="ltr">Sounds good.  See you at 10?</div>',
  '',
  '--000000000000a1b2c3--',
  '',
].join('\r\n');

const SES_LIKE = [
  'From: Receipts <receipts@shop.example>',
  'To: matt@d3cloud.io',
  'Subject: Your order #10442',
  'Date: Thu, 25 Sep 2026 08:00:00 +0000',
  'Message-ID: <0100019281a8-5b1c@email.shop.example>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 7bit',
  'Feedback-ID: 1.us-east-1.abc=:AmazonSES',
  '',
  'Thanks for your order.',
  '',
].join('\r\n');

async function providerSigned(
  message: string,
  domain: string,
  canonicalization: 'simple/simple' | 'relaxed/simple' | 'relaxed/relaxed',
): Promise<{ text: string; dns: DkimDns }> {
  const sigs = await signMessage(Buffer.from(message, 'latin1'), {
    domain,
    now: NOW,
    canonicalization,
    keys: [
      { selector: 'sel-e', algorithm: 'ed25519-sha256', privateKey: ed.privateKey },
      { selector: 'sel-r', algorithm: 'rsa-sha256', privateKey: rsa2048.privateKey },
    ],
  });
  const dns = fakeDns({
    [`sel-e._domainkey.${domain}`]: edTxt(),
    [`sel-r._domainkey.${domain}`]: rsaTxt(rsa2048.publicKey),
  });
  return { text: sigs.join('') + message, dns };
}

describe('real-world shaped fixtures, signed with the package signer', () => {
  for (const c of ['simple/simple', 'relaxed/simple', 'relaxed/relaxed'] as const) {
    it(`gmail-like multipart, c=${c}: both pass, and still pass after hops add trace headers`, async () => {
      const { text, dns } = await providerSigned(GMAIL_LIKE, 'gmail.example', c);
      expect(brief(await verify(text, dns))).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
      const hopped = `Received: from mx.gmail.example by mx.d3cloud.io; Thu, 25 Sep 2026 12:00:00 +0000\r\nX-Original-To: matt@d3cloud.io\r\n${text}`;
      expect(brief(await verify(hopped, dns))).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
    });
  }

  it('ses-like relaxed/simple with Feedback-ID signed: pass; fromDomain set for DMARC', async () => {
    const { text, dns } = await providerSigned(SES_LIKE, 'shop.example', 'relaxed/simple');
    const rs = await verify(text, dns);
    expect(brief(rs)).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
    expect(rs.every((r) => r.fromDomain === 'shop.example' && r.domain === 'shop.example')).toBe(true);
  });

  it('oversigned From: a second From added in transit breaks both signatures', async () => {
    const { text, dns } = await providerSigned(SES_LIKE, 'shop.example', 'relaxed/relaxed');
    const rs = await verify(`From: attacker@evil.example\r\n${text}`, dns);
    expect(brief(rs)).toEqual(['ed25519-sha256:fail', 'rsa-sha256:fail']);
    expect(rs[0]?.fromDomain).toBeUndefined(); // two From headers: no single alignment input
  });

  it('multiple signatures are judged separately: valid Ed25519, broken RSA', async () => {
    const { text, dns } = await providerSigned(SES_LIKE, 'shop.example', 'relaxed/relaxed');
    // Corrupt the RSA signature's b= (second DKIM-Signature field).
    const rsaStart = text.indexOf('DKIM-Signature', 1);
    const bAt = text.indexOf(' b=', rsaStart) + 3;
    const ch = text[bAt] === 'A' ? 'B' : 'A';
    const broken = text.slice(0, bAt) + ch + text.slice(bAt + 1);
    const rs = await verify(broken, dns);
    expect(rs.map((r) => [r.algorithm, r.result, r.bodyHashMatches])).toEqual([
      ['ed25519-sha256', 'pass', true],
      ['rsa-sha256', 'fail', true],
    ]);
  });

  it('shares one body hasher between signatures with the same canonicalization', async () => {
    const { text, dns } = await providerSigned(SES_LIKE, 'shop.example', 'relaxed/relaxed');
    const v = createDkimVerifierStream({ dns, now: NOW });
    await pipeline(Readable.from([Buffer.from(text, 'latin1')]), v, sink());
    expect(brief(await v.results())).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
    expect(v.stats().bodyHashers).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Policy and error cases, with the test-only forger

const MSG = [
  'From: Bob <bob@example.org>',
  'To: matt@d3cloud.io',
  'Subject: hello',
  'Date: Thu, 25 Sep 2026 11:59:00 +0000',
  '',
  'Just a short body.',
  '',
].join('\r\n');
const H = ['from', 'to', 'subject', 'date'];

function forged(opts: Partial<ForgeOptions> = {}, message = MSG): string {
  return (
    forgeSignature(message, {
      key: ed.privateKey,
      algorithm: 'ed25519-sha256',
      domain: 'example.org',
      selector: 's1',
      headers: H,
      tags: { t: String(T - 60) },
      ...opts,
    }) + message
  );
}

const ED_DNS = fakeDns({ 's1._domainkey.example.org': edTxt() });

describe('verification policy', () => {
  it('a baseline forged Ed25519 signature passes', async () => {
    expect(brief(await verify(forged(), ED_DNS))).toEqual(['ed25519-sha256:pass']);
  });

  it('rsa-sha1 is a permerror (RFC 8301)', async () => {
    const dns = fakeDns({ 's1._domainkey.example.org': rsaTxt(rsa2048.publicKey) });
    const rs = await verify(forged({ algorithm: 'rsa-sha1', key: rsa2048.privateKey }), dns);
    expect(rs[0]).toMatchObject({ result: 'permerror', algorithm: 'rsa-sha1', domain: 'example.org' });
    expect(rs[0]?.reasons[0]).toMatch(/sha1 is not accepted/);
  });

  it('a key in testing mode (t=y) still verifies, flagged as testing', async () => {
    const dns = fakeDns({ 's1._domainkey.example.org': edTxt('; t=y') });
    const [r] = await verify(forged(), dns);
    expect(r).toMatchObject({ result: 'pass', testing: true, reasons: ['key is in testing mode (t=y)'] });
  });

  it('a revoked key (empty p=) fails', async () => {
    const dns = fakeDns({ 's1._domainkey.example.org': 'v=DKIM1; k=ed25519; p=' });
    const [r] = await verify(forged(), dns);
    expect(r).toMatchObject({ result: 'fail', reasons: ['key revoked (empty p=)'] });
  });

  it('an expired signature (x= in the past) fails with the expiry time', async () => {
    const [r] = await verify(forged({ tags: { t: String(T - 7200), x: String(T - 3600) } }), ED_DNS);
    expect(r?.result).toBe('fail');
    expect(r?.reasons).toEqual(['signature expired at 2026-09-25T11:00:00.000Z']);
  });

  it('x= inside the clock-skew allowance still passes', async () => {
    const [r] = await verify(forged({ tags: { t: String(T - 7200), x: String(T - 60) } }), ED_DNS);
    expect(r?.result).toBe('pass');
  });

  it('a timestamp far in the future is a permerror', async () => {
    const [r] = await verify(forged({ tags: { t: String(T + 86400) } }), ED_DNS);
    expect(r?.result).toBe('permerror');
    expect(r?.reasons[0]).toMatch(/in the future/);
  });

  it('i= not under d= is a permerror', async () => {
    const [r] = await verify(forged({ tags: { i: 'bob@evil.example' } }), ED_DNS);
    expect(r).toMatchObject({ result: 'permerror', domain: 'example.org' });
    expect(r?.reasons[0]).toMatch(/i= domain evil\.example is not d=/);
  });

  it('i= on a subdomain passes, but not when the key says t=s', async () => {
    const msg = forged({ tags: { i: 'bob@mail.example.org' } });
    expect((await verify(msg, ED_DNS))[0]?.result).toBe('pass');
    const strict = fakeDns({ 's1._domainkey.example.org': edTxt('; t=s') });
    const [r] = await verify(msg, strict);
    expect(r?.result).toBe('permerror');
    expect(r?.reasons[0]).toMatch(/t=s/);
  });

  for (const tag of ['bh', 'd', 's', 'h', 'a']) {
    it(`a missing required tag ${tag}= is a permerror`, async () => {
      const [r] = await verify(forged({ omit: tag }), ED_DNS);
      expect(r?.result).toBe('permerror');
      expect(r?.reasons).toEqual([`missing required tag ${tag}=`]);
    });
  }

  it('h= without From is a permerror', async () => {
    const [r] = await verify(forged({ headers: ['to', 'subject'] }), ED_DNS);
    expect(r).toMatchObject({ result: 'permerror', reasons: ['h= does not include From'] });
  });

  it('DNS SERVFAIL is a temperror', async () => {
    const dns = fakeDns({ 's1._domainkey.example.org': 'SERVFAIL' });
    const [r] = await verify(forged(), dns);
    expect(r?.result).toBe('temperror');
    expect(r?.reasons[0]).toMatch(/^DNS temporary failure looking up s1\._domainkey\.example\.org/);
  });

  it('NXDOMAIN for the key is a permerror (no key)', async () => {
    const [r] = await verify(forged(), fakeDns({}));
    expect(r).toMatchObject({ result: 'permerror', reasons: ['key record not found at s1._domainkey.example.org'] });
  });

  it('accepts a @postroom/dns ResolverResult: joins TXT strings, NXDOMAIN is no key, REFUSED is temporary', async () => {
    const txt = edTxt();
    const answer = (rcode: number, strings: string[] = []): ResolverResult => ({
      rcode,
      ad: false,
      authority: [],
      answers:
        strings.length === 0
          ? []
          : [{ kind: 'TXT', name: 's1._domainkey.example.org', ttl: 300, type: 16, class: 1, strings, text: strings.join('') }],
    });
    const resolver = (r: ResolverResult): DkimDns => ({ txt: () => Promise.resolve(r) });
    const split = [txt.slice(0, 20), txt.slice(20)];
    expect((await verify(forged(), resolver(answer(0, split))))[0]?.result).toBe('pass');
    expect((await verify(forged(), resolver(answer(3))))[0]?.result).toBe('permerror');
    expect((await verify(forged(), resolver(answer(5))))[0]?.result).toBe('temperror');
  });

  it('a 1024-bit RSA key passes with a weak-key reason; 512-bit is a permerror', async () => {
    const weak = await verify(
      forged({ algorithm: 'rsa-sha256', key: rsa1024.privateKey }),
      fakeDns({ 's1._domainkey.example.org': rsaTxt(rsa1024.publicKey) }),
    );
    expect(weak[0]).toMatchObject({ result: 'pass', keyBits: 1024, reasons: ['weak key: 1024-bit RSA (RFC 8301 recommends 2048)'] });
    const tiny = await verify(
      forged({ algorithm: 'rsa-sha256', key: rsa512.privateKey }),
      fakeDns({ 's1._domainkey.example.org': rsaTxt(rsa512.publicKey) }),
    );
    expect(tiny[0]).toMatchObject({ result: 'permerror', keyBits: 512, reasons: ['RSA key is 512 bits; at least 1024 required (RFC 8301)'] });
  });

  it('a key record of the wrong type, or restricted to sha1, is a permerror', async () => {
    const wrongType = fakeDns({ 's1._domainkey.example.org': rsaTxt(rsa2048.publicKey) });
    expect((await verify(forged(), wrongType))[0]?.reasons[0]).toBe('key type rsa does not match a=ed25519-sha256');
    const sha1Only = fakeDns({ 's1._domainkey.example.org': edTxt('; h=sha1') });
    expect((await verify(forged(), sha1Only))[0]?.reasons[0]).toMatch(/does not allow sha256/);
  });

  it('l=: content appended after the signed length still passes, with a note (a known DKIM risk)', async () => {
    const signed = forged({ length: 20 });
    const extended = `${signed}Appended by a list or an attacker.\r\n`;
    const [r] = await verify(extended, ED_DNS);
    expect(r?.result).toBe('pass');
    expect(r?.reasons[0]).toMatch(/^l=20 signs only 20 of \d+ body bytes; the rest is unsigned$/);
  });

  it('l= longer than the body fails', async () => {
    const signed = forged({ length: 20 });
    const truncated = signed.slice(0, signed.indexOf('Just a short body.')) + 'Just\r\n';
    const [r] = await verify(truncated, ED_DNS);
    expect(r?.result).toBe('fail');
    expect(r?.reasons[0]).toMatch(/^l=20 exceeds the canonical body length/);
  });

  it('only the first maxSignatures are evaluated; the rest are neutral', async () => {
    const one = forgeSignature(MSG, { key: ed.privateKey, algorithm: 'ed25519-sha256', domain: 'example.org', selector: 's1', headers: H });
    const rs = await verify(one + one + one + MSG, ED_DNS, { maxSignatures: 2 });
    expect(rs.map((r) => r.result)).toEqual(['pass', 'pass', 'neutral']);
    expect(rs[2]?.reasons[0]).toMatch(/only the first 2 signatures/);
    expect(ED_DNS.queries.filter((q) => q === 's1._domainkey.example.org').length).toBeGreaterThan(0);
  });

  it('looks each key up once per message even when signatures share it', async () => {
    const dns = fakeDns({ 's1._domainkey.example.org': edTxt() });
    const one = forgeSignature(MSG, { key: ed.privateKey, algorithm: 'ed25519-sha256', domain: 'example.org', selector: 's1', headers: H });
    await verify(one + one + MSG, dns);
    expect(dns.queries).toEqual(['s1._domainkey.example.org']);
  });

  it('an unsigned message yields no results', async () => {
    expect(await verify(MSG, ED_DNS)).toEqual([]);
  });

  it('a header block over the cap rejects with HeaderTooLargeError', async () => {
    const big = `X-Big: ${'a'.repeat(2000)}\r\n${forged()}`;
    await expect(verify(big, ED_DNS, { maxHeaderBytes: 1024 })).rejects.toBeInstanceOf(HeaderTooLargeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Whitespace re-folded in transit, written by hand

describe('re-folded whitespace', () => {
  const original = [
    'From: Carol <carol@example.org>',
    'To: matt@d3cloud.io',
    'Subject: Dinner on Friday at the usual place',
    'Date: Thu, 25 Sep 2026 11:00:00 +0000',
    '',
    'See you there. ',
    'Bring the  map.',
    '',
  ].join('\r\n');
  // What a mangling relay delivered: Subject re-folded, WSP runs changed, trailing space stripped,
  // an extra blank line at the end.
  const delivered = [
    'From: Carol <carol@example.org>',
    'To:  matt@d3cloud.io',
    'Subject: Dinner on Friday',
    '\tat the   usual place',
    'Date: Thu, 25 Sep 2026 11:00:00 +0000',
    '',
    'See you there.',
    'Bring the \tmap.',
    '',
    '',
  ].join('\r\n');

  it('relaxed/relaxed passes; simple/simple fails', async () => {
    const sign = (canon: 'relaxed/relaxed' | 'simple/simple', selector: string): string =>
      forgeSignature(original, { key: ed.privateKey, algorithm: 'ed25519-sha256', domain: 'example.org', selector, canon, headers: H });
    const sigs = sign('relaxed/relaxed', 'r') + sign('simple/simple', 's');
    const dns = fakeDns({ 'r._domainkey.example.org': edTxt(), 's._domainkey.example.org': edTxt() });
    expect((await verify(sigs + original, dns)).map((r) => r.result)).toEqual(['pass', 'pass']);
    const rs = await verify(sigs + delivered, dns);
    expect(rs.map((r) => [r.selector, r.result, r.bodyHashMatches])).toEqual([
      ['r', 'pass', true],
      ['s', 'fail', false],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The pass-through stream

describe('createDkimVerifierStream', () => {
  it('passes every byte through untouched and exposes results after finish', async () => {
    const input = Buffer.from(SIGNED, 'latin1');
    const out: Buffer[] = [];
    const v = createDkimVerifierStream({ dns: RFC8463_DNS, now: NOW });
    const chunks = [input.subarray(0, 7), input.subarray(7, 400), input.subarray(400, 401), input.subarray(401)];
    await pipeline(Readable.from(chunks), v, sink(out));
    expect(Buffer.concat(out).equals(input)).toBe(true);
    expect(brief(await v.results())).toEqual(['ed25519-sha256:pass', 'rsa-sha256:pass']);
  });

  it('results() rejects when the stream is destroyed before it ends', async () => {
    const v = createDkimVerifierStream({ dns: RFC8463_DNS, now: NOW });
    const errored = new Promise<Error>((resolve) => v.once('error', resolve));
    v.write(Buffer.from('From: a@b\r\n'));
    v.destroy(new Error('client went away'));
    await expect(v.results()).rejects.toThrow('client went away');
    expect((await errored).message).toBe('client went away');
  });
});

function sink(out?: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb): void {
      out?.push(Buffer.from(chunk));
      cb();
    },
  });
}
