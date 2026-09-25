// Redaction for audit before/after payloads: secrets never reach the audit log, and values that
// JSON cannot represent natively (BigInt, Buffer, Date) become a readable, safe stand-in instead
// of throwing or silently dropping the field.

const SECRET_KEY = /password|secret|token|totp|key|hash|dek|kek/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function isBufferLike(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Deep-clones an arbitrary value for storage in an audit event, redacting any value reached
 * through a key that looks secret-ish, and converting types JSON cannot hold directly.
 */
export function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) {
    return '[redacted]';
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isBufferLike(value)) {
    return `[bytes:${String(value.byteLength)}]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}
