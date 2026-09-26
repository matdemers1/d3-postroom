// PST-T-8.6: the hand-rolled CMS SignedData encoder (no node-forge). Signs a plist with a real
// self-signed certificate made by `openssl req -x509`, then hands the DER over to `openssl smime
// -verify` — the same tool iOS's own CMS reader has to agree with — and checks it recovers exactly
// the embedded content.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signCms, type SigningKeyPair } from '../../src/mobileconfig/cms.js';
import { buildProfile } from '../../src/mobileconfig/profile.js';
import { writePlist } from '../../src/mobileconfig/plist.js';

let dir: string;
let rsaKeys: SigningKeyPair;
let ecKeys: SigningKeyPair;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-cms-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'rsa-key.pem'), '-out', join(dir, 'rsa-cert.pem'), '-days', '1', '-subj', '/CN=Postroom Test/O=d3cloud.io'], {
    stdio: 'pipe',
  });
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'ec-key.pem'), '-out', join(dir, 'ec-cert.pem'), '-days', '1', '-subj', '/CN=Postroom Test EC/O=d3cloud.io'],
    { stdio: 'pipe' },
  );
  rsaKeys = { certificatePem: readFileSync(join(dir, 'rsa-cert.pem'), 'utf8'), privateKeyPem: readFileSync(join(dir, 'rsa-key.pem'), 'utf8') };
  ecKeys = { certificatePem: readFileSync(join(dir, 'ec-cert.pem'), 'utf8'), privateKeyPem: readFileSync(join(dir, 'ec-key.pem'), 'utf8') };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function verifyWithOpenssl(der: Buffer, workDir: string): string {
  const file = join(workDir, 'p.mobileconfig');
  writeFileSync(file, der);
  // -noverify: skip chain-of-trust (it is a throwaway self-signed test cert); the signature itself
  // and the embedded content digest are still checked.
  return execFileSync('openssl', ['smime', '-verify', '-inform', 'DER', '-noverify', '-in', file], { stdio: 'pipe' }).toString('utf8');
}

describe('signCms', () => {
  it('signs with an RSA key and openssl recovers the exact embedded content', () => {
    const work = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-cms-rsa-'));
    try {
      const content = Buffer.from(writePlist({ Hello: 'World' }), 'utf8');
      const der = signCms(content, rsaKeys, new Date('2026-01-01T00:00:00Z'));
      const recovered = verifyWithOpenssl(der, work);
      expect(recovered).toBe(content.toString('utf8'));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('signs with an ECDSA key and openssl recovers the exact embedded content', () => {
    const work = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-cms-ec-'));
    try {
      const content = Buffer.from(writePlist({ Hello: 'EC' }), 'utf8');
      const der = signCms(content, ecKeys, new Date('2026-01-01T00:00:00Z'));
      const recovered = verifyWithOpenssl(der, work);
      expect(recovered).toBe(content.toString('utf8'));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('a tampered signed profile fails verification', () => {
    const work = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-cms-tamper-'));
    try {
      const content = Buffer.from(writePlist({ Hello: 'World' }), 'utf8');
      const der = signCms(content, rsaKeys, new Date('2026-01-01T00:00:00Z'));
      // Flip a byte deep in the encapsulated content, past the ContentInfo/SignedData headers.
      const tampered = Buffer.from(der);
      const idx = tampered.lastIndexOf(Buffer.from('World'));
      expect(idx).toBeGreaterThan(-1);
      tampered[idx] = (tampered[idx] ?? 0) ^ 0xff;
      const file = join(work, 'p.mobileconfig');
      writeFileSync(file, tampered);
      expect(() => execFileSync('openssl', ['smime', '-verify', '-inform', 'DER', '-noverify', '-in', file], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('includes a certificate chain when given one', () => {
    const work = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-cms-chain-'));
    try {
      const content = Buffer.from(writePlist({ Hello: 'Chain' }), 'utf8');
      const der = signCms(content, { ...rsaKeys, chainPem: [rsaKeys.certificatePem] }, new Date('2026-01-01T00:00:00Z'));
      const recovered = verifyWithOpenssl(der, work);
      expect(recovered).toBe(content.toString('utf8'));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('buildProfile', () => {
  it('gives every payload, and the profile itself, a unique PayloadUUID', () => {
    const profile = buildProfile({
      accountId: 'acct-1',
      displayName: 'alice',
      email: 'alice@d3cloud.io',
      appPassword: 'xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx',
      imapHost: 'mail.d3cloud.io',
      submissionHost: 'mail.d3cloud.io',
      davHost: 'dav.d3cloud.io',
      principalUrl: 'https://dav.d3cloud.io/dav/principals/acct-1/',
    }) as Record<string, unknown>;
    const content = profile['PayloadContent'] as Record<string, unknown>[];
    const uuids = [profile['PayloadUUID'], ...content.map((p) => p['PayloadUUID'])];
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(content).toHaveLength(3);
    expect(content.map((p) => p['PayloadType'])).toEqual(['com.apple.mail.managed', 'com.apple.caldav.account', 'com.apple.carddav.account']);
    // The app password appears wherever an app authenticates with it, and nowhere else in the tree.
    const xml = writePlist(profile as never);
    expect((xml.match(/xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx/g) ?? []).length).toBe(4); // IMAP + SMTP + CalDAV + CardDAV
  });
});
