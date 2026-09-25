// Blob naming and constant-time comparison.

import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex of a buffer; blobs are named by the SHA-256 of their plaintext (PST-ADR-009). */
export function sha256Hex(input: Uint8Array | string): string;
/** SHA-256 hex of a stream, read incrementally. */
export function sha256Hex(input: AsyncIterable<Uint8Array | string>): Promise<string>;
export function sha256Hex(
  input: Uint8Array | string | AsyncIterable<Uint8Array | string>,
): string | Promise<string> {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return createHash('sha256').update(input).digest('hex');
  }
  return (async () => {
    const hash = createHash('sha256');
    for await (const chunk of input) hash.update(chunk);
    return hash.digest('hex');
  })();
}

/**
 * Constant-time string equality. Both sides are hashed first so neither the content nor the
 * length of the secret leaks through timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
