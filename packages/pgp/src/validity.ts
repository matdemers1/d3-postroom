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

import { UnsupportedError } from './errors.js';
import type { KeyMaterial, KeySignature, OpenPgpKey } from './keys.js';
import { digestFor, SignatureType, verifyDigest, type SignaturePacket } from './signature.js';

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
  if (isSubkey) {
    const binding = latestValid(
      primary,
      mine.filter((ks) => ks.sig.type === SignatureType.SubkeyBinding && ks.target.kind === 'subkey' && ks.target.subkey.fingerprint === material.fingerprint),
    );
    const sub = expiryFrom(binding, material.created);
    if (sub !== null && (expiresAt === null || sub < expiresAt)) expiresAt = sub;
  }
  return { revocations, expiresAt };
}

/** The revocation that makes a signature made at `at` untrustworthy, or null. */
export function revokedAt(state: KeyState, at: Date): Revocation | null {
  return state.revocations.find((r) => r.hard || r.at === null || r.at.getTime() <= at.getTime()) ?? null;
}
