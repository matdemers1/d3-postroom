// Shared access to the interop fixtures made by test/fixtures/make-fixtures.sh (throwaway test
// identities only: alice Ed25519+Curve25519, bob RSA-3072, carol S/MIME under a test CA).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnownKey } from '../../src/index.js';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));
export const text = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

export const ALICE_FPR = text('alice-ed25519.fpr').trim();
export const BOB_FPR = text('bob-rsa3072.fpr').trim();

export function alice(owner: 'own' | 'contact' = 'contact', withPrivate = false): KnownKey {
  return {
    id: `alice-${owner}`,
    kind: 'pgp',
    owner,
    address: 'alice@example.test',
    fingerprint: ALICE_FPR,
    publicKey: text('alice-ed25519.pub.asc'),
    openPrivate: withPrivate ? () => Promise.resolve(text('alice-ed25519.TEST-ONLY.sec.asc')) : undefined,
  };
}

export function bob(owner: 'own' | 'contact' = 'contact', withPrivate = false): KnownKey {
  return {
    id: `bob-${owner}`,
    kind: 'pgp',
    owner,
    address: 'bob@example.test',
    fingerprint: BOB_FPR,
    publicKey: text('bob-rsa3072.pub.asc'),
    openPrivate: withPrivate ? () => Promise.resolve(text('bob-rsa3072.TEST-ONLY.sec.asc')) : undefined,
  };
}

export function carol(owner: 'own' | 'contact' = 'contact', withPrivate = false): KnownKey {
  return {
    id: `carol-${owner}`,
    kind: 'smime',
    owner,
    address: 'carol@example.test',
    fingerprint: 'see-certificate',
    publicKey: text('carol-smime.pem'),
    openPrivate: withPrivate ? () => Promise.resolve(text('carol-smime.TEST-ONLY.key.pem')) : undefined,
  };
}

/** Flip one byte of the first occurrence of `needle` in `buf` (a body byte, never a boundary). */
export function tamper(buf: Buffer, needle: string): Buffer {
  const at = buf.indexOf(needle);
  if (at < 0) throw new Error(`needle ${needle} not found`);
  const out = Buffer.from(buf);
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
}

/** Feed a buffer in small, irregular chunks, as a blob stream would. */
export function* chunked(buf: Buffer, size = 37): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
