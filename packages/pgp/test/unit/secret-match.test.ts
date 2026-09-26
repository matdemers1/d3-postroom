// PST-T-12.2: a secret half must belong to its public half. node:crypto builds a private KeyObject
// from the secret scalar and ignores a mismatched public point, so an import that pairs key A's
// public packet with key B's secret material would sign with B while advertising A.
import { describe, expect, it } from 'vitest';
import { decodeArmor, encodeArmor, encodePacket, generateKey, parseKeys, readPackets, secretMatchesPublic, Tag } from '../../src/index.js';

const created = new Date('2026-03-01T00:00:00Z');

describe('secretMatchesPublic', () => {
  const a = generateKey({ userId: 'A <a@example.test>', created });
  const b = generateKey({ userId: 'B <b@example.test>', created });

  it('holds for a generated key: the Ed25519 primary and the X25519 subkey', () => {
    for (const m of [a.key.primary, ...a.key.subkeys]) expect(secretMatchesPublic(m)).toBe(true);
  });

  it("fails when A's public material carries B's secret (the verifier's attack, both key types)", () => {
    expect(secretMatchesPublic({ ...a.key.primary, secretKey: b.key.primary.secretKey })).toBe(false);
    const [aSub] = a.key.subkeys;
    const [bSub] = b.key.subkeys;
    if (aSub === undefined || bSub === undefined) throw new Error('no subkey');
    expect(secretMatchesPublic({ ...aSub, secretKey: bSub.secretKey })).toBe(false);
  });

  it("parses a block whose secret packet is A's public fields + B's secret tail (valid checksum) — and flags it", () => {
    const pa = readPackets(a.secretBinary);
    const pb = readPackets(b.secretBinary);
    const secA = pa.find((p) => p.tag === Tag.SecretKey);
    const secB = pb.find((p) => p.tag === Tag.SecretKey);
    if (secA === undefined || secB === undefined) throw new Error('no secret packet');
    const pubLen = a.key.primary.body.length;
    const spliced = Buffer.concat([secA.body.subarray(0, pubLen), secB.body.subarray(pubLen)]);
    const block = Buffer.concat(pa.map((p) => (p === secA ? encodePacket(Tag.SecretKey, spliced) : encodePacket(p.tag, p.body))));
    const armored = encodeArmor('PGP PRIVATE KEY BLOCK', block);
    const decoded = decodeArmor(armored);
    if (decoded === null) throw new Error('no armor');
    const [key] = parseKeys(decoded.data);
    if (key === undefined) throw new Error('no key');
    expect(key.primary.fingerprint).toBe(a.fingerprint);
    expect(secretMatchesPublic(key.primary)).toBe(false);
  });
});
