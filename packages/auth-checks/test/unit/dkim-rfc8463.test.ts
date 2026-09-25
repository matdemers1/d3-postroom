import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BodyHasher,
  ed25519PrivateFromSeed,
  headerHashInput,
  parseSignatureField,
  publicKeyFromDnsRecord,
  signHeaderData,
  splitMessage,
  verifyLocal,
  withEmptyB,
} from '../../src/index.js';
import {
  BODY_HASH,
  DNS_BRISBANE,
  DNS_TEST,
  ED25519_B,
  ED25519_PUBLIC_B64,
  ED25519_SEED_B64,
  ED25519_SIGNATURE,
  SIGNED,
  UNSIGNED,
} from './fixtures/rfc8463.js';

const keys = {
  brisbane: publicKeyFromDnsRecord(DNS_BRISBANE).publicKey,
  test: publicKeyFromDnsRecord(DNS_TEST).publicKey,
};

describe('RFC 8463 Appendix A test vectors', () => {
  it('the A.1 Ed25519 seed derives the A.2 published public key', () => {
    const priv = ed25519PrivateFromSeed(Buffer.from(ED25519_SEED_B64, 'base64'));
    const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' });
    expect(spki.subarray(12).toString('base64')).toBe(ED25519_PUBLIC_B64);
  });

  it('reproduces bh= of the A.3 body exactly', async () => {
    const split = await splitMessage(Buffer.from(UNSIGNED, 'latin1'));
    const h = new BodyHasher('relaxed');
    for await (const c of split.body) h.update(c);
    expect(h.digest().toString('base64')).toBe(BODY_HASH);
  });

  it('reproduces the Ed25519 b= byte for byte from the A.1 key', async () => {
    const split = await splitMessage(Buffer.from(SIGNED, 'latin1'));
    const sig = parseSignatureField(ED25519_SIGNATURE);
    expect(sig.signature.toString('base64')).toBe(ED25519_B);
    const data = headerHashInput(split.fields, sig.signedHeaders, withEmptyB(ED25519_SIGNATURE), 'relaxed');
    const priv = ed25519PrivateFromSeed(Buffer.from(ED25519_SEED_B64, 'base64'));
    expect(signHeaderData('ed25519-sha256', priv, data).toString('base64')).toBe(ED25519_B);
  });

  it('the local verifier passes both published signatures (RSA is deterministic PKCS#1 v1.5)', async () => {
    const results = await verifyLocal(Buffer.from(SIGNED, 'latin1'), keys);
    expect(results).toEqual([
      { domain: 'football.example.com', selector: 'brisbane', algorithm: 'ed25519-sha256', result: 'pass' },
      { domain: 'football.example.com', selector: 'test', algorithm: 'rsa-sha256', result: 'pass' },
    ]);
  });

  it('fails both when the body changes, and both when a signed header changes', async () => {
    const body = await verifyLocal(Buffer.from(SIGNED.replace('hungry', 'thirsty'), 'latin1'), keys);
    expect(body.map((r) => [r.result, r.reason])).toEqual([
      ['fail', 'body hash did not verify'],
      ['fail', 'body hash did not verify'],
    ]);
    const head = await verifyLocal(Buffer.from(SIGNED.replace('Is dinner ready?', 'Is lunch ready?'), 'latin1'), keys);
    expect(head.map((r) => [r.result, r.reason])).toEqual([
      ['fail', 'signature did not verify'],
      ['fail', 'signature did not verify'],
    ]);
  });
});
