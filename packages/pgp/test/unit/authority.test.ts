// PST-T-12.3, PST-REQ-160: OpenPGP key authority. A key packet in a block speaks for the block only
// when it is the primary with signing allowed by its self-signature, or a subkey bound by a 0x18
// signature from the primary with key flag 0x02 and its own 0x19 back-signature (RFC 9580 §5.2.1,
// §5.2.3.29, §5.2.3.34). The attack fixtures are gpg-made (make-fixtures.sh, SECTIONS=authority).
import { createHash, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeMessage, decodeArmor, encodeArmor, encodePacket, parseKeys, readPackets, Tag, type KnownKey, type OpenPgpKey } from '../../src/index.js';
import { keyFlags } from '../../src/validity.js';
import { BOB_FPR, bob, fixture, text } from './fixtures.js';
import { forgeKey, pgpMimeSigned, SIGNED_PART } from './forge.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const created = new Date('2026-03-01T00:00:00Z');

const DAVE_FPR = text('dave-ed25519.fpr').trim();
const DAVE_SIGNING_SUBKEY = text('dave-ed25519-signing-subkey.fpr').trim();
const MALLORY_FPR = text('mallory-ed25519.fpr').trim();

function daveRow(file = 'dave-ed25519.pub.asc'): KnownKey {
  return { id: 'dave-contact', kind: 'pgp', owner: 'contact', address: 'dave@example.test', fingerprint: DAVE_FPR, publicKey: text(file) };
}

function malloryRow(): KnownKey {
  return { id: 'mallory-contact', kind: 'pgp', owner: 'contact', address: 'mallory@evil.test', fingerprint: MALLORY_FPR, publicKey: text('mallory-ed25519.pub.asc') };
}

function keysOf(armored: string): OpenPgpKey[] {
  const a = decodeArmor(armored);
  if (a === null) throw new Error('no armor');
  return parseKeys(a.data);
}

/** `victim`'s key block with `attacker`'s primary key packet appended as an unbound public subkey (tag 14). */
function poison(victim: string, attacker: string): string {
  const v = decodeArmor(victim);
  const a = decodeArmor(attacker);
  if (v === null || a === null) throw new Error('no armor');
  const primary = readPackets(a.data).find((p) => p.tag === Tag.PublicKey);
  if (primary === undefined) throw new Error('no primary');
  return encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat([v.data, encodePacket(Tag.PublicSubkey, primary.body)]));
}

/** A v4 RSA (algorithm 1) binary document signature, SHA-256, by `priv` with issuer `fpr`. */
function rsaSignature(priv: KeyObject, fpr: string, data: Buffer): Buffer {
  const hashed = Buffer.concat([Buffer.of(5, 2), u32(Math.floor(created.getTime() / 1000)), Buffer.of(22, 33, 4), Buffer.from(fpr, 'hex')]);
  const prefix = Buffer.concat([Buffer.of(4, 0x00, 1, 8), Buffer.of(hashed.length >> 8, hashed.length & 0xff), hashed]);
  const trailer = Buffer.concat([prefix, Buffer.of(4, 0xff), u32(prefix.length)]);
  const digest = createHash('sha256').update(data).update(trailer).digest();
  // RSASSA-PKCS1-v1_5 over SHA-256 of data || trailer is exactly OpenPGP's RSA signature.
  const s = sign('sha256', Buffer.concat([data, trailer]), priv);
  let i = 0;
  while (i < s.length - 1 && s[i] === 0) i++;
  const v = s.subarray(i);
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(v[0] ?? 0));
  return encodePacket(Tag.Signature, Buffer.concat([prefix, Buffer.of(0, 0), digest.subarray(0, 2), Buffer.of(bits >> 8, bits & 0xff), v]));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

describe('(1) an unbound subkey never speaks for the key it was appended to', () => {
  it('the gpg fixture: the poisoned key really carries mallory as a tag-14 packet with no binding', () => {
    const [dave] = keysOf(text('dave-poisoned.pub.asc'));
    expect(dave?.primary.fingerprint).toBe(DAVE_FPR);
    expect(dave?.subkeys.map((s) => s.fingerprint)).toContain(MALLORY_FPR);
    const bindings = dave?.signatures.filter((s) => s.target.kind === 'subkey' && s.target.subkey.fingerprint === MALLORY_FPR) ?? [];
    expect(bindings).toEqual([]);
  });

  it("stored: mallory's signature on a message From dave, checked against dave's poisoned CryptoKey → unsupported:subkey-not-bound", async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-mallory-as-dave.eml')], [daveRow('dave-poisoned.pub.asc')]);
    expect(r.signature.status).toBe('unsupported:subkey-not-bound');
    expect(r.signature.status).not.toBe('verified-known-key');
    // Nothing of dave's is lent to mallory's key: no user IDs, no known row, no From match.
    expect(r.signature.signer).toMatchObject({ fingerprint: MALLORY_FPR, userIds: [], knownKeyId: null, owner: null, fromMatches: null });
    expect(r.signature.reasons.join(' ')).toMatch(/no subkey binding signature \(0x18\)/);
  });

  it('stored, with the clean key (as gpg --import leaves it): the signer is simply unknown', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-mallory-as-dave.eml')], [daveRow()]);
    expect(r.signature.status).toBe('unsupported:signer-key-unavailable');
  });

  it("when mallory's own key is also a contact, the signature is mallory's — and does not match From", async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-mallory-as-dave.eml')], [daveRow('dave-poisoned.pub.asc'), malloryRow()]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.signer).toMatchObject({ fingerprint: MALLORY_FPR, knownKeyId: 'mallory-contact', userIds: ['Mallory <mallory@evil.test>'], fromMatches: false });
  });

  it('attached: the same poisoning in a key that came with the message is refused alike (never valid-signature-unknown-key)', async () => {
    const dave = forgeKey();
    const mallory = forgeKey({ uid: 'Mallory <mallory@evil.test>' });
    const part = Buffer.from(`Content-Type: text/plain\r\n\r\n${poison(dave.armored, mallory.armored).replace(/\r?\n/g, '\r\n')}`, 'latin1');
    const r = await analyzeMessage([pgpMimeSigned(part, mallory.sign(part, { created }))], [], { now: NOW });
    expect(r.signature.status).toBe('unsupported:subkey-not-bound');
    expect(r.signature.signer?.keySource).toBe('message');
    expect(r.signature.signer?.userIds).toEqual([]);
  });

  it('forged: stored poisoning, and a subkey whose only 0x18 is missing, are both refused', async () => {
    const dave = forgeKey();
    const mallory = forgeKey({ uid: 'Mallory <mallory@evil.test>' });
    const stored = await analyzeMessage([pgpMimeSigned(SIGNED_PART, mallory.sign(SIGNED_PART, { created }))], [{ ...dave.known(), publicKey: poison(dave.armored, mallory.armored) }], { now: NOW });
    expect(stored.signature.status).toBe('unsupported:subkey-not-bound');
    const unbound = forgeKey({ subkey: { unbound: true } });
    const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, unbound.signWithSubkey(SIGNED_PART, { created }))], [unbound.known()], { now: NOW });
    expect(r.signature.status).toBe('unsupported:subkey-not-bound');
  });
});

describe('(2) a bound subkey without key flag 0x02 cannot verify a signature', () => {
  const bobSecret = keysOf(text('bob-rsa3072.TEST-ONLY.sec.asc'))[0];
  const encSubkey = bobSecret?.subkeys[0];
  const bobPublic = keysOf(text('bob-rsa3072.pub.asc'))[0];

  it("bob's gpg-made RSA subkey (quick-add-key rsa3072 encr) is bound, with flags that do not include 0x02", () => {
    if (encSubkey === undefined || bobPublic === undefined) throw new Error('bob key shape');
    const binding = bobPublic.signatures.find((s) => s.sig.type === 0x18 && s.target.kind === 'subkey' && s.target.subkey.fingerprint === encSubkey.fingerprint);
    if (binding === undefined) throw new Error('no binding');
    const flags = keyFlags(binding.sig);
    expect(flags).not.toBeNull();
    expect((flags ?? 0) & 0x02).toBe(0);
    expect((flags ?? 0) & 0x0c).not.toBe(0);
  });

  it('a signature by that encryption-only subkey → unsupported:key-not-for-signing, stored or attached', async () => {
    const encSecret = encSubkey?.secretKey ?? null;
    const primarySecret = bobSecret?.primary.secretKey ?? null;
    if (encSubkey === undefined || encSecret === null || primarySecret === null) throw new Error('bob secret key shape');
    const sig = rsaSignature(encSecret, encSubkey.fingerprint, SIGNED_PART);
    const stored = await analyzeMessage([pgpMimeSigned(SIGNED_PART, sig, 'Bob Test <bob@example.test>')], [bob('contact')], { now: NOW });
    expect(stored.signature.status).toBe('unsupported:key-not-for-signing');
    expect(stored.signature.signer?.fingerprint).toBe(encSubkey.fingerprint);
    expect(stored.signature.reasons.join(' ')).toMatch(/without 0x02/);

    const part = Buffer.from(`Content-Type: text/plain\r\n\r\n${text('bob-rsa3072.pub.asc').replace(/\r?\n/g, '\r\n')}`, 'latin1');
    const attached = await analyzeMessage([pgpMimeSigned(part, rsaSignature(encSecret, encSubkey.fingerprint, part), 'Bob Test <bob@example.test>')], [], { now: NOW });
    expect(attached.signature.status).toBe('unsupported:key-not-for-signing');
    expect(attached.signature.signer?.keySource).toBe('message');

    // The signer is sound: the same signature by bob's primary (flags 0x03) verifies.
    const primary = await analyzeMessage([pgpMimeSigned(SIGNED_PART, rsaSignature(primarySecret, BOB_FPR, SIGNED_PART), 'Bob Test <bob@example.test>')], [bob('contact')], { now: NOW });
    expect(primary.signature.status).toBe('verified-known-key');
  });

  it('forged: a subkey bound for encryption (0x0C), or with no flags at all, may not sign', async () => {
    for (const flags of [0x0c, 0x01, null]) {
      const k = forgeKey({ subkey: { flags } });
      const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.signWithSubkey(SIGNED_PART, { created }))], [k.known()], { now: NOW });
      expect(r.signature.status).toBe('unsupported:key-not-for-signing');
    }
  });
});

describe('(3) a properly bound signing subkey still verifies, and so does a Proton-style Ed25519 primary', () => {
  it("dave's gpg-made signing subkey (0x18 with flag 0x02 and an embedded 0x19) → verified-known-key", async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-dave-subkey.eml')], [daveRow()]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.signer).toMatchObject({ fingerprint: DAVE_SIGNING_SUBKEY, knownKeyId: 'dave-contact', fromMatches: true });
  });

  it("dave's primary, and the poisoned block's genuine keys, still verify", async () => {
    expect((await analyzeMessage([fixture('pgp-mime-signed-dave-primary.eml')], [daveRow()])).signature.status).toBe('verified-known-key');
    expect((await analyzeMessage([fixture('pgp-mime-signed-dave-primary.eml')], [daveRow('dave-poisoned.pub.asc')])).signature.status).toBe('verified-known-key');
    expect((await analyzeMessage([fixture('pgp-mime-signed-dave-subkey.eml')], [daveRow('dave-poisoned.pub.asc')])).signature.status).toBe('verified-known-key');
  });

  it('the Proton-style Ed25519 primary (alice) verifies, stored and attached', async () => {
    const alice: KnownKey = { id: 'alice', kind: 'pgp', owner: 'contact', address: 'alice@example.test', fingerprint: text('alice-ed25519.fpr').trim(), publicKey: text('alice-ed25519.pub.asc') };
    expect((await analyzeMessage([fixture('pgp-mime-signed-ed25519.eml')], [alice])).signature.status).toBe('verified-known-key');
    expect((await analyzeMessage([fixture('pgp-mime-signed-ed25519.eml')], [])).signature.status).toBe('valid-signature-unknown-key');
  });

  it('forged: a signing subkey without its 0x19 back-signature, or with one made by another key, is not bound', async () => {
    for (const backSig of [false, 'forged'] as const) {
      const k = forgeKey({ subkey: { backSig } });
      const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.signWithSubkey(SIGNED_PART, { created }))], [k.known()], { now: NOW });
      expect(r.signature.status).toBe('unsupported:subkey-not-bound');
      expect(r.signature.reasons.join(' ')).toMatch(/0x19/);
    }
    const ok = forgeKey({ subkey: {} });
    expect((await analyzeMessage([pgpMimeSigned(SIGNED_PART, ok.signWithSubkey(SIGNED_PART, { created }))], [ok.known()], { now: NOW })).signature.status).toBe('verified-known-key');
  });
});

describe('(4) the primary signs only when its self-signature allows it (key flag 0x02)', () => {
  const check = async (primaryFlags: number | null): Promise<string> => {
    const k = forgeKey({ primaryFlags });
    return (await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.sign(SIGNED_PART, { created }))], [k.known()], { now: NOW })).signature.status;
  };

  it('flags 0x01 (certify only) or 0x0C (encrypt) → unsupported:key-not-for-signing', async () => {
    expect(await check(0x01)).toBe('unsupported:key-not-for-signing');
    expect(await check(0x0c)).toBe('unsupported:key-not-for-signing');
  });

  it('flags 0x02 or 0x03 → verified-known-key', async () => {
    expect(await check(0x02)).toBe('verified-known-key');
    expect(await check(0x03)).toBe('verified-known-key');
  });

  it('no key flags subpacket at all: inferred from the algorithm (Ed25519 can sign), as RFC 9580 §5.2.3.29 allows', async () => {
    expect(await check(null)).toBe('verified-known-key');
  });

  it('a certify-only primary does not stop its bound signing subkey', async () => {
    const k = forgeKey({ primaryFlags: 0x01, subkey: {} });
    expect((await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.signWithSubkey(SIGNED_PART, { created }))], [k.known()], { now: NOW })).signature.status).toBe('verified-known-key');
    expect((await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.sign(SIGNED_PART, { created }))], [k.known()], { now: NOW })).signature.status).toBe('unsupported:key-not-for-signing');
  });

  it('gpg and Proton primaries carry 0x02 on their self-signatures', () => {
    for (const file of ['dave-ed25519.pub.asc', 'alice-ed25519.pub.asc', 'bob-rsa3072.pub.asc']) {
      const [key] = keysOf(text(file));
      const self = key?.signatures.find((s) => s.target.kind === 'uid' && s.sig.type >= 0x10 && s.sig.type <= 0x13);
      expect(((self === undefined ? 0 : keyFlags(self.sig)) ?? 0) & 0x02).toBe(0x02);
    }
  });
});
