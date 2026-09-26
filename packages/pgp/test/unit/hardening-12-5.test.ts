// PST-T-12.5, PST-REQ-160: PGP/S-MIME hardening after verification.
//   (1) A self-signature or 0x18 subkey binding whose OWN signature expiration (subpacket 3,
//       RFC 9580 §5.2.3.18) has passed no longer grants signing: unsupported:key-expired, as gpg.
//   (2) A 0x20/0x28 revocation that arrives only in a copy of a stored key attached to the message
//       is applied to the stored key for that analysis — verified against the STORED primary, and
//       nothing else from the attached copy is read (it can only make the stored key stricter).
//   (3) BER parsing is linear in the bytes: an indefinite tree nine levels deep costs about what its
//       definite-length twin does, not bytes × depth.
//   (4) The encrypted-body cap defaults to at most 32 MiB.
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { analyzeMessage, children, DEFAULT_MAX_ENCRYPTED_BYTES, decodeArmor, encodeArmor, encodePacket, encodeTlv, parseKeys, readPackets, readTlv, Tag, type Tlv } from '../../src/index.js';
import { keySignatureData } from '../../src/validity.js';
import { forgeKey, pgpMimeSigned, SIGNED_PART, type ForgedKey } from './forge.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const created = new Date('2026-03-01T00:00:00Z');
const DAY = 24 * 3600;

const status = async (k: ForgedKey, sig: Buffer, now = NOW): Promise<string> => (await analyzeMessage([pgpMimeSigned(SIGNED_PART, sig)], [k.known()], { now })).signature.status;

describe('(1) a self-signature or binding past its own signature expiration grants nothing', () => {
  // forgeKey makes its self-signature and binding at 2026-01-01; NOW is 2026-06-01.
  it('an expired 0x18 binding → unsupported:key-expired, even for a signature made while it was current', async () => {
    const k = forgeKey({ subkey: { bindingExpiresSeconds: 90 * DAY } }); // binding expires 2026-04-01
    const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.signWithSubkey(SIGNED_PART, { created }))], [k.known()], { now: NOW });
    expect(r.signature.status).toBe('unsupported:key-expired');
    expect(r.signature.reasons.join(' ')).toMatch(/binding \(0x18\).*expired at 2026-04-01/);
    // The primary's own self-signature has no expiry: the primary still signs.
    expect(await status(k, k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
  });

  it('an expired self-signature → unsupported:key-expired for the primary and, through it, its subkeys', async () => {
    const k = forgeKey({ selfSigExpiresSeconds: 90 * DAY, subkey: {} });
    expect(await status(k, k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-expired');
    expect(await status(k, k.signWithSubkey(SIGNED_PART, { created }))).toBe('unsupported:key-expired');
  });

  it('the same key and binding before they expire → verified-known-key (the check is the expiry, not the subpacket)', async () => {
    const k = forgeKey({ selfSigExpiresSeconds: 365 * DAY, subkey: { bindingExpiresSeconds: 365 * DAY } });
    expect(await status(k, k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
    expect(await status(k, k.signWithSubkey(SIGNED_PART, { created }))).toBe('verified-known-key');
    // A clock past 2027-01-01 reads them as expired.
    const later = new Date('2027-02-01T00:00:00Z');
    expect(await status(k, k.signWithSubkey(SIGNED_PART, { created }), later)).toBe('unsupported:key-expired');
  });

  it('applies to a key attached to the message too', async () => {
    const k = forgeKey({ subkey: { bindingExpiresSeconds: 90 * DAY } });
    const part = Buffer.from(`Content-Type: text/plain\r\n\r\n${k.armored.replace(/\r?\n/g, '\r\n')}`, 'latin1');
    const r = await analyzeMessage([pgpMimeSigned(part, k.signWithSubkey(part, { created }))], [], { now: NOW });
    expect(r.signature.signer?.keySource).toBe('message');
    expect(r.signature.status).toBe('unsupported:key-expired');
  });
});

/** `armored` with the signature packets of the given types taken out. */
function without(armored: string, types: readonly number[]): string {
  const a = decodeArmor(armored);
  if (a === null) throw new Error('no armor');
  const kept = readPackets(a.data).filter((p) => !(p.tag === Tag.Signature && types.includes(p.body[1] ?? -1)));
  return encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat(kept.map((p) => encodePacket(p.tag, p.body))));
}

/** A text part carrying `armored`, so it arrives as a key attached to the message. */
const partWith = (armored: string): Buffer => Buffer.from(`Content-Type: text/plain\r\n\r\nMy key, updated:\r\n${armored.replace(/\r?\n/g, '\r\n')}`, 'latin1');

describe('(2) a revocation that arrives only in an attached copy of a stored key is applied', () => {
  const analyse = async (stored: string, fpr: string, attached: string, sign: (part: Buffer) => Buffer): Promise<{ status: string; source: string | undefined }> => {
    const part = partWith(attached);
    const r = await analyzeMessage([pgpMimeSigned(part, sign(part))], [{ id: 'dave-contact', kind: 'pgp', owner: 'contact', address: 'dave@example.test', fingerprint: fpr, publicKey: stored }], { now: NOW });
    return { status: r.signature.status, source: r.signature.signer?.keySource };
  };

  it('0x28 on the signing subkey, only in the attached copy → unsupported:key-revoked (the stored row is still the signer)', async () => {
    const k = forgeKey({ subkey: { revocation: { created: new Date('2026-02-01T00:00:00Z'), reason: 2 } } });
    const stored = without(k.armored, [0x28]);
    expect(stored).not.toBe(k.armored);
    const sign = (part: Buffer): Buffer => k.signWithSubkey(part, { created });
    // Without the attached copy (an unrelated attachment), the stored row alone still verifies…
    expect(await analyse(stored, k.fingerprint, forgeKey().armored, sign)).toEqual({ status: 'verified-known-key', source: 'account' });
    // …and with it, the revocation is applied to the stored key.
    expect(await analyse(stored, k.fingerprint, k.armored, sign)).toEqual({ status: 'unsupported:key-revoked', source: 'account' });
  });

  it('0x20 on the primary, only in the attached copy → unsupported:key-revoked for the primary and its subkeys', async () => {
    const k = forgeKey({ revocation: { created: new Date('2026-02-01T00:00:00Z') }, subkey: {} });
    const stored = without(k.armored, [0x20]);
    expect(await analyse(stored, k.fingerprint, k.armored, (p) => k.sign(p, { created }))).toEqual({ status: 'unsupported:key-revoked', source: 'account' });
    expect(await analyse(stored, k.fingerprint, k.armored, (p) => k.signWithSubkey(p, { created }))).toEqual({ status: 'unsupported:key-revoked', source: 'account' });
  });

  it('a soft revocation from the attached copy keeps its meaning: earlier signatures stand', async () => {
    const k = forgeKey({ revocation: { created: new Date('2026-04-01T00:00:00Z'), reason: 1 } });
    const stored = without(k.armored, [0x20]);
    expect((await analyse(stored, k.fingerprint, k.armored, (p) => k.sign(p, { created }))).status).toBe('verified-known-key');
    expect((await analyse(stored, k.fingerprint, k.armored, (p) => k.sign(p, { created: new Date('2026-04-02T00:00:00Z') }))).status).toBe('unsupported:key-revoked');
  });

  it('an attached revocation that does not verify against the stored primary is ignored', async () => {
    const k = forgeKey({ revocation: { created: new Date('2026-02-01T00:00:00Z'), forged: true } });
    const stored = without(k.armored, [0x20]);
    expect((await analyse(stored, k.fingerprint, k.armored, (p) => k.sign(p, { created }))).status).toBe('verified-known-key');
  });

  it('an attached revocation that cannot be checked at all (unknown or MD5 hash) is ignored, not honoured', async () => {
    const k = forgeKey({ revocation: { created: new Date('2026-02-01T00:00:00Z'), forged: true } });
    const stored = without(k.armored, [0x20]);
    for (const hash of [100, 1]) {
      const a = decodeArmor(k.armored);
      if (a === null) throw new Error('no armor');
      const patched = readPackets(a.data).map((pk) => {
        if (pk.tag !== Tag.Signature || pk.body[1] !== 0x20) return encodePacket(pk.tag, pk.body);
        const body = Buffer.from(pk.body);
        body[3] = hash;
        return encodePacket(pk.tag, body);
      });
      const attached = encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat(patched));
      expect((await analyse(stored, k.fingerprint, attached, (p) => k.sign(p, { created }))).status).toBe('verified-known-key');
    }
  });

  it("a revocation in some other key's block is never applied to the stored key", async () => {
    const k = forgeKey();
    const other = forgeKey({ revocation: { created: new Date('2026-02-01T00:00:00Z') } });
    expect((await analyse(k.armored, k.fingerprint, other.armored, (p) => k.sign(p, { created }))).status).toBe('verified-known-key');
  });

  it('an attached copy never adds authority: a newer self-signature granting 0x02 does not let a certify-only stored primary sign', async () => {
    const k = forgeKey({ primaryFlags: 0x01 });
    const [key] = parseKeys(decodeArmor(k.armored)?.data ?? Buffer.alloc(0));
    const uidSig = key?.signatures.find((ks) => ks.target.kind === 'uid');
    if (key === undefined || uidSig === undefined) throw new Error('no key');
    // A genuine, newer 0x13 by the primary with flags 0x03, in the attached copy only.
    const grant = k.sign(keySignatureData(key.primary, uidSig), { type: 0x13, created: new Date('2026-02-01T00:00:00Z'), flags: 0x03 });
    const upgraded = encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat([decodeArmor(k.armored)?.data ?? Buffer.alloc(0), grant]));
    // Attached alone, the upgraded copy may sign (the grant is genuine)…
    const part = partWith(upgraded);
    expect((await analyzeMessage([pgpMimeSigned(part, k.sign(part, { created }))], [], { now: NOW })).signature.status).toBe('valid-signature-unknown-key');
    // …but beside the stored certify-only row, the stored key decides, and it may not sign.
    expect((await analyse(k.armored, k.fingerprint, upgraded, (p) => k.sign(p, { created }))).status).toBe('unsupported:key-not-for-signing');
  });
});

// ---------------------------------------------------------------------------------------------
// (3) BER cost

/** A SEQUENCE tree `depth` levels deep, `fanout` wide, with OCTET STRING leaves of `leaf` bytes. */
function tree(depth: number, fanout: number, leaf: number, indefinite: boolean): Buffer {
  const leafTlv = encodeTlv(0, false, 4, Buffer.alloc(leaf, 0x5a));
  let level = leafTlv;
  for (let d = 0; d < depth; d++) {
    const kids = Buffer.concat(Array.from({ length: fanout }, () => level));
    level = indefinite ? Buffer.concat([Buffer.of(0x30, 0x80), kids, Buffer.of(0, 0)]) : encodeTlv(0, true, 16, kids);
  }
  return level;
}

/** Read the whole tree in BER mode, every value; returns how many there were. */
function walk(buf: Buffer): number {
  const visit = (t: Tlv): number => (t.constructed ? 1 + children(t).reduce((n, c) => n + visit(c), 0) : 1);
  return visit(readTlv(buf, 0, 0, 'ber'));
}

function fastest(fn: () => void, runs: number): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('(3) BER parsing is linear in the bytes, not bytes × indefinite depth', () => {
  it('a nine-level indefinite fan-out tree parses within 2.5× its definite-length twin (same machine, same run)', () => {
    // 3^9 = 19 683 leaves of 256 bytes: about 5.3 MB, the verifier's 38 MB shape scaled down.
    const ber = tree(9, 3, 256, true);
    const der = tree(9, 3, 256, false);
    expect(ber.length).toBeGreaterThan(5_000_000);
    expect(walk(ber)).toBe(walk(der));
    walk(ber);
    walk(der);
    const tBer = fastest(() => walk(ber), 7);
    const tDer = fastest(() => walk(der), 7);
    // Before PST-T-12.5 each indefinite level rescanned its subtree: about 9× here.
    expect(tBer / tDer, `ber ${tBer.toFixed(1)} ms, definite ${tDer.toFixed(1)} ms`).toBeLessThan(2.5);
  });

  it('a deep indefinite chain costs linear work too (each value is scanned once)', () => {
    // Nested to the indefinite cap, with a wide payload at the bottom: the old reader read the
    // payload once per level.
    const leaves = Buffer.concat(Array.from({ length: 20_000 }, () => encodeTlv(0, false, 4, Buffer.alloc(64, 1))));
    let ber = Buffer.concat([Buffer.of(0x30, 0x80), leaves, Buffer.of(0, 0)]);
    let der = encodeTlv(0, true, 16, leaves);
    for (let d = 1; d < 16; d++) {
      ber = Buffer.concat([Buffer.of(0x30, 0x80), ber, Buffer.of(0, 0)]);
      der = encodeTlv(0, true, 16, der);
    }
    expect(walk(ber)).toBe(walk(der));
    const tBer = fastest(() => walk(ber), 7);
    const tDer = fastest(() => walk(der), 7);
    expect(tBer / tDer, `ber ${tBer.toFixed(1)} ms, definite ${tDer.toFixed(1)} ms`).toBeLessThan(2.5);
  });
});

describe('(4) the encrypted-body cap', () => {
  it('defaults to at most 32 MiB', () => {
    expect(DEFAULT_MAX_ENCRYPTED_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('an S/MIME body over it is failed:too-large before any parsing', async () => {
    const line = Buffer.from(`${'A'.repeat(76)}\r\n`, 'latin1');
    const chunk = Buffer.concat(Array.from({ length: 1024 }, () => line));
    const head = Buffer.from('From: Dave <dave@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n', 'latin1');
    function* source(): Generator<Buffer> {
      yield head;
      for (let n = 0; n <= DEFAULT_MAX_ENCRYPTED_BYTES; n += chunk.length) yield chunk;
    }
    const r = await analyzeMessage(source(), []);
    expect(r.encryption.status).toBe('failed:too-large');
    expect(r.encryption.reasons.join(' ')).toContain(String(DEFAULT_MAX_ENCRYPTED_BYTES));
  });
});
