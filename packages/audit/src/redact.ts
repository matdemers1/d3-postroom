// Redaction for audit before/after payloads: secrets never reach the audit log, and values that
// JSON cannot represent natively (BigInt, Buffer, Date) become a readable, safe stand-in instead
// of throwing or silently dropping the field.
//
// Broader than "obviously named" secrets on purpose: a session cookie or an Authorization header
// forwarded into a before/after payload must not leak verbatim into the append-only audit_event
// table, so both the key list and a value-side check for bearer/basic-auth-shaped strings apply.

const SECRET_KEY =
  /password|passwd|pwd|pass\b|secret|token|totp|otp|pin\b|key|hash|dek|kek|authorization|cookie|session|credential|private|apikey|api_key|bearer|signature|seed/i;

// Catches a raw "Bearer <token>" / "Basic <base64>" credential value that ended up under an
// innocuously-named key (e.g. `header`, `value`), so it never lands in the audit log unredacted.
const SECRET_VALUE = /^(bearer|basic)\s+\S+/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function isBufferLike(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Deep-clones an arbitrary value for storage in an audit event, redacting any value reached
 * through a key that looks secret-ish (or that looks like a bearer/basic auth credential by
 * shape, regardless of its key), and converting types JSON cannot hold directly.
 */
export function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) {
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
    // An invalid Date (new Date(NaN)) would make toISOString throw — and an audit write must never
    // fail because of what it was asked to record.
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
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
