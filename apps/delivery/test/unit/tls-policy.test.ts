// PST-T-7.5 / PST-REQ-126: outbound MTA-STS and DANE enforcement, end to end through the direct
// transport, with local fakes only — an in-memory resolver that sets AD where told to, a loopback
// HTTPS server serving policies under a test CA, and loopback fake MXes presenting (a) a CA-signed
// certificate for the MX name, (b) a self-signed one, (c) a CA-signed one for the wrong name, and
// (d) no STARTTLS at all.
//
// The acceptance line: "Test domain with bad cert defers."
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpClientError, type Connector } from '../../src/client/connection.js';
import { fakeResolver, startFakeMx, type FakeDns, type FakeMx } from '../../src/client/fake-mx.js';
import { createDirectTransport } from '../../src/client/transport.js';
import { memoryPolicyCache, type MtaStsCache } from '../../src/policy/index.js';
import type { DeliveryRequest, DeliveryResult } from '../../src/transports/types.js';
import { makeTestPki, type TestPki } from './helpers/pki.js';

const pki: TestPki | undefined = makeTestPki();

function request(domain: string): DeliveryRequest {
  return {
    envelopeFrom: 'me@d3cloud.io',
    domain,
    recipients: [{ id: 'r1', address: `you@${domain}`, notify: null }],
    message: () => Promise.resolve(Readable.from([Buffer.from('Subject: hi\r\n\r\nbody\r\n')])),
    size: 22,
    dsnRet: null,
    dsnEnvid: null,
    signal: new AbortController().signal,
  };
}

function spkiSha256(pem: string): Uint8Array {
  const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest();
}
function certSha256(pem: string): Uint8Array {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest();
}
function certSha512(pem: string): Uint8Array {
  return createHash('sha512').update(new X509Certificate(pem).raw).digest();
}

/** Every MX name the good certificate covers. */
const GOOD_NAMES = ['mx.enforce.test', 'mx.testing.test', 'mx.dane.test', 'mx.both.test', 'mx.cached.test'];

interface PolicyResponse { status?: number; type?: string; body: string; headers?: Record<string, string> }

describe.skipIf(pki === undefined)('outbound TLS policy (PST-REQ-126)', () => {
  const p = pki as TestPki;
  let goodMx: FakeMx;
  let selfSignedMx: FakeMx;
  let wrongNameMx: FakeMx;
  let plainMx: FakeMx;
  let policyServer: https.Server;
  let policyPort = 0;
  const policies = new Map<string, PolicyResponse>();
  const policyHits: string[] = [];
  let selfSigned: { key: string; cert: string };
  let good: { key: string; cert: string };
  const dialed: string[] = [];

  /** 127.0.0.1 good cert · .2 self-signed · .3 wrong name · .4 no STARTTLS · anything else refused. */
  const connector: Connector = (o) => {
    dialed.push(o.host);
    const port = { '127.0.0.1': goodMx.port, '127.0.0.2': selfSignedMx.port, '127.0.0.3': wrongNameMx.port, '127.0.0.4': plainMx.port }[o.host];
    if (port === undefined) return Promise.reject(new SmtpClientError('connect', 'connect', `${o.host}: ECONNREFUSED`));
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { resolve(s); });
      s.once('error', reject);
    });
  };

  const transport = (dns: FakeDns, cache: MtaStsCache = memoryPolicyCache(), extra: { dane?: boolean } = {}) => {
    const resolver = fakeResolver(dns);
    const t = createDirectTransport({
      resolver,
      connect: connector,
      random: () => 0,
      log: () => undefined,
      // The MX certificates chain to the test CA, standing in for the WebPKI roots.
      tlsOptions: { ca: p.ca.cert },
      mtaSts: { ca: p.ca.cert, port: policyPort, cache, timeoutMs: 2000 },
      ...extra,
    });
    return { t, resolver };
  };

  const policy = (mode: string, mx: string[], maxAge = 86400): string =>
    `version: STSv1\r\nmode: ${mode}\r\n${mx.map((m) => `mx: ${m}\r\n`).join('')}max_age: ${String(maxAge)}\r\n`;

  const sts = (domain: string, id = '20260926'): Record<string, string[]> => ({ [`_mta-sts.${domain}`]: [`v=STSv1; id=${id}`] });

  const mailSent = (mx: FakeMx): boolean => mx.sessions.some((s) => s.mailFrom !== null);

  const outcome = (r: DeliveryResult) => r.results['r1'];

  beforeAll(async () => {
    good = p.signed('good-mx', [...GOOD_NAMES, 'mx.enforce-bad.test']);
    // good-mx covers mx.enforce-bad.test too: the self-signed MX below is what makes that domain bad.
    selfSigned = p.selfSigned('self-mx', ['mx.enforce-bad.test', 'mx.testing.test', 'mx.dane.test']);
    const wrong = p.signed('wrong-mx', ['someone-else.test']);
    // DANE-TA needs the trust anchor in the presented chain: serve leaf + CA.
    goodMx = await startFakeMx({}, { key: good.key, cert: `${good.cert}${p.ca.cert}` });
    selfSignedMx = await startFakeMx({}, { key: selfSigned.key, cert: selfSigned.cert });
    wrongNameMx = await startFakeMx({}, { key: wrong.key, cert: wrong.cert });
    plainMx = await startFakeMx({});

    const stsNames = ['enforce-bad.test', 'enforce.test', 'wrongname.test', 'notls.test', 'rogue.test', 'testing.test', 'both.test', 'cached.test', 'redirect.test', 'html.test', 'none.test']
      .map((d) => `mta-sts.${d}`);
    const web = p.signed('mta-sts-web', stsNames);
    policyServer = https.createServer({ key: web.key, cert: web.cert }, (req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      policyHits.push(`${host}${req.url ?? ''}`);
      const entry = req.url === '/.well-known/mta-sts.txt' ? policies.get(host) : undefined;
      if (entry === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(entry.status ?? 200, { 'content-type': entry.type ?? 'text/plain', ...entry.headers }).end(entry.body);
    });
    await new Promise<void>((resolve) => { policyServer.listen(0, '127.0.0.1', resolve); });
    const address = policyServer.address();
    if (address === null || typeof address === 'string') throw new Error('policy server did not bind');
    policyPort = address.port;
  });

  afterAll(async () => {
    await Promise.all([goodMx.close(), selfSignedMx.close(), wrongNameMx.close(), plainMx.close()]);
    await new Promise<void>((resolve) => { policyServer.close(() => { resolve(); }); });
    p.cleanup();
  });

  describe('MTA-STS enforce', () => {
    it('ACCEPTANCE: an enforce domain whose MX presents a bad (self-signed) certificate defers, with the reason, and sends nothing', async () => {
      policies.set('mta-sts.enforce-bad.test', { body: policy('enforce', ['mx.enforce-bad.test']) });
      const before = selfSignedMx.sessions.length;
      const { t } = transport({
        mx: { 'enforce-bad.test': [{ preference: 10, exchange: 'mx.enforce-bad.test' }] },
        a: { 'mx.enforce-bad.test': ['127.0.0.2'], 'mta-sts.enforce-bad.test': ['127.0.0.1'] },
        txt: sts('enforce-bad.test'),
      });
      const result = await t.deliver(request('enforce-bad.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary', enhanced: '4.7.5' });
      const text = outcome(result)?.kind === 'temporary' ? (outcome(result) as { text: string }).text : '';
      expect(text).toMatch(/mta-sts-enforce requires verified TLS: certificate did not verify/);
      expect(result.details.tlsPeer).toMatch(/^tls-policy=mta-sts-enforce; policy-verified=no; policy-reason=certificate did not verify/);
      // The handshake happened (the session is recorded), but not one command crossed it.
      expect(selfSignedMx.sessions.length).toBeGreaterThan(before);
      expect(selfSignedMx.sessions.slice(before).every((s) => s.mailFrom === null)).toBe(true);
      expect(selfSignedMx.sessions.slice(before).flatMap((s) => s.transcript).filter((l) => l.startsWith('C: ')).map((l) => l.split(' ')[1]))
        .toEqual(['EHLO', 'STARTTLS']);
    });

    it('a CA-signed certificate for the wrong name defers too', async () => {
      policies.set('mta-sts.wrongname.test', { body: policy('enforce', ['mx.wrongname.test']) });
      const { t } = transport({
        mx: { 'wrongname.test': [{ preference: 10, exchange: 'mx.wrongname.test' }] },
        a: { 'mx.wrongname.test': ['127.0.0.3'], 'mta-sts.wrongname.test': ['127.0.0.1'] },
        txt: sts('wrongname.test'),
      });
      const result = await t.deliver(request('wrongname.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary', text: expect.stringMatching(/certificate did not verify|not valid for mx\.wrongname\.test/) as unknown });
      expect(mailSent(wrongNameMx)).toBe(false);
    });

    it('a certificate valid for the MX name under the trusted roots delivers, and says so', async () => {
      policies.set('mta-sts.enforce.test', { body: policy('enforce', ['*.enforce.test']) });
      const { t } = transport({
        mx: { 'enforce.test': [{ preference: 10, exchange: 'mx.enforce.test' }] },
        a: { 'mx.enforce.test': ['127.0.0.1'], 'mta-sts.enforce.test': ['127.0.0.1'] },
        txt: sts('enforce.test'),
      });
      const result = await t.deliver(request('enforce.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=mta-sts-enforce; policy-verified=yes; /);
    });

    it('STARTTLS not offered defers; nothing is sent in plaintext', async () => {
      policies.set('mta-sts.notls.test', { body: policy('enforce', ['mx.notls.test']) });
      const before = plainMx.sessions.length;
      const { t } = transport({
        mx: { 'notls.test': [{ preference: 10, exchange: 'mx.notls.test' }] },
        a: { 'mx.notls.test': ['127.0.0.4'], 'mta-sts.notls.test': ['127.0.0.1'] },
        txt: sts('notls.test'),
      });
      const result = await t.deliver(request('notls.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary', text: expect.stringMatching(/STARTTLS not offered/) as unknown });
      expect(result.details.tlsPeer).toMatch(/policy-verified=no; policy-reason=STARTTLS not offered/);
      expect(plainMx.sessions.slice(before).every((s) => s.mailFrom === null)).toBe(true);
    });

    it('an MX not in the policy is never dialled; when it is the only one, the domain defers', async () => {
      policies.set('mta-sts.rogue.test', { body: policy('enforce', ['mx.good.rogue.test']) });
      // Two MX hosts: the preferred one is outside the policy (an attacker's, say), the backup is in it.
      dialed.length = 0;
      const { t } = transport({
        mx: { 'rogue.test': [{ preference: 10, exchange: 'evil.example' }, { preference: 20, exchange: 'mx.good.rogue.test' }] },
        a: { 'evil.example': ['127.0.0.2'], 'mx.good.rogue.test': ['127.0.0.3'], 'mta-sts.rogue.test': ['127.0.0.1'] },
        txt: sts('rogue.test'),
      });
      await t.deliver(request('rogue.test'));
      expect(dialed).toEqual(['127.0.0.3']);

      dialed.length = 0;
      const { t: only } = transport({
        mx: { 'rogue.test': [{ preference: 10, exchange: 'evil.example' }] },
        a: { 'evil.example': ['127.0.0.1'], 'mta-sts.rogue.test': ['127.0.0.1'] },
        txt: sts('rogue.test'),
      });
      const result = await only.deliver(request('rogue.test'));
      expect(dialed).toEqual([]);
      expect(outcome(result)).toMatchObject({ kind: 'temporary', text: expect.stringMatching(/evil\.example is not in the MTA-STS policy/) as unknown });
      expect(result.details.tlsPeer).toMatch(/^tls-policy=mta-sts-enforce; policy-verified=no/);
    });
  });

  describe('MTA-STS testing and none', () => {
    it('testing mode delivers over the bad certificate but records what enforcement would have said', async () => {
      policies.set('mta-sts.testing.test', { body: policy('testing', ['mx.testing.test']) });
      const { t } = transport({
        mx: { 'testing.test': [{ preference: 10, exchange: 'mx.testing.test' }] },
        a: { 'mx.testing.test': ['127.0.0.2'], 'mta-sts.testing.test': ['127.0.0.1'] },
        txt: sts('testing.test'),
      });
      const result = await t.deliver(request('testing.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=mta-sts-testing; policy-verified=no; policy-reason=certificate did not verify/);
    });

    it('mode none is ignored: opportunistic, as before', async () => {
      policies.set('mta-sts.none.test', { body: 'version: STSv1\nmode: none\nmax_age: 60\n' });
      const { t } = transport({
        mx: { 'none.test': [{ preference: 10, exchange: 'mx.none.test' }] },
        a: { 'mx.none.test': ['127.0.0.2'], 'mta-sts.none.test': ['127.0.0.1'] },
        txt: sts('none.test'),
      });
      const result = await t.deliver(request('none.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=opportunistic; policy-verified=no/);
    });

    it('a policy behind a redirect, or not served as text/plain, is no policy at all', async () => {
      policies.set('mta-sts.redirect.test', { status: 301, body: '', headers: { location: 'https://mta-sts.enforce.test/.well-known/mta-sts.txt' } });
      policies.set('mta-sts.html.test', { type: 'text/html', body: policy('enforce', ['nothing.test']) });
      for (const domain of ['redirect.test', 'html.test']) {
        const { t } = transport({
          mx: { [domain]: [{ preference: 10, exchange: `mx.${domain}` }] },
          a: { [`mx.${domain}`]: ['127.0.0.2'], [`mta-sts.${domain}`]: ['127.0.0.1'] },
          txt: sts(domain),
        });
        const result = await t.deliver(request(domain));
        expect(outcome(result)?.kind).toBe('delivered');
      }
    });

    it('the policy fetch itself is held to the trust roots: an untrusted policy server is no policy', async () => {
      policies.set('mta-sts.enforce-bad.test', { body: policy('enforce', ['mx.enforce-bad.test']) });
      const resolver = fakeResolver({
        mx: { 'enforce-bad.test': [{ preference: 10, exchange: 'mx.enforce-bad.test' }] },
        a: { 'mx.enforce-bad.test': ['127.0.0.2'], 'mta-sts.enforce-bad.test': ['127.0.0.1'] },
        txt: sts('enforce-bad.test'),
      });
      // No `ca`: the system roots, which have never heard of the test CA.
      const t = createDirectTransport({ resolver, connect: connector, log: () => undefined, mtaSts: { port: policyPort, timeoutMs: 2000 } });
      const result = await t.deliver(request('enforce-bad.test'));
      expect(outcome(result)?.kind).toBe('delivered');
    });

    it('caches the policy by id: an unchanged id is not refetched, a new id is', async () => {
      policies.set('mta-sts.cached.test', { body: policy('enforce', ['mx.cached.test']) });
      const cache = memoryPolicyCache();
      const dns = (id: string): FakeDns => ({
        mx: { 'cached.test': [{ preference: 10, exchange: 'mx.cached.test' }] },
        a: { 'mx.cached.test': ['127.0.0.1'], 'mta-sts.cached.test': ['127.0.0.1'] },
        txt: sts('cached.test', id),
      });
      const hits = (): number => policyHits.filter((h) => h.startsWith('mta-sts.cached.test')).length;
      const start = hits();
      await transport(dns('one'), cache).t.deliver(request('cached.test'));
      await transport(dns('one'), cache).t.deliver(request('cached.test'));
      expect(hits() - start).toBe(1);
      await transport(dns('two'), cache).t.deliver(request('cached.test'));
      expect(hits() - start).toBe(2);
      // The TXT record vanishing (stripped by an attacker?) leaves the cached enforce policy in force.
      policies.set('mta-sts.cached.test', { body: policy('enforce', ['mx.cached.test']) });
      const stripped: FakeDns = { mx: { 'cached.test': [{ preference: 10, exchange: 'mx.cached.test' }] }, a: { 'mx.cached.test': ['127.0.0.2'] } };
      const result = await transport(stripped, cache).t.deliver(request('cached.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary' });
      expect(result.details.tlsPeer).toMatch(/^tls-policy=mta-sts-enforce; policy-verified=no/);
    });
  });

  describe('DANE', () => {
    const daneDns = (records: { usage: number; selector: number; matchingType: number; data: Uint8Array }[] | 'servfail', ip: string, secure = ['dane.test', 'mx.dane.test', '_25._tcp.mx.dane.test']): FakeDns => ({
      mx: { 'dane.test': [{ preference: 10, exchange: 'mx.dane.test' }] },
      a: { 'mx.dane.test': [ip] },
      tlsa: { '_25._tcp.mx.dane.test': records },
      secure,
    });

    it('DANE-EE 3 1 1 matching the self-signed leaf delivers (names and issuer do not matter)', async () => {
      const { t } = transport(daneDns([{ usage: 3, selector: 1, matchingType: 1, data: spkiSha256(selfSigned.cert) }], '127.0.0.2'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=dane; policy-verified=yes; policy-reason=DANE-EE 3 1 1 matched the leaf/);
    });

    it('DANE-EE 3 0 1 and 3 0 2 (full certificate, SHA-256 and SHA-512) match too', async () => {
      for (const rec of [{ usage: 3, selector: 0, matchingType: 1, data: certSha256(selfSigned.cert) }, { usage: 3, selector: 0, matchingType: 2, data: certSha512(selfSigned.cert) }]) {
        const { t } = transport(daneDns([rec], '127.0.0.2'));
        expect(outcome(await t.deliver(request('dane.test')))?.kind).toBe('delivered');
      }
    });

    it('DANE-TA 2 0 1 matching the CA in the presented chain delivers when the leaf names the MX', async () => {
      const { t } = transport(daneDns([{ usage: 2, selector: 0, matchingType: 1, data: certSha256(p.ca.cert) }], '127.0.0.1'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=dane; policy-verified=yes; policy-reason=DANE-TA 2 0 1 matched/);
    });

    it('a TLSA mismatch defers with the reason, and nothing is sent', async () => {
      const before = goodMx.sessions.length;
      const { t } = transport(daneDns([{ usage: 3, selector: 1, matchingType: 1, data: spkiSha256(selfSigned.cert) }], '127.0.0.1'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary', enhanced: '4.7.5', text: expect.stringMatching(/dane requires verified TLS: DANE: no TLSA record \(3 1 1\) matched/) as unknown });
      expect(result.details.tlsPeer).toMatch(/^tls-policy=dane; policy-verified=no/);
      expect(goodMx.sessions.slice(before).every((s) => s.mailFrom === null)).toBe(true);
    });

    it('DANE-TA whose leaf does not name the MX defers', async () => {
      const { t } = transport(daneDns([{ usage: 2, selector: 0, matchingType: 1, data: certSha256(p.ca.cert) }], '127.0.0.3'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary' });
    });

    it('STARTTLS not offered under DANE defers', async () => {
      const { t } = transport(daneDns([{ usage: 3, selector: 1, matchingType: 1, data: spkiSha256(selfSigned.cert) }], '127.0.0.4'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)).toMatchObject({ kind: 'temporary', text: expect.stringMatching(/dane requires verified TLS: STARTTLS not offered/) as unknown });
    });

    it('without the AD bit the TLSA records are ignored (and an unsigned MX means no TLSA query at all)', async () => {
      const mismatched = [{ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) }];
      const unsignedMx = transport(daneDns(mismatched, '127.0.0.2', []));
      expect(outcome(await unsignedMx.t.deliver(request('dane.test')))?.kind).toBe('delivered');
      expect(unsignedMx.resolver.queries.filter((q) => q.type === 'TLSA')).toEqual([]);

      const unsignedTlsa = transport(daneDns(mismatched, '127.0.0.2', ['dane.test', 'mx.dane.test']));
      const result = await unsignedTlsa.t.deliver(request('dane.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(unsignedTlsa.resolver.queries.filter((q) => q.type === 'TLSA')).toHaveLength(1);
      expect(result.details.tlsPeer).toMatch(/^tls-policy=opportunistic/);
    });

    it('an unsigned address record for the MX host also keeps DANE off', async () => {
      const { t } = transport(daneDns([{ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) }], '127.0.0.2', ['dane.test', '_25._tcp.mx.dane.test']));
      expect(outcome(await t.deliver(request('dane.test')))?.kind).toBe('delivered');
    });

    it('only unusable records (PKIX-EE, bad digest length) fall back to opportunistic', async () => {
      const { t } = transport(daneDns([
        { usage: 1, selector: 1, matchingType: 1, data: new Uint8Array(32) },
        { usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(20) },
      ], '127.0.0.2'));
      const result = await t.deliver(request('dane.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=opportunistic/);
    });

    it('an unusable record beside a usable mismatching one still defers', async () => {
      const { t } = transport(daneDns([
        { usage: 1, selector: 1, matchingType: 1, data: spkiSha256(selfSigned.cert) },
        { usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) },
      ], '127.0.0.2'));
      expect(outcome(await t.deliver(request('dane.test')))).toMatchObject({ kind: 'temporary' });
    });

    it('a failed (SERVFAIL) TLSA lookup under a signed MX makes the host unusable: deferred, never dialled', async () => {
      dialed.length = 0;
      const { t } = transport(daneDns('servfail', '127.0.0.2'));
      const result = await t.deliver(request('dane.test'));
      expect(dialed).toEqual([]);
      expect(outcome(result)).toMatchObject({ kind: 'temporary', text: expect.stringMatching(/TLSA lookup .* failed/) as unknown });
      expect(result.details.tlsPeer).toMatch(/^tls-policy=dane; policy-verified=no/);
    });

    it('DANE takes precedence over MTA-STS (RFC 8461 §2): a DANE host outside the STS mx list still delivers', async () => {
      policies.set('mta-sts.both.test', { body: policy('enforce', ['mx.other.test']) });
      const { t } = transport({
        mx: { 'both.test': [{ preference: 10, exchange: 'mx.both.test' }] },
        a: { 'mx.both.test': ['127.0.0.2'], 'mta-sts.both.test': ['127.0.0.1'] },
        txt: sts('both.test'),
        tlsa: { '_25._tcp.mx.both.test': [{ usage: 3, selector: 1, matchingType: 1, data: spkiSha256(selfSigned.cert) }] },
        secure: ['both.test', 'mx.both.test', '_25._tcp.mx.both.test'],
      });
      const result = await t.deliver(request('both.test'));
      expect(outcome(result)?.kind).toBe('delivered');
      expect(result.details.tlsPeer).toMatch(/^tls-policy=dane; policy-verified=yes/);
    });

    it('dane: false turns DANE off', async () => {
      const { t, resolver } = transport(daneDns([{ usage: 3, selector: 1, matchingType: 1, data: new Uint8Array(32) }], '127.0.0.2'), memoryPolicyCache(), { dane: false });
      expect(outcome(await t.deliver(request('dane.test')))?.kind).toBe('delivered');
      expect(resolver.queries.filter((q) => q.type === 'TLSA')).toEqual([]);
    });
  });

  it('with no policy at all, an unverifiable certificate is still delivered over (opportunistic, as before)', async () => {
    const { t } = transport({ mx: { 'plain.test': [{ preference: 10, exchange: 'mx.plain.test' }] }, a: { 'mx.plain.test': ['127.0.0.2'] } });
    const result = await t.deliver(request('plain.test'));
    expect(outcome(result)?.kind).toBe('delivered');
    expect(result.details.tlsPeer).toMatch(/^tls-policy=opportunistic; policy-verified=no/);
    expect(mailSent(selfSignedMx)).toBe(true);
  });
});
