// PST-T-12.2 (PST-REQ-161): when the composer offers Sign / Encrypt and why not, which recipients
// lack a key, what the send carries, and how a refusal reads. The Keys screen's own rules too.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import type { CryptoKeyJson } from '../../src/keys/api';
import { cryptoAvailability, cryptoRequest, formatFingerprint, isCryptoRefusal, keyErrorText, keyStatus, recipientAddresses, sniffImport, sortKeys } from '../../src/keys/format';
import { sendErrorText } from '../../src/mail/compose';

let n = 0;
const key = (extra: Partial<CryptoKeyJson>): CryptoKeyJson => ({
  id: `k${String(++n)}`,
  kind: 'pgp',
  owner: 'contact',
  address: 'alice@example.test',
  fingerprint: 'AAAA',
  algorithm: 'Ed25519',
  userIds: [],
  hasPrivate: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  ...extra,
});

const mine = key({ owner: 'own', address: 'me@d3cloud.io', hasPrivate: true });
const alice = key({ address: 'alice@example.test' });

describe('recipientAddresses', () => {
  it('reads To, Cc and Bcc, names and quoting included, lowercased and de-duplicated', () => {
    expect(recipientAddresses({ to: '"Doe, Jane" <Jane@Example.org>, bob@example.org', cc: 'jane@example.org', bcc: 'Hidden <h@example.org>' })).toEqual(['jane@example.org', 'bob@example.org', 'h@example.org']);
    expect(recipientAddresses({ to: '', cc: ' ', bcc: '' })).toEqual([]);
  });
});

describe('cryptoAvailability', () => {
  it('sign needs an own key with its private half; encrypt needs an own key and one per recipient', () => {
    const a = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test']);
    expect(a.sign).toEqual({ available: true, reason: null });
    expect(a.encrypt).toEqual({ available: true, reason: null, missing: [] });
  });

  it('names the recipients without a key', () => {
    const a = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test', 'bob@example.test', 'carol@example.test']);
    expect(a.encrypt.available).toBe(false);
    expect(a.encrypt.missing).toEqual(['bob@example.test', 'carol@example.test']);
    expect(a.encrypt.reason).toContain('bob@example.test, carol@example.test');
  });

  it('with no own key: neither, with a reason each', () => {
    const a = cryptoAvailability([alice], 'pgp', ['alice@example.test']);
    expect(a.sign.available).toBe(false);
    expect(a.sign.reason).toMatch(/no OpenPGP key of your own/);
    expect(a.encrypt.available).toBe(false);
    expect(a.encrypt.reason).toMatch(/encrypted to you/);
  });

  it('only keys of the chosen kind, not revoked, not expired, count', () => {
    const smimeMine = key({ kind: 'smime', owner: 'own', address: 'me@d3cloud.io', hasPrivate: true });
    expect(cryptoAvailability([smimeMine, alice], 'smime', ['alice@example.test']).encrypt.missing).toEqual(['alice@example.test']);
    const revoked = key({ address: 'alice@example.test', revokedAt: '2026-09-01T00:00:00.000Z' });
    expect(cryptoAvailability([mine, revoked], 'pgp', ['alice@example.test']).encrypt.missing).toEqual(['alice@example.test']);
    const expired = key({ address: 'alice@example.test', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(cryptoAvailability([mine, expired], 'pgp', ['alice@example.test'], new Date('2026-09-26T00:00:00Z')).encrypt.available).toBe(false);
    expect(cryptoAvailability([key({ owner: 'own', address: 'me@d3cloud.io', hasPrivate: false })], 'pgp', []).sign.available).toBe(false);
  });
});

describe('cryptoRequest', () => {
  const ok = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test']);
  const missing = cryptoAvailability([mine], 'pgp', ['alice@example.test']);
  it('carries what is ticked, of the chosen kind', () => {
    expect(cryptoRequest('pgp', false, false, ok)).toBeUndefined();
    expect(cryptoRequest('pgp', true, false, ok)).toEqual({ sign: 'pgp' });
    expect(cryptoRequest('smime', true, true, ok)).toEqual({ sign: 'smime', encrypt: 'smime' });
  });
  it('a ticked Encrypt is sent even when a key went missing: the server refuses, it is never sent in the clear', () => {
    expect(cryptoRequest('pgp', false, true, missing)).toEqual({ encrypt: 'pgp' });
  });
});

describe('refusals read as sentences', () => {
  it('names the recipients without a key, from the 409 body', () => {
    const e = new ApiError(409, 'recipient_keys_missing', { error: 'recipient_keys_missing', recipients: ['bob@example.test'] });
    expect(isCryptoRefusal(e)).toBe(true);
    expect(sendErrorText(e)).toContain('bob@example.test');
    expect(sendErrorText(new ApiError(409, 'signing_key_missing', {}))).toMatch(/no key of your own to sign/);
    expect(keyErrorText(new ApiError(400, 'bad_passphrase', { message: 'That passphrase does not unlock the key.' }))).toBe('That passphrase does not unlock the key.');
    expect(keyErrorText(new Error('network'))).toMatch(/did not answer/);
  });
});

describe('Keys screen helpers', () => {
  it('formats fingerprints in groups of four', () => {
    expect(formatFingerprint('5a715f1777c830019a2d')).toBe('5A71 5F17 77C8 3001 9A2D');
  });
  it('status: revoked beats expired beats active', () => {
    expect(keyStatus({ revokedAt: '2026-01-01T00:00:00Z', expiresAt: '2020-01-01T00:00:00Z' })).toBe('revoked');
    expect(keyStatus({ revokedAt: null, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired');
    expect(keyStatus({ revokedAt: null, expiresAt: null })).toBe('active');
  });
  it('sorts own keys first, then by address', () => {
    expect(sortKeys([key({ address: 'z@x.test' }), key({ owner: 'own', address: 'b@x.test' }), key({ address: 'a@x.test' })]).map((k) => `${k.owner}:${k.address}`)).toEqual(['own:b@x.test', 'contact:a@x.test', 'contact:z@x.test']);
  });
  it('recognises what was pasted', () => {
    expect(sniffImport('-----BEGIN PGP PUBLIC KEY BLOCK-----\n…')).toBe('pgp-public');
    expect(sniffImport('-----BEGIN PGP PRIVATE KEY BLOCK-----\n…')).toBe('pgp-secret');
    expect(sniffImport('-----BEGIN CERTIFICATE-----\n…')).toBe('certificate');
    expect(sniffImport('hello')).toBe('unknown');
  });
});
