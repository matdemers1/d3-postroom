// PST-T-0.15: the ACME job's building blocks — DER, JWS/thumbprint, CSR, the renewal decision,
// the atomic write, configuration and the CLI's arguments.
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { parseArgs } from '../../../src/acme/cli.js';
import { acmeConfig, certPaths, LE_PRODUCTION, LE_STAGING } from '../../../src/acme/config.js';
import { buildCsr, generateCertificateKey } from '../../../src/acme/csr.js';
import { integer, oid, tlv, setOf } from '../../../src/acme/der.js';
import { isInZone } from '../../../src/acme/dns.js';
import { installPair, readExisting, renewalReason, writeFileAtomic } from '../../../src/acme/files.js';
import { dns01TxtValue, generateAccountKey, jwkThumbprint, keyAuthorization, publicJwk, signJws } from '../../../src/acme/jws.js';
import { buildMonitors } from '../../../src/monitors/index.js';
import { makePair, parseCsr } from './fakes.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acme-p-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DER writer', () => {
  it('encodes known vectors', () => {
    expect(oid('1.2.840.113549.1.1.11').toString('hex')).toBe('06092a864886f70d01010b');
    expect(oid('2.5.29.17').toString('hex')).toBe('0603551d11');
    expect(integer(0).toString('hex')).toBe('020100');
    expect(integer(127).toString('hex')).toBe('02017f');
    expect(integer(128).toString('hex')).toBe('02020080');
    expect(integer(256).toString('hex')).toBe('02020100');
    expect(tlv(0x04, Buffer.alloc(200)).subarray(0, 3).toString('hex')).toBe('0481c8');
    expect(tlv(0x04, Buffer.alloc(300)).subarray(0, 4).toString('hex')).toBe('0482012c');
    expect(setOf(Buffer.of(0x02, 0x01, 0x05), Buffer.of(0x02, 0x01, 0x01)).toString('hex')).toBe('3106020101020105');
  });
});

describe('JOSE (RFC 7515/7638/8555)', () => {
  it('matches the RFC 7638 §3.1 thumbprint test vector', () => {
    const jwk = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
      alg: 'RS256',
      kid: '2011-04-29',
    };
    expect(jwkThumbprint(jwk)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('derives the dns-01 TXT value from the key authorization (RFC 8555 §8.1, §8.4)', () => {
    const key = generateAccountKey();
    const jwk = publicJwk(key);
    expect(Object.keys(jwk)).toEqual(['crv', 'kty', 'x', 'y']);
    const ka = keyAuthorization('evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA', jwk);
    expect(ka).toBe(`evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.${jwkThumbprint(jwk)}`);
    expect(dns01TxtValue(ka)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A fixed input gives a fixed output: SHA-256("abc"), base64url.
    expect(dns01TxtValue('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('signs ES256 as raw R||S that verifies against the public JWK', () => {
    const key = generateAccountKey();
    const jws = signJws(key, { nonce: 'n1', url: 'https://ca.test/new-order', kid: 'https://ca.test/acct/1' }, { a: 1 });
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString()) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'ES256', nonce: 'n1', url: 'https://ca.test/new-order', kid: 'https://ca.test/acct/1' });
    const sig = Buffer.from(jws.signature, 'base64url');
    expect(sig).toHaveLength(64);
    const pub = createPublicKey({ key: { ...publicJwk(key) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    // POST-as-GET: the payload is the empty string.
    expect(signJws(key, { nonce: 'n2', url: 'u', kid: 'k' }, null).payload).toBe('');
  });

  it('refuses a non-P-256 account key', () => {
    expect(() => publicJwk(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey)).toThrow(/P-256/);
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('CSR (RFC 2986)', () => {
  for (const type of ['rsa', 'ec'] as const) {
    it(`builds a ${type} request with CN and every domain as a dNSName SAN, and a valid signature`, async () => {
      const key = generateCertificateKey(type);
      const der = buildCsr(key, ['mx.d3cloud.io', 'smtp.d3cloud.io']);
      const csr = parseCsr(der);
      expect(csr.cn).toBe('mx.d3cloud.io');
      expect(csr.sans).toEqual(['mx.d3cloud.io', 'smtp.d3cloud.io']);
      expect(csr.signatureValid).toBe(true);
      expect(csr.algorithmOid).toEqual(oid(type === 'rsa' ? '1.2.840.113549.1.1.11' : '1.2.840.10045.4.3.2'));
      if (!hasOpenssl()) return;
      const file = join(dir, 'x.csr');
      await writeFile(file, der);
      const out = execFileSync('openssl', ['req', '-in', file, '-inform', 'DER', '-noout', '-verify', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toContain('DNS:mx.d3cloud.io, DNS:smtp.d3cloud.io');
      expect(out).toMatch(/Subject: CN\s*=\s*mx\.d3cloud\.io/);
    });
  }

  it('refuses no domains and an over-long CN', () => {
    const key = generateCertificateKey('ec');
    expect(() => buildCsr(key, [])).toThrow();
    expect(() => buildCsr(key, [`${'a'.repeat(60)}.d3cloud.io`])).toThrow(/too long/);
  });
});

describe('renewal decision', () => {
  const domains = ['mx.d3cloud.io'];
  const paths = (): ReturnType<typeof certPaths> => certPaths(dir, domains, false);

  it('renews a missing certificate', async () => {
    expect(renewalReason(await readExisting(paths().cert, paths().key, new Date()), domains, 30)).toBe('no certificate yet');
  });

  it('renews under ACME_RENEW_DAYS and not above', async () => {
    await installPair(paths(), makePair(domains, 29));
    expect(renewalReason(await readExisting(paths().cert, paths().key, new Date()), domains, 30)).toMatch(/^expires in 2[89]\.\d days/);
    await installPair(paths(), makePair(domains, 31));
    expect(renewalReason(await readExisting(paths().cert, paths().key, new Date()), domains, 30)).toBeNull();
  });

  it('renews when the certificate does not cover every domain', async () => {
    await installPair(paths(), makePair(domains, 80));
    const existing = await readExisting(paths().cert, paths().key, new Date());
    expect(renewalReason(existing, ['mx.d3cloud.io', 'smtp.d3cloud.io'], 30)).toBe('the certificate does not cover smtp.d3cloud.io');
  });

  it('renews when the key does not match the certificate', async () => {
    const a = makePair(domains, 80);
    const b = makePair(domains, 80);
    await installPair(paths(), { certPem: a.certPem, keyPem: b.keyPem });
    expect(renewalReason(await readExisting(paths().cert, paths().key, new Date()), domains, 30)).toMatch(/does not match/);
  });
});

describe('atomic write', () => {
  it('replaces by rename, leaves no temp files, and sets exact modes', async () => {
    const p = certPaths(dir, ['mx.d3cloud.io'], false);
    await installPair(p, makePair(['mx.d3cloud.io'], 80));
    const before = (await stat(p.cert)).ino;
    const next = makePair(['mx.d3cloud.io'], 80);
    await installPair(p, next);
    expect((await stat(p.cert)).ino).not.toBe(before);
    expect(await readFile(p.cert, 'utf8')).toBe(next.certPem);
    expect((await readdir(p.dir)).sort()).toEqual(['fullchain.pem', 'privkey.pem']);
    expect((await stat(p.key)).mode & 0o777).toBe(0o640);
    expect((await stat(p.cert)).mode & 0o777).toBe(0o644);
    expect((await stat(p.dir)).mode & 0o777).toBe(0o750);
  });

  it('leaves nothing behind when the write cannot happen', async () => {
    await expect(writeFileAtomic(join(dir, 'missing-dir', 'x.pem'), 'x', 0o600)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('configuration', () => {
  const env = { ACME_DNS_TOKEN: 't', ACME_DOMAINS: 'MX.d3cloud.io.', ACME_CHALLENGE_ZONE: 'bigfluffymurderbuffalo.com', ACME_CHALLENGE_ZONE_ID: 'z' };

  it('is off unless ACME_DNS_TOKEN and ACME_DOMAINS are set', () => {
    expect(acmeConfig({}).enabled).toBe(false);
    expect(acmeConfig({ ACME_DOMAINS: 'mx.d3cloud.io' }).enabled).toBe(false);
    expect(acmeConfig({ ACME_DNS_TOKEN: 't' }).enabled).toBe(false);
  });

  it('defaults to Let\'s Encrypt production with a staging gate, 30 days, /var/lib/postroom/certs, no contact', () => {
    const c = acmeConfig(env);
    expect(c).toMatchObject({ enabled: true, domains: ['mx.d3cloud.io'], directoryUrl: LE_PRODUCTION, stagingDirectoryUrl: LE_STAGING, renewDays: 30, certDir: '/var/lib/postroom/certs', contact: [] });
    expect(acmeConfig({ ...env, ACME_DIRECTORY_URL: LE_STAGING }).stagingDirectoryUrl).toBeNull();
    expect(acmeConfig({ ...env, ACME_CONTACT: 'ops@d3cloud.io' }).contact).toEqual(['mailto:ops@d3cloud.io']);
  });

  it('turns itself off (not the worker) on a malformed ACME_DOMAINS', () => {
    const c = acmeConfig({ ...env, ACME_DOMAINS: '*.d3cloud.io' });
    expect(c.enabled).toBe(false);
    expect(c.missing[0]).toMatch(/not a hostname/);
  });

  it('keeps staging certificates out of the live path', () => {
    expect(certPaths('/c', ['mx.d3cloud.io'], false).cert).toBe('/c/mx.d3cloud.io/fullchain.pem');
    expect(certPaths('/c', ['mx.d3cloud.io'], true).key).toBe('/c/staging/mx.d3cloud.io/privkey.pem');
  });

  it('points the cert-expiry monitor at the ACME output when TLS_CERT_FILES is unset', () => {
    const db = {} as unknown as Db;
    expect(buildMonitors({ db, env, backupsConfigured: false }).monitors.map((m) => m.name)).toContain('cert-expiry');
    expect(buildMonitors({ db, env: { ...env, TLS_CERT_FILES: '' }, backupsConfigured: false }).monitors.map((m) => m.name)).not.toContain('cert-expiry');
    expect(buildMonitors({ db, env: {}, backupsConfigured: false }).monitors.map((m) => m.name)).not.toContain('cert-expiry');
  });

  it('zone membership is by label, not by string suffix', () => {
    expect(isInZone('mx.d3cloud.io.bigfluffymurderbuffalo.com.', 'bigfluffymurderbuffalo.com')).toBe(true);
    expect(isInZone('bigfluffymurderbuffalo.com', 'bigfluffymurderbuffalo.com')).toBe(false);
    expect(isInZone('x.evilbigfluffymurderbuffalo.com', 'bigfluffymurderbuffalo.com')).toBe(false);
  });
});

describe('postroom acme arguments', () => {
  it('parses --staging and --force, and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ staging: false, force: false });
    expect(parseArgs(['--staging', '--force'])).toEqual({ staging: true, force: true });
    expect(parseArgs(['--prod'])).toBeNull();
  });
});
