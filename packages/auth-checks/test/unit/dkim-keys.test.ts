import { createPublicKey, sign, verify } from 'node:crypto';
import { DecryptError, generateKek } from '@postroom/crypto';
import { describe, expect, it } from 'vitest';
import {
  dnsRecordFor,
  generateDkimKeys,
  openDkimKey,
  publicKeyFromDnsRecord,
  sealDkimKey,
  selectorFor,
} from '../../src/index.js';

const keys = generateDkimKeys();

describe('generateDkimKeys', () => {
  it('makes an RSA-2048 and an Ed25519 pair', () => {
    expect(keys.rsa.privateKey.asymmetricKeyType).toBe('rsa');
    expect(keys.rsa.privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(keys.ed25519.privateKey.asymmetricKeyType).toBe('ed25519');
  });
});

describe('dnsRecordFor', () => {
  it('RSA publishes the SPKI DER and round-trips', () => {
    const txt = dnsRecordFor('rsa-sha256', keys.rsa.publicKey);
    expect(txt).toMatch(/^v=DKIM1; k=rsa; p=MIIBIjAN[A-Za-z0-9+/=]+$/);
    const parsed = publicKeyFromDnsRecord(txt);
    expect(parsed.algorithm).toBe('rsa-sha256');
    expect(parsed.publicKey.equals(keys.rsa.publicKey)).toBe(true);
  });

  it('Ed25519 publishes the raw 32-byte key (RFC 8463 §4.2), not SPKI, and round-trips', () => {
    const txt = dnsRecordFor('ed25519-sha256', keys.ed25519.publicKey);
    const p = /^v=DKIM1; k=ed25519; p=([A-Za-z0-9+/=]+)$/.exec(txt)?.[1];
    expect(Buffer.from(p ?? '', 'base64')).toHaveLength(32);
    expect(publicKeyFromDnsRecord(txt).publicKey.equals(keys.ed25519.publicKey)).toBe(true);
  });

  it('accepts a private key (derives the public half) and rejects a mismatched algorithm', () => {
    expect(dnsRecordFor('rsa-sha256', keys.rsa.privateKey)).toBe(dnsRecordFor('rsa-sha256', keys.rsa.publicKey));
    expect(() => dnsRecordFor('ed25519-sha256', keys.rsa.publicKey)).toThrow();
  });

  it('rejects a revoked record', () => {
    expect(() => publicKeyFromDnsRecord('v=DKIM1; k=rsa; p=')).toThrow(/revoked/);
  });
});

describe('sealed DKIM keys (PST-REQ-039)', () => {
  const kek = generateKek();
  const aad = 'dkim:d3cloud.io:pr202609r';

  it('seals so the PKCS#8 bytes never appear in the output, and opens to the same key', () => {
    for (const pair of [keys.rsa, keys.ed25519]) {
      const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
      const sealed = sealDkimKey(kek, pair.privateKey, aad);
      expect(sealed.includes(pkcs8)).toBe(false);
      // Not even a 16-byte window of the key material survives.
      for (let i = 0; i + 16 <= pkcs8.length; i += 16) expect(sealed.includes(pkcs8.subarray(i, i + 16))).toBe(false);
      const opened = openDkimKey(kek, sealed, aad);
      expect(opened.type).toBe('private');
      expect(createPublicKey(opened).equals(pair.publicKey)).toBe(true);
    }
  });

  it('the opened key signs verifiably', () => {
    const opened = openDkimKey(kek, sealDkimKey(kek, keys.ed25519.privateKey, aad), aad);
    const sig = sign(null, Buffer.from('x'), opened);
    expect(verify(null, Buffer.from('x'), keys.ed25519.publicKey, sig)).toBe(true);
  });

  it('opens only with the right KEK and AAD', () => {
    const sealed = sealDkimKey(kek, keys.rsa.privateKey, aad);
    expect(() => openDkimKey(generateKek(), sealed, aad)).toThrow(DecryptError);
    expect(() => openDkimKey(kek, sealed, 'dkim:d3cloud.io:pr202609e')).toThrow(DecryptError);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => openDkimKey(kek, flipped, aad)).toThrow(DecryptError);
  });

  it('refuses to seal a public key', () => {
    expect(() => sealDkimKey(kek, keys.rsa.publicKey, aad)).toThrow();
  });
});

describe('selectorFor', () => {
  it('is dated by UTC month with an algorithm suffix', () => {
    expect(selectorFor(new Date('2026-09-25T12:00:00Z'), 'rsa-sha256')).toBe('pr202609r');
    expect(selectorFor(new Date('2026-09-25T12:00:00Z'), 'ed25519-sha256')).toBe('pr202609e');
    expect(selectorFor(new Date('2026-12-31T23:59:59Z'), 'rsa-sha256')).toBe('pr202612r');
  });
});
