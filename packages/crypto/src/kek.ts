// The key-encryption key (PST-REQ-010, PST-ADR-009).
//
// The KEK wraps every per-blob DEK and is never written to the database. It is loaded from the
// environment (POSTROOM_KEK) or from a file, both holding standard base64 of exactly 32 bytes.
//
// A `Kek` is opaque: the raw key lives in a module-private WeakMap, not on the object, so it cannot
// leak through JSON.stringify, util.inspect, string interpolation, or a structured logger walking
// own properties. Only this package reads it back, through `kekKeyObject`.

import { createHash, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { KekLoadError } from './errors.js';

export const KEK_BYTES = 32;
/** Length of a KEK id in bytes: the first 8 bytes of SHA-256(key). */
export const KEK_ID_BYTES = 8;

const keys = new WeakMap<Kek, KeyObject>();

export class Kek {
  /** Hex of the first 8 bytes of SHA-256 of the key. Identifies the KEK without revealing it. */
  readonly id: string;

  private constructor(raw: Uint8Array) {
    if (raw.length !== KEK_BYTES) {
      throw new KekLoadError(`KEK must be exactly ${KEK_BYTES} bytes (got ${raw.length})`);
    }
    keys.set(this, createSecretKey(Buffer.from(raw)));
    this.id = kekIdOf(raw).toString('hex');
    Object.freeze(this);
  }

  /** @internal Use `loadKek`, `generateKek` or `unsealKekBundle`. */
  static fromRaw(raw: Uint8Array): Kek {
    return new Kek(raw);
  }

  /** The KEK id as bytes, as embedded in wrapped DEKs. */
  idBytes(): Buffer {
    return Buffer.from(this.id, 'hex');
  }

  toJSON(): string {
    return '[Kek]';
  }

  toString(): string {
    return '[Kek]';
  }

  [inspect.custom](): string {
    return '[Kek]';
  }
}

/** @internal The secret KeyObject for a Kek. Not exported from the package index. */
export function kekKeyObject(kek: Kek): KeyObject {
  const key = keys.get(kek);
  if (key === undefined) throw new KekLoadError('not a loaded KEK');
  return key;
}

export function kekIdOf(raw: Uint8Array): Buffer {
  return createHash('sha256').update(raw).digest().subarray(0, KEK_ID_BYTES);
}

// Standard base64 (not url-safe) of exactly 32 bytes is 43 characters and one '=' pad.
const KEK_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/** Parse base64 of exactly 32 bytes. The error never includes the input. */
export function kekFromBase64(text: string): Kek {
  const trimmed = text.trim();
  if (!KEK_BASE64.test(trimmed)) {
    throw new KekLoadError(
      `KEK must be standard base64 of exactly ${KEK_BYTES} bytes (44 characters ending in '=')`,
    );
  }
  const raw = Buffer.from(trimmed, 'base64');
  try {
    return Kek.fromRaw(raw);
  } finally {
    raw.fill(0);
  }
}

export type KekSource =
  /** Read POSTROOM_KEK from this environment (usually `process.env`). */
  | { env: Readonly<Record<string, string | undefined>> }
  /** Read a file holding the base64 key (surrounding whitespace ignored). */
  | { path: string }
  /** A base64 string supplied directly. */
  | { base64: string };

export const KEK_ENV_VAR = 'POSTROOM_KEK';

export function loadKek(source: KekSource): Kek {
  if ('env' in source) {
    const value = source.env[KEK_ENV_VAR];
    if (value === undefined || value.trim() === '') {
      throw new KekLoadError(`${KEK_ENV_VAR} is not set`);
    }
    return kekFromBase64(value);
  }
  if ('path' in source) {
    let text: string;
    try {
      text = readFileSync(source.path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
      throw new KekLoadError(`cannot read KEK file ${source.path}: ${code}`);
    }
    return kekFromBase64(text);
  }
  return kekFromBase64(source.base64);
}

/** A fresh random KEK, for first-time setup. */
export function generateKek(): Kek {
  const raw = randomBytes(KEK_BYTES);
  try {
    return Kek.fromRaw(raw);
  } finally {
    raw.fill(0);
  }
}

/**
 * The KEK as base64, for setup to hand to the operator once (to put in POSTROOM_KEK or a key
 * file). Deliberately a separate, loudly named function: nothing else exposes the key.
 */
export function exportKekBase64(kek: Kek): string {
  const raw = exportKekRaw(kek);
  try {
    return raw.toString('base64');
  } finally {
    raw.fill(0);
  }
}

/** @internal Raw key bytes; the caller must zero them. Not exported from the package index. */
export function exportKekRaw(kek: Kek): Buffer {
  return kekKeyObject(kek).export();
}
