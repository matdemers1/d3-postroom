// Whether an OpenPGP key was usable when a signature was made (RFC 9580 §5.2.3.18, §5.2.3.23,
// §5.2.4, §10.1): its revocations and its expiry, read from the key's own self-signatures.
//
// Nothing in a key block is believed unverified. A self-signature (certification 0x10–0x13 over a
// user ID, direct-key 0x1F, subkey binding 0x18) says when the key expires only if it verifies
// with the primary key. A revocation (0x20 on the primary, 0x28 on a subkey) counts when it
// verifies, and also when it cannot be checked at all (an algorithm or hash this package does not
// verify) — refusing a key on an unverifiable revocation is the safe way to be wrong. A revocation
// that verifiably fails is ignored: anyone could have written it.
//
// Reason for revocation (§5.2.3.31): "superseded" (1) and "retired" (3) are soft — the key was fine
// until the revocation's own creation time. No reason, "no reason" (0) and "compromised" (2) are
// hard: nothing the key ever signed is trusted.

import { PgpError, UnsupportedError } from './errors.js';
import type { KeyMaterial, KeySignature, OpenPgpKey } from './keys.js';
import { digestFor, parseSignaturePacket, SignatureType, verifyDigest, type SignaturePacket } from './signature.js';

export interface Revocation {
  of: 'primary' | 'subkey';
  /** The revocation's creation time; null when it carries none. */
  at: Date | null;
  hard: boolean;
  reason: number | null;
  /** False when the revocation could not be verified and is honoured anyway. */
  verified: boolean;
}

export interface KeyState {
  revocations: Revocation[];
  /** When the key (the primary, or the subkey itself, whichever is sooner) stops being valid; null = never. */
  expiresAt: Date | null;
  /**
   * When the self-signature (and, for a subkey, the 0x18 binding) the key's authority rests on
   * stops being valid by its OWN signature expiration (subpacket 3, RFC 9580 §5.2.3.18): after
   * that, the statement that the key is this key, and may sign, is withdrawn — as gpg reads it.
   * Judged against the present, not the signing time. The latest valid one is read; an older one
   * without expiry never stands in for it. Null = never.
   */
  selfSignatureExpiresAt: Date | null;
}

function frame(m: KeyMaterial): Buffer {
  return Buffer.concat([Buffer.of(0x99, (m.body.length >> 8) & 0xff, m.body.length & 0xff), m.body]);
}

/** The bytes a key signature hashes before its trailer (RFC 9580 §5.2.4). */
export function keySignatureData(primary: KeyMaterial, ks: KeySignature): Buffer {
  const t = ks.target;
  if (t.kind === 'key') return frame(primary);
  if (t.kind === 'subkey') return Buffer.concat([frame(primary), frame(t.subkey)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.uid.length, 0);
  return Buffer.concat([frame(primary), Buffer.of(0xb4), len, t.uid]);
}

function byPrimary(sig: SignaturePacket, primary: KeyMaterial): boolean {
  if (sig.issuerFingerprint !== null) return sig.issuerFingerprint === primary.fingerprint;
  if (sig.issuerKeyId !== null) return sig.issuerKeyId === primary.keyId;
  return true;
}

type Check = 'valid' | 'invalid' | 'unchecked';

function check(primary: KeyMaterial, ks: KeySignature): Check {
  try {
    return verifyDigest(ks.sig, digestFor(ks.sig, keySignatureData(primary, ks)), primary, { allowSha1ForKeySignatures: true }) ? 'valid' : 'invalid';
  } catch (err) {
    if (err instanceof UnsupportedError) return 'unchecked';
    return 'invalid';
  }
}

const SOFT_REASONS = new Set([1, 3]);
const CERTIFICATIONS = new Set([0x10, 0x11, 0x12, 0x13]);

/** The latest-created signature among `sigs` that verifies, or null. */
function latestValid(primary: KeyMaterial, sigs: readonly KeySignature[]): KeySignature | null {
  let best: KeySignature | null = null;
  for (const ks of sigs) {
    if (check(primary, ks) !== 'valid') continue;
    if (best === null || (ks.sig.created?.getTime() ?? 0) > (best.sig.created?.getTime() ?? 0)) best = ks;
  }
  return best;
}

function expiryFrom(ks: KeySignature | null, created: Date): Date | null {
  const secs = ks?.sig.keyExpiresSeconds ?? null;
  return secs === null || secs === 0 ? null : new Date(created.getTime() + secs * 1000);
}

/** When a self-signature or binding itself expires (subpacket 3, counted from its creation); null = never. */
function signatureExpiry(ks: KeySignature | null): Date | null {
  const secs = ks?.sig.expiresSeconds ?? null;
  if (ks === null || secs === null || secs === 0) return null;
  return new Date((ks.sig.created?.getTime() ?? 0) + secs * 1000);
}

const sooner = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** Revocations and expiry for `material` (the primary or one of its subkeys) of `key`. */
export function keyState(key: OpenPgpKey, material: KeyMaterial): KeyState {
  const primary = key.primary;
  const isSubkey = material.fingerprint !== primary.fingerprint;
  const mine = key.signatures.filter((ks) => byPrimary(ks.sig, primary));
  const revocations: Revocation[] = [];
  for (const ks of mine) {
    const t = ks.target;
    const about = ks.sig.type === SignatureType.KeyRevocation && t.kind === 'key' ? 'primary' : ks.sig.type === SignatureType.SubkeyRevocation && t.kind === 'subkey' && t.subkey.fingerprint === material.fingerprint ? 'subkey' : null;
    if (about === null) continue;
    const c = check(primary, ks);
    if (c === 'invalid') continue;
    const reason = ks.sig.revocationReason;
    revocations.push({ of: about, at: ks.sig.created, hard: reason === null || !SOFT_REASONS.has(reason), reason, verified: c === 'valid' });
  }
  const selfSig = latestValid(
    primary,
    mine.filter((ks) => (ks.target.kind === 'uid' && CERTIFICATIONS.has(ks.sig.type)) || (ks.target.kind === 'key' && ks.sig.type === SignatureType.DirectKey)),
  );
  let expiresAt = expiryFrom(selfSig, primary.created);
  let selfSignatureExpiresAt = signatureExpiry(selfSig);
  if (isSubkey) {
    const binding = latestValid(
      primary,
      mine.filter((ks) => ks.sig.type === SignatureType.SubkeyBinding && ks.target.kind === 'subkey' && ks.target.subkey.fingerprint === material.fingerprint),
    );
    const sub = expiryFrom(binding, material.created);
    if (sub !== null && (expiresAt === null || sub < expiresAt)) expiresAt = sub;
    selfSignatureExpiresAt = sooner(selfSignatureExpiresAt, signatureExpiry(binding));
  }
  return { revocations, expiresAt, selfSignatureExpiresAt };
}

/**
 * `stored` with the revocations (0x20 on its primary, 0x28 on one of its subkeys) that a copy of
 * the same key attached to the message carries — so a revocation that reached this message before
 * it reached the account's key row is applied to this analysis (PST-T-12.5). Only revocations are
 * taken, and only from a copy whose primary fingerprint is the stored key's; each is then checked
 * against the STORED primary here and applied only if it verifies (an uncheckable one is dropped). Nothing else in an attached copy
 * (a newer self-signature, a binding, key flags, another subkey) is ever read: it can only make a
 * stored key stricter, never give it authority.
 */
export function withAttachedRevocations(stored: OpenPgpKey, attached: readonly OpenPgpKey[]): OpenPgpKey {
  const extra: KeySignature[] = [];
  for (const copy of attached) {
    if (copy.primary.fingerprint !== stored.primary.fingerprint) continue;
    for (const ks of copy.signatures) {
      const t = ks.target;
      let candidate: KeySignature | null = null;
      if (ks.sig.type === SignatureType.KeyRevocation && t.kind === 'key') candidate = { sig: ks.sig, target: { kind: 'key' } };
      else if (ks.sig.type === SignatureType.SubkeyRevocation && t.kind === 'subkey') {
        // Re-pointed at the stored subkey, so what is verified is hashed over the stored bytes.
        const mine = stored.subkeys.find((m) => m.fingerprint === t.subkey.fingerprint);
        if (mine !== undefined) candidate = { sig: ks.sig, target: { kind: 'subkey', subkey: mine } };
      }
      // An attached revocation counts only when it VERIFIES against the stored primary. A stored
      // key's own unverifiable revocation is honoured (fail safe), but one carried in by a message
      // is not: anyone can write an uncheckable one (an unknown or MD5 hash) from a public key.
      if (candidate !== null && check(stored.primary, candidate) === 'valid') extra.push(candidate);
    }
  }
  return extra.length === 0 ? stored : { ...stored, signatures: [...stored.signatures, ...extra] };
}

/** The revocation that makes a signature made at `at` untrustworthy, or null. */
export function revokedAt(state: KeyState, at: Date): Revocation | null {
  return state.revocations.find((r) => r.hard || r.at === null || r.at.getTime() <= at.getTime()) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Signing authority (PST-T-12.3): which key in a block may sign a message at all.
//
// Matching a signature's issuer against every key packet in a block is not enough: anyone can
// append their own key to a contact's exported key as a public-subkey packet (tag 14) — gpg drops
// it on import, and so must this. RFC 9580 §10.1 and §5.2.1:
//   * a subkey belongs to the key only through a subkey binding signature (0x18) made by the
//     primary over primary || subkey, that verifies (the latest one that does is the one read);
//   * a subkey may sign only when that binding carries key flag 0x02 (§5.2.3.29) AND an embedded
//     primary key binding signature (0x19, §5.2.3.34) made BY THE SUBKEY over the same bytes, that
//     verifies — the subkey's own consent to being claimed by this primary;
//   * the primary may sign only when its latest valid self-signature (a certification 0x10–0x13
//     over a user ID, or a direct-key signature 0x1F) carries key flag 0x02.
// When that self-signature has no key flags subpacket at all (RFC 2440-era keys), usage is inferred
// from the algorithm, as RFC 9580 §5.2.3.29 leaves to the implementation: a primary whose algorithm
// can sign may. A subkey never gets that inference — a signing subkey without flags cannot have the
// 0x19 back-signature a signing subkey needs, so there is nothing to infer from. gpg and Proton
// always write key flags, so their keys are judged on them.
// Revoked subkeys (0x28) are handled by keyState/revokedAt, as are revoked primaries.

export interface AuthorityProblem {
  reason: 'subkey-not-bound' | 'key-not-for-signing';
  text: string;
}

/** Key flags (subpacket 27, first octet) from a signature's hashed area; null when absent. */
export function keyFlags(sig: SignaturePacket): number | null {
  const sp = sig.hashed.find((s) => s.type === 27);
  if (sp === undefined) return null;
  return sp.body[0] ?? 0;
}

/** Public-key algorithms that can make signatures (RFC 9580 §9.1). */
const SIGNING_ALGORITHMS = new Set([1, 3, 17, 19, 22, 27, 28]);

const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/** The embedded signatures (subpacket 32) of a binding, hashed area first; unparseable ones are skipped. */
function embeddedSignatures(sig: SignaturePacket): SignaturePacket[] {
  const out: SignaturePacket[] = [];
  for (const s of [...sig.hashed, ...sig.unhashed]) {
    if (s.type !== 32) continue;
    try {
      out.push(parseSignaturePacket(s.body));
    } catch (err) {
      if (!(err instanceof PgpError)) throw err;
    }
  }
  return out;
}

/** A 0x19 primary key binding signature by `subkey` over primary || subkey that verifies. */
function backSigned(primary: KeyMaterial, subkey: KeyMaterial, binding: SignaturePacket): boolean {
  const data = keySignatureData(primary, { sig: binding, target: { kind: 'subkey', subkey } });
  for (const back of embeddedSignatures(binding)) {
    if (back.type !== 0x19) continue;
    try {
      if (verifyDigest(back, digestFor(back, data), subkey, { allowSha1ForKeySignatures: true })) return true;
    } catch (err) {
      if (!(err instanceof PgpError)) throw err;
    }
  }
  return false;
}

/**
 * Why `material` (the primary or a subkey of `key`) may not sign messages, or null when it may.
 * Applies to a key from the account's keyring and one attached to the message alike.
 */
export function signingAuthority(key: OpenPgpKey, material: KeyMaterial): AuthorityProblem | null {
  const primary = key.primary;
  const mine = key.signatures.filter((ks) => byPrimary(ks.sig, primary));
  if (material === primary || material.fingerprint === primary.fingerprint) {
    const self = latestValid(
      primary,
      mine.filter((ks) => (ks.target.kind === 'uid' && CERTIFICATIONS.has(ks.sig.type)) || (ks.target.kind === 'key' && ks.sig.type === SignatureType.DirectKey)),
    );
    if (self === null) return { reason: 'key-not-for-signing', text: 'the key carries no self-signature that verifies, so nothing in it says the key may sign (RFC 9580 §5.2.3.29)' };
    const flags = keyFlags(self.sig);
    if (flags === null) {
      if (SIGNING_ALGORITHMS.has(primary.algorithm)) return null;
      return { reason: 'key-not-for-signing', text: `the key's self-signature has no key flags, and its algorithm (${primary.algorithmName}) cannot sign` };
    }
    if ((flags & 0x02) === 0) return { reason: 'key-not-for-signing', text: `the key's self-signature grants key flags ${hex2(flags)}, without 0x02 (sign data): the key may not sign messages (RFC 9580 §5.2.3.29)` };
    return null;
  }
  const binding = latestValid(
    primary,
    mine.filter((ks) => ks.sig.type === SignatureType.SubkeyBinding && ks.target.kind === 'subkey' && ks.target.subkey.fingerprint === material.fingerprint),
  );
  if (binding === null) {
    return { reason: 'subkey-not-bound', text: `the signing key ${material.fingerprint} sits in the key block as a subkey, but no subkey binding signature (0x18) by the primary key ${primary.fingerprint} verifies for it: it is not part of this key, and anyone could have appended it` };
  }
  const flags = keyFlags(binding.sig);
  if (flags === null || (flags & 0x02) === 0) {
    return { reason: 'key-not-for-signing', text: `the subkey ${material.fingerprint} is bound with key flags ${flags === null ? '(none)' : hex2(flags)}, without 0x02 (sign data): it may not sign messages (RFC 9580 §5.2.3.29)` };
  }
  if (!backSigned(primary, material, binding.sig)) {
    return { reason: 'subkey-not-bound', text: `the signing subkey ${material.fingerprint} has no primary key binding signature (0x19) of its own that verifies, so it never agreed to belong to ${primary.fingerprint} (RFC 9580 §5.2.3.34)` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Encryption capability (PST-T-12.2): which key in a block a message is encrypted to.
//
// A subkey counts only through a subkey binding (0x18) by the primary that verifies and grants key
// flag 0x04 or 0x08 (RFC 9580 §5.2.3.29); the primary only when its latest valid self-signature
// grants one of them (or carries no flags at all and its algorithm can only be RSA). Revoked and
// expired keys are skipped. Algorithms the writer cannot encrypt to are skipped with a reason.

/** Public-key algorithms the writer can make a PKESK for: RSA (1, 2) and ECDH over Curve25519Legacy (18). */
export function canEncryptTo(m: KeyMaterial): boolean {
  if (m.publicKey === null) return false;
  if (m.algorithm === 1 || m.algorithm === 2) return true;
  return m.algorithm === 18 && m.curveOid === '2b060104019755010501';
}

function usable(key: OpenPgpKey, m: KeyMaterial, now: Date): boolean {
  const state = keyState(key, m);
  if (state.revocations.length > 0) return false;
  if (state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime()) return false;
  return state.selfSignatureExpiresAt === null || state.selfSignatureExpiresAt.getTime() > now.getTime();
}

/**
 * The key materials of `key` a message may be encrypted to at `now`, newest subkey first. Empty
 * when there is none; `reason` then says why.
 */
export function encryptionMaterials(key: OpenPgpKey, now: Date = new Date()): { materials: KeyMaterial[]; reason: string | null } {
  const primary = key.primary;
  const mine = key.signatures.filter((ks) => byPrimary(ks.sig, primary));
  if (!usable(key, primary, now)) return { materials: [], reason: 'the key is revoked or expired' };
  const out: KeyMaterial[] = [];
  let unsupported = false;
  const subkeys = [...key.subkeys].sort((a, b) => b.created.getTime() - a.created.getTime());
  for (const sub of subkeys) {
    const binding = latestValid(
      primary,
      mine.filter((ks) => ks.sig.type === SignatureType.SubkeyBinding && ks.target.kind === 'subkey' && ks.target.subkey.fingerprint === sub.fingerprint),
    );
    if (binding === null) continue;
    const flags = keyFlags(binding.sig);
    if (flags === null || (flags & 0x0c) === 0 || !usable(key, sub, now)) continue;
    if (canEncryptTo(sub)) out.push(sub);
    else unsupported = true;
  }
  if (out.length === 0) {
    const self = latestValid(
      primary,
      mine.filter((ks) => (ks.target.kind === 'uid' && CERTIFICATIONS.has(ks.sig.type)) || (ks.target.kind === 'key' && ks.sig.type === SignatureType.DirectKey)),
    );
    const flags = self === null ? null : keyFlags(self.sig);
    const allowed = flags === null ? primary.algorithm === 1 || primary.algorithm === 2 : (flags & 0x0c) !== 0;
    if (self !== null && allowed) {
      if (canEncryptTo(primary)) out.push(primary);
      else unsupported = true;
    }
  }
  if (out.length > 0) return { materials: out, reason: null };
  return { materials: [], reason: unsupported ? 'the key can encrypt only with an algorithm Postroom does not write (only RSA and Curve25519 ECDH)' : 'the key has no subkey or primary that may encrypt' };
}

/** The key materials of `key` that may sign now, with a secret half loaded: primary first. */
export function signingMaterials(key: OpenPgpKey): KeyMaterial[] {
  return [key.primary, ...key.subkeys].filter((m) => m.secretKey !== null && [1, 3, 22, 27].includes(m.algorithm) && signingAuthority(key, m) === null);
}
