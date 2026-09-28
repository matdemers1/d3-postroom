// PST-T-0.15 (PST-REQ-020): the ACME DNS-01 job end to end against a fake RFC 8555 server that
// verifies every JWS, a fake Cloudflare API scoped to the challenge zone, and fake DNS. No real
// network: everything is 127.0.0.1 on ephemeral ports.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertMessage } from '@postroom/alerts';
import { cloudflareDnsApi } from '../../../src/acme/cloudflare.js';
import type { AcmeConfig } from '../../../src/acme/config.js';
import { runAcme, failureBackoffMs, type AcmeDeps } from '../../../src/acme/job.js';
import { memoryAcmeStore } from '../../../src/acme/state.js';
import { fakeDns, startFakeAcme, startFakeCloudflare, type FakeAcme, type FakeCloudflare } from './fakes.js';

const TOKEN = 'cf-test-token-not-a-secret';
const ZONE_ID = '02dd41cac36fabf2542ac1b3527a618b';
const ZONE = 'bigfluffymurderbuffalo.com';
const TARGET = 'mx.d3cloud.io.bigfluffymurderbuffalo.com';

let dir: string;
let cf: FakeCloudflare;
let acme: FakeAcme;
let dns: ReturnType<typeof fakeDns>;
const servers: { close: () => Promise<void> }[] = [];

function config(over: Partial<AcmeConfig> = {}): AcmeConfig {
  return {
    enabled: true,
    missing: [],
    token: TOKEN,
    challengeZone: ZONE,
    challengeZoneId: ZONE_ID,
    domains: ['mx.d3cloud.io'],
    directoryUrl: acme.directoryUrl,
    stagingDirectoryUrl: null,
    certDir: dir,
    renewDays: 30,
    contact: [],
    dnsResolver: '',
    dnsWaitMs: 60_000,
    ...over,
  };
}

function deps(over: Partial<AcmeDeps> = {}): AcmeDeps & { alerts: AlertMessage[]; store: ReturnType<typeof memoryAcmeStore> } {
  const alerts: AlertMessage[] = [];
  const store = memoryAcmeStore();
  return {
    config: config(),
    store,
    dns,
    dnsApi: cloudflareDnsApi({ token: TOKEN, zoneId: ZONE_ID, baseUrl: cf.baseUrl }),
    sendAlert: (m) => {
      alerts.push(m);
      return Promise.resolve({ sent: true });
    },
    sleep: () => Promise.resolve(),
    certKeyType: 'ec',
    ...over,
    alerts,
  } as AcmeDeps & { alerts: AlertMessage[]; store: ReturnType<typeof memoryAcmeStore> };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acme-'));
  cf = await startFakeCloudflare({ token: TOKEN, zoneId: ZONE_ID });
  dns = fakeDns(cf);
  acme = await startFakeAcme({ dns });
  servers.push(cf, acme);
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ACME DNS-01 job (PST-T-0.15, PST-REQ-020)', () => {
  it('issues the certificate: JWS verified by the CA, TXT at the CNAME target, pair written and matching, TXT removed', async () => {
    const d = deps();
    const result = await runAcme(d);
    expect(result).toMatchObject({ ok: true, action: 'issued', certFile: join(dir, 'mx.d3cloud.io', 'fullchain.pem') });

    // newAccount by jwk, everything after by kid — and every request's signature verified.
    expect(acme.log[0]).toMatchObject({ path: '/new-account', identity: 'jwk', payload: { termsOfServiceAgreed: true } });
    expect(acme.log.slice(1).every((r) => r.identity === 'kid')).toBe(true);
    expect(acme.log.map((r) => r.path)).toEqual(expect.arrayContaining(['/new-order', '/finalize/1', '/cert/1']));

    // The TXT went to the delegation target inside the challenge zone, and is gone afterwards.
    const created = cf.ops.filter((o) => o.op === 'create');
    expect(created).toEqual([expect.objectContaining({ name: TARGET })]);
    expect(cf.ops.filter((o) => o.op === 'delete').map((o) => o.id)).toEqual([created[0]?.id]);
    expect(cf.records.size).toBe(0);

    const certPem = await readFile(join(dir, 'mx.d3cloud.io', 'fullchain.pem'), 'utf8');
    const keyPem = await readFile(join(dir, 'mx.d3cloud.io', 'privkey.pem'), 'utf8');
    const leaf = new X509Certificate(certPem);
    expect(leaf.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(leaf.subjectAltName).toBe('DNS:mx.d3cloud.io');
    expect(certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect((await stat(join(dir, 'mx.d3cloud.io', 'privkey.pem'))).mode & 0o777).toBe(0o640);
    expect(acme.finalizedCsr).toMatchObject({ cn: 'mx.d3cloud.io', sans: ['mx.d3cloud.io'], signatureValid: true });

    expect(d.store.audits.map((a) => a.action)).toEqual(['acme.account-key.create', 'tls.certificate.issue']);
    expect(await d.store.readLast()).toMatchObject({ ok: true, action: 'issued', consecutiveFailures: 0 });
    expect(d.store.lease).toBeNull();
    expect(d.alerts).toEqual([]);

    // A second run finds a fresh certificate and does nothing; --force renews with the same account.
    const again = await runAcme(d);
    expect(again).toMatchObject({ ok: true, action: 'not-due' });
    expect(acme.orders).toBe(1);
    const forced = await runAcme(d, { force: true });
    expect(forced).toMatchObject({ ok: true, action: 'renewed' });
    expect(acme.accountsCreated).toBe(1);
    expect(d.store.audits.at(-1)).toMatchObject({ action: 'tls.certificate.renew', before: expect.objectContaining({ domains: ['mx.d3cloud.io'] }) as unknown });
  });

  it('issues an RSA-2048 certificate key by default', async () => {
    const d = deps();
    delete (d as { certKeyType?: string }).certKeyType;
    const result = await runAcme(d);
    expect(result.ok).toBe(true);
    const key = createPrivateKey(await readFile(join(dir, 'mx.d3cloud.io', 'privkey.pem')));
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('waits for every authoritative nameserver to serve the TXT before responding', async () => {
    dns.state.lag.set('198.51.100.53', 3);
    const result = await runAcme(deps());
    expect(result.ok).toBe(true);
    // 2 servers x (3 lagging checks + 1 good) = at least 8 queries before the challenge was answered.
    expect(dns.state.txtCalls).toBeGreaterThanOrEqual(8);
  });

  it('retries once on badNonce, with the nonce the error carried', async () => {
    acme.badNonceAnswers = 0;
    await acme.close();
    acme = await startFakeAcme({ dns, badNonces: 1 });
    servers.push(acme);
    const result = await runAcme(deps({ config: config({ directoryUrl: acme.directoryUrl }) }));
    expect(result.ok).toBe(true);
    expect(acme.badNonceAnswers).toBe(1);
  });

  it('gives up on a second badNonce in a row for the same request', async () => {
    await acme.close();
    acme = await startFakeAcme({ dns, badNonces: 2 });
    servers.push(acme);
    const result = await runAcme(deps({ config: config({ directoryUrl: acme.directoryUrl }) }));
    expect(result).toMatchObject({ ok: false, action: 'failed' });
    expect(result.reason).toContain('badNonce');
  });

  it('always deletes the TXT when validation fails, records the failure, backs off and alerts', async () => {
    // The CA sees nothing at the target: the challenge goes invalid after the TXT was created.
    const blind = fakeDns(cf, { cnames: new Map([['_acme-challenge.mx.d3cloud.io', 'elsewhere.bigfluffymurderbuffalo.com']]) });
    await acme.close();
    acme = await startFakeAcme({ dns: blind });
    servers.push(acme);
    const now = new Date('2026-09-28T12:00:00Z');
    const d = deps({ config: config({ directoryUrl: acme.directoryUrl }), now: () => now });
    const result = await runAcme(d);
    expect(result).toMatchObject({ ok: false, action: 'failed' });
    expect(result.reason).toMatch(/invalid.*No TXT record/);
    expect(cf.ops.filter((o) => o.op === 'create')).toHaveLength(1);
    expect(cf.records.size).toBe(0);
    expect(d.store.lease).toBeNull();

    expect(await d.store.readLast()).toMatchObject({ ok: false, consecutiveFailures: 1, nextAttemptAt: new Date(now.getTime() + 3_600_000).toISOString() });
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]?.subject).toContain('renewal failed');
    expect(d.alerts[0]?.text).not.toContain(TOKEN);

    // Within the back-off a scheduled run does not touch the CA; --force does.
    const orders = acme.orders;
    expect(await runAcme(d)).toMatchObject({ ok: false, action: 'backoff' });
    expect(acme.orders).toBe(orders);
    await runAcme(d, { force: true });
    expect(acme.orders).toBe(orders + 1);
    expect(await d.store.readLast()).toMatchObject({ consecutiveFailures: 2 });
  });

  it('deletes the TXT when it never propagates, without asking the CA to validate', async () => {
    dns.state.neverVisible = true;
    let t = Date.parse('2026-09-28T12:00:00Z');
    const d = deps({ now: () => new Date((t += 10_000)) });
    const result = await runAcme(d);
    expect(result).toMatchObject({ ok: false, action: 'failed' });
    expect(result.reason).toContain('did not appear');
    expect(cf.records.size).toBe(0);
    expect(acme.log.some((r) => r.path.startsWith('/chall/'))).toBe(false);
  });

  it('still reports the original failure when the TXT delete itself fails', async () => {
    dns.state.neverVisible = true;
    cf.failDelete = true;
    let t = 0;
    const result = await runAcme(deps({ now: () => new Date((t += 10_000)) }));
    expect(result.reason).toContain('did not appear');
    expect(cf.ops.some((o) => o.op === 'delete')).toBe(true);
  });

  it('refuses a CNAME target outside the challenge zone and writes nothing', async () => {
    dns.state.cnames.set('_acme-challenge.mx.d3cloud.io', 'mx.d3cloud.io');
    const result = await runAcme(deps());
    expect(result).toMatchObject({ ok: false, action: 'failed' });
    expect(result.reason).toContain('outside the challenge zone');
    expect(cf.ops.filter((o) => o.op === 'create')).toHaveLength(0);
  });

  it('refuses a look-alike zone suffix (evilbigfluffymurderbuffalo.com)', async () => {
    dns.state.cnames.set('_acme-challenge.mx.d3cloud.io', 'mx.evilbigfluffymurderbuffalo.com');
    const result = await runAcme(deps());
    expect(result.reason).toContain('outside the challenge zone');
    expect(cf.ops).toEqual([]);
  });

  it('refuses when _acme-challenge has no CNAME at all', async () => {
    dns.state.cnames.clear();
    const result = await runAcme(deps());
    expect(result.reason).toContain('has no CNAME');
    expect(cf.ops).toEqual([]);
  });

  it('sweeps a TXT a crashed run left behind before creating its own', async () => {
    const api = cloudflareDnsApi({ token: TOKEN, zoneId: ZONE_ID, baseUrl: cf.baseUrl });
    await api.createTxt(TARGET, 'left-over');
    const result = await runAcme(deps());
    expect(result.ok).toBe(true);
    expect(cf.records.size).toBe(0);
  });

  it('runs Let\'s Encrypt staging first, into staging/, before production is ever used', async () => {
    const staging = await startFakeAcme({ dns });
    servers.push(staging);
    const d = deps({ config: config({ stagingDirectoryUrl: staging.directoryUrl }) });
    const result = await runAcme(d);
    expect(result).toMatchObject({ ok: true, action: 'issued', stagingGate: expect.any(Object) as unknown });
    expect(staging.orders).toBe(1);
    expect(acme.orders).toBe(1);
    expect((await readdir(join(dir, 'staging', 'mx.d3cloud.io'))).sort()).toEqual(['fullchain.pem', 'privkey.pem']);
    expect(await d.store.readStaging()).not.toBeNull();
    // Once passed, production renewals never go back to staging.
    await runAcme(d, { force: true });
    expect(staging.orders).toBe(1);
    expect(acme.orders).toBe(2);
  });

  it('does not touch production when the staging gate fails', async () => {
    const staging = await startFakeAcme({ dns, badNonces: 2 });
    servers.push(staging);
    const d = deps({ config: config({ stagingDirectoryUrl: staging.directoryUrl }) });
    const result = await runAcme(d);
    expect(result).toMatchObject({ ok: false, action: 'failed' });
    expect(acme.log).toEqual([]);
    expect(await d.store.readStaging()).toBeNull();
  });

  it('a --staging run writes under staging/ and leaves the live pair alone', async () => {
    const d = deps();
    const result = await runAcme(d, { staging: true });
    expect(result).toMatchObject({ ok: true, certFile: join(dir, 'staging', 'mx.d3cloud.io', 'fullchain.pem') });
    await expect(stat(join(dir, 'mx.d3cloud.io'))).rejects.toThrow();
    expect(await d.store.readLast()).toBeNull();
  });

  it('does not run while another holder has the lease', async () => {
    const d = deps();
    await d.store.acquire('someone-else', 60_000, new Date());
    expect(await runAcme(d)).toMatchObject({ ok: false, action: 'busy' });
    expect(acme.log).toEqual([]);
  });

  it('is off without ACME_DNS_TOKEN / ACME_DOMAINS', async () => {
    const d = deps({ config: config({ enabled: false, missing: ['ACME_DNS_TOKEN'] }) });
    expect(await runAcme(d)).toMatchObject({ ok: false, action: 'disabled' });
  });

  it('alerts as urgent when renewal fails inside the last 14 days', async () => {
    dns.state.cnames.clear();
    const { makePair } = await import('./fakes.js');
    const pair = makePair(['mx.d3cloud.io'], 10);
    const { installPair } = await import('../../../src/acme/files.js');
    await installPair({ dir: join(dir, 'mx.d3cloud.io'), cert: join(dir, 'mx.d3cloud.io', 'fullchain.pem'), key: join(dir, 'mx.d3cloud.io', 'privkey.pem') }, pair);
    const d = deps();
    const result = await runAcme(d);
    expect(result.ok).toBe(false);
    expect(d.alerts[0]?.key).toBe('acme-renewal-failing-urgent');
    expect(d.alerts[0]?.subject).toMatch(/expires in (9|10)\.\d days and renewal keeps failing/);
  });

  it('backs off 1 h, 3 h, 6 h, 12 h, then a day', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => failureBackoffMs(n) / 3_600_000)).toEqual([1, 3, 6, 12, 24, 24]);
  });

  it('the scoped token is refused outside its zone, and the error never carries the token', async () => {
    const api = cloudflareDnsApi({ token: TOKEN, zoneId: 'd3cloud-zone-id', baseUrl: cf.baseUrl });
    const error = await api.createTxt('_acme-challenge.mx.d3cloud.io', 'x').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
