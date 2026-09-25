// The KEK recovery bundle (PST-REQ-011, PST-ADR-009).
//
// The KEK, sealed with a key derived from the operator's passphrase, stored beside the backups.
// The passphrase lives in the operator's password manager; the bundle alone is useless.
//
//   derived = Argon2id(passphrase, salt 16 random bytes, m KiB, t passes, p lanes) -> 32 bytes raw
//   ct      = AES-256-GCM(derived, nonce 12 random, aad = canonical header, KEK) || tag
//   header  = "postroom-kek-bundle" | v | kdf | m | t | p | salt | kekId | createdAt
//
// Every field other than nonce and ct is in the AAD, so editing a parameter, the salt, the KEK id
// or the date makes the bundle fail to open rather than open to something else. After opening, the
// recovered key's id must equal the recorded kekId. Any failure is a BundleUnsealError; a wrong
// passphrase can never yield a key.
//
// Unsealing bounds the KDF cost fields, so a tampered bundle cannot ask for 1 TiB of memory.

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { gcmOpen, gcmSeal, NONCE_BYTES } from './aead.js';
import { BundleUnsealError } from './errors.js';
import { exportKekRaw, Kek } from './kek.js';

export const BUNDLE_VERSION = 1;
const SALT_BYTES = 16;

export interface KdfParams {
  /** Memory cost in KiB. Default 65536 (64 MiB). */
  memoryCost: number;
  /** Passes. Default 3. */
  timeCost: number;
  /** Lanes. Default 1. */
  parallelism: number;
}

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
});

// Accepted on unseal. The lower bounds are argon2's own; the upper ones stop a tampered bundle
// from exhausting the machine doing the recovery.
const LIMITS = {
  memoryCost: { min: 8, max: 4 * 1024 * 1024 },
  timeCost: { min: 1, max: 64 },
  parallelism: { min: 1, max: 16 },
} as const;

export interface KekBundle {
  v: 1;
  kdf: 'argon2id';
  m: number;
  t: number;
  p: number;
  /** base64 */
  salt: string;
  /** base64 */
  nonce: string;
  /** base64, ciphertext || tag */
  ct: string;
  kekId: string;
  /** ISO 8601 */
  createdAt: string;
}

export interface SealOptions {
  kdf?: Partial<KdfParams>;
  now?: Date;
}

function header(b: Omit<KekBundle, 'nonce' | 'ct'>): Buffer {
  return Buffer.from(
    ['postroom-kek-bundle', b.v, b.kdf, b.m, b.t, b.p, b.salt, b.kekId, b.createdAt].join('|'),
    'utf8',
  );
}

async function derive(passphrase: string, salt: Buffer, m: number, t: number, p: number): Promise<Buffer> {
  return argon2.hash(passphrase, {
    type: argon2.argon2id,
    raw: true,
    hashLength: 32,
    memoryCost: m,
    timeCost: t,
    parallelism: p,
    salt,
  });
}

export async function sealKekBundle(kek: Kek, passphrase: string, opts: SealOptions = {}): Promise<KekBundle> {
  if (passphrase.length === 0) throw new RangeError('passphrase must not be empty');
  const params: KdfParams = { ...DEFAULT_KDF_PARAMS, ...opts.kdf };
  checkParams(params.memoryCost, params.timeCost, params.parallelism, RangeError);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const meta = {
    v: BUNDLE_VERSION,
    kdf: 'argon2id',
    m: params.memoryCost,
    t: params.timeCost,
    p: params.parallelism,
    salt: salt.toString('base64'),
    kekId: kek.id,
    createdAt: (opts.now ?? new Date()).toISOString(),
  } as const;
  const derived = await derive(passphrase, salt, meta.m, meta.t, meta.p);
  const raw = exportKekRaw(kek);
  try {
    const ct = gcmSeal(derived, nonce, header(meta), raw);
    return { ...meta, nonce: nonce.toString('base64'), ct: ct.toString('base64') };
  } finally {
    raw.fill(0);
    derived.fill(0);
  }
}

/** The bundle as the JSON text written beside the backups. */
export function serializeKekBundle(bundle: KekBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function checkParams(
  m: unknown,
  t: unknown,
  p: unknown,
  ErrorType: new (message: string) => Error,
): void {
  const values = { memoryCost: m, timeCost: t, parallelism: p };
  for (const name of ['memoryCost', 'timeCost', 'parallelism'] as const) {
    const value = values[name];
    const { min, max } = LIMITS[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new ErrorType(`bundle ${name} must be an integer in [${min}, ${max}]`);
    }
  }
  if ((m as number) < 8 * (p as number)) {
    throw new ErrorType('bundle memoryCost must be at least 8 KiB per lane');
  }
}

function field(obj: Record<string, unknown>, name: string): string {
  const value = obj[name];
  if (typeof value !== 'string') throw new BundleUnsealError(`bundle field ${name} is missing`);
  return value;
}

function parse(input: KekBundle | string): KekBundle {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      throw new BundleUnsealError('bundle is not valid JSON');
    }
  }
  if (typeof obj !== 'object' || obj === null) throw new BundleUnsealError('bundle is not an object');
  const o = obj as Record<string, unknown>;
  if (o.v !== BUNDLE_VERSION) throw new BundleUnsealError('unsupported bundle version');
  if (o.kdf !== 'argon2id') throw new BundleUnsealError('unsupported bundle KDF');
  checkParams(o.m, o.t, o.p, BundleUnsealError);
  return {
    v: BUNDLE_VERSION,
    kdf: 'argon2id',
    m: o.m as number,
    t: o.t as number,
    p: o.p as number,
    salt: field(o, 'salt'),
    nonce: field(o, 'nonce'),
    ct: field(o, 'ct'),
    kekId: field(o, 'kekId'),
    createdAt: field(o, 'createdAt'),
  };
}

/** Recover the KEK. Throws BundleUnsealError on a wrong passphrase or any tampering. */
export async function unsealKekBundle(input: KekBundle | string, passphrase: string): Promise<Kek> {
  const b = parse(input);
  const salt = Buffer.from(b.salt, 'base64');
  const nonce = Buffer.from(b.nonce, 'base64');
  const ct = Buffer.from(b.ct, 'base64');
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) {
    throw new BundleUnsealError('bundle salt or nonce has the wrong length');
  }
  const derived = await derive(passphrase, salt, b.m, b.t, b.p);
  let raw: Buffer;
  try {
    raw = gcmOpen(derived, nonce, header(b), ct);
  } catch {
    throw new BundleUnsealError('wrong passphrase or tampered bundle');
  } finally {
    derived.fill(0);
  }
  try {
    const kek = Kek.fromRaw(raw);
    if (kek.id !== b.kekId) throw new BundleUnsealError('recovered key does not match the bundle kekId');
    return kek;
  } catch (err) {
    if (err instanceof BundleUnsealError) throw err;
    throw new BundleUnsealError('bundle does not hold a valid KEK');
  } finally {
    raw.fill(0);
  }
}
