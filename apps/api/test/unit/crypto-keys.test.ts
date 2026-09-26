// PST-T-12.1, PST-REQ-160: a private key sealed under the KEK opens only with that KEK and only
// for the row it was sealed for (account, kind, fingerprint), and the opened key decrypts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKek } from '@postroom/crypto';
import { analyzeMessage } from '@postroom/pgp';
import { describe, expect, it } from 'vitest';
import { openPrivateKey, privateKeyAad, sealPrivateKey } from '../../src/mail/crypto-keys.js';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'pgp', 'test', 'fixtures');
const read = (f: string): string => readFileSync(join(FIXTURES, f), 'utf8');
const ALICE_SECRET = read('alice-ed25519.TEST-ONLY.sec.asc');
const ALICE_FPR = read('alice-ed25519.fpr').trim();
const ACCOUNT = '00000000-0000-4000-8000-000000000001';

describe('sealed private keys', () => {
  const kek = generateKek();

  it('round-trips under the KEK and records which KEK sealed it', () => {
    const { sealedPrivate, kekId } = sealPrivateKey(kek, ACCOUNT, 'pgp', ALICE_FPR, ALICE_SECRET);
    expect(kekId).toBe(kek.id);
    expect(sealedPrivate.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
    expect(openPrivateKey(kek, { accountId: ACCOUNT, kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate })).toBe(ALICE_SECRET);
  });

  it('does not open for another account, kind, fingerprint, or KEK — and never throws', () => {
    const { sealedPrivate } = sealPrivateKey(kek, ACCOUNT, 'pgp', ALICE_FPR, ALICE_SECRET);
    expect(openPrivateKey(kek, { accountId: '00000000-0000-4000-8000-000000000002', kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate })).toBeNull();
    expect(openPrivateKey(kek, { accountId: ACCOUNT, kind: 'smime', fingerprint: ALICE_FPR, sealedPrivate })).toBeNull();
    expect(openPrivateKey(kek, { accountId: ACCOUNT, kind: 'pgp', fingerprint: '00'.repeat(20), sealedPrivate })).toBeNull();
    expect(openPrivateKey(generateKek(), { accountId: ACCOUNT, kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate })).toBeNull();
    expect(openPrivateKey(null, { accountId: ACCOUNT, kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate })).toBeNull();
    expect(openPrivateKey(kek, { accountId: ACCOUNT, kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate: Buffer.from('junk') })).toBeNull();
  });

  it('binds the fingerprint case-insensitively', () => {
    expect(privateKeyAad(ACCOUNT, 'pgp', 'ABCD')).toBe(privateKeyAad(ACCOUNT, 'pgp', 'abcd'));
  });

  it('the opened key decrypts the PGP/MIME fixture', async () => {
    const { sealedPrivate } = sealPrivateKey(kek, ACCOUNT, 'pgp', ALICE_FPR, ALICE_SECRET);
    const r = await analyzeMessage([readFileSync(join(FIXTURES, 'pgp-mime-encrypted-x25519.eml'))], [
      {
        id: 'row-1',
        kind: 'pgp',
        owner: 'own',
        address: 'alice@example.test',
        fingerprint: ALICE_FPR,
        publicKey: read('alice-ed25519.pub.asc'),
        openPrivate: () => Promise.resolve(openPrivateKey(kek, { accountId: ACCOUNT, kind: 'pgp', fingerprint: ALICE_FPR, sealedPrivate })),
      },
    ]);
    expect(r.encryption.status).toBe('decrypted');
    expect(r.encryption.openedWithKeyId).toBe('row-1');
  });
});
