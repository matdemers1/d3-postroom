import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decryptBuffer,
  DecryptError,
  encryptBuffer,
  generateDek,
  generateKek,
  openWithKek,
  sealWithKek,
  sha256Hex,
  unwrapDek,
  wrapDek,
  WRAPPED_DEK_BYTES,
} from '../../src/index.js';

describe('wrapDek / unwrapDek', () => {
  const kek = generateKek();
  const blob = sha256Hex('a message');

  it('round-trips in the documented 69-byte format', () => {
    const dek = generateDek();
    const wrapped = wrapDek(kek, dek, blob);
    expect(wrapped.length).toBe(WRAPPED_DEK_BYTES);
    expect(wrapped.length).toBe(69);
    expect(wrapped[0]).toBe(0x01);
    expect(wrapped.subarray(1, 9).toString('hex')).toBe(kek.id);
    expect(unwrapDek(kek, wrapped, blob).equals(dek)).toBe(true);
    expect(wrapped.includes(dek)).toBe(false);
  });

  it('fails with the wrong KEK, the wrong AAD, or any flipped bit', () => {
    const dek = generateDek();
    const wrapped = wrapDek(kek, dek, blob);
    expect(() => unwrapDek(generateKek(), wrapped, blob)).toThrow(DecryptError);
    expect(() => unwrapDek(kek, wrapped, sha256Hex('another message'))).toThrow(DecryptError);
    for (let bit = 0; bit < wrapped.length * 8; bit++) {
      const bad = Buffer.from(wrapped);
      bad[bit >> 3] = (bad[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      expect(() => unwrapDek(kek, bad, blob)).toThrow(DecryptError);
    }
    expect(() => unwrapDek(kek, wrapped.subarray(0, 68), blob)).toThrow(DecryptError);
  });

  it('refuses a DEK that is not 32 bytes', () => {
    expect(() => wrapDek(kek, Buffer.alloc(31), blob)).toThrow(RangeError);
  });

  it('round-trips arbitrary data sealed under the KEK', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), fc.string(), (data, aad) => {
        const sealed = sealWithKek(kek, data, aad);
        expect(openWithKek(kek, sealed, aad).equals(Buffer.from(data))).toBe(true);
      }),
    );
  });
});

describe('encryptBuffer / decryptBuffer', () => {
  it('round-trips and authenticates', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), fc.uint8Array({ maxLength: 64 }), (data, aad) => {
        const dek = generateDek();
        const ct = encryptBuffer(dek, data, aad);
        expect(decryptBuffer(dek, ct, aad).equals(Buffer.from(data))).toBe(true);
        expect(() => decryptBuffer(generateDek(), ct, aad)).toThrow(DecryptError);
        expect(() => decryptBuffer(dek, ct, Buffer.concat([aad, Buffer.of(0)]))).toThrow(DecryptError);
        const bad = Buffer.from(ct);
        const i = bad.length - 1;
        bad[i] = (bad[i] ?? 0) ^ 1;
        expect(() => decryptBuffer(dek, bad, aad)).toThrow(DecryptError);
      }),
    );
  });

  it('never contains the plaintext', () => {
    const plain = Buffer.from('-----BEGIN PRIVATE KEY----- dkim selector secret material '.repeat(20));
    const ct = encryptBuffer(generateDek(), plain, 'dkim');
    expect(ct.includes(plain.subarray(0, 16))).toBe(false);
  });
});
