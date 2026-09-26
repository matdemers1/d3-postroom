import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/redact.js';

// An independent oracle: real-world secret-ish field names, kept separate from redact.ts's own
// regex on purpose. A property test that reused the implementation's regex as its own oracle
// could never catch a gap in that regex — this list is what actually has to stay covered.
const KNOWN_SECRET_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'totp',
  'otp',
  'pin',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'setCookie',
  'sessionCookie',
  'session',
  'credential',
  'privateKey',
  'bearer',
  'signature',
  'seed',
  'passwordHash',
  'totpSecret',
  'wrappedDek',
  'kekId',
] as const;

describe('redact', () => {
  it('redacts a top-level secret-ish key', () => {
    expect(redact({ password: 'hunter2' })).toEqual({ password: '[redacted]' });
    expect(redact({ apiToken: 'abc' })).toEqual({ apiToken: '[redacted]' });
    expect(redact({ TOTP_SECRET: 'xyz' })).toEqual({ TOTP_SECRET: '[redacted]' });
  });

  it('redacts keys the original narrower regex missed: passwd, authorization, cookie, and variants', () => {
    expect(redact({ passwd: 'x' })).toEqual({ passwd: '[redacted]' });
    expect(redact({ pwd: 'x' })).toEqual({ pwd: '[redacted]' });
    expect(redact({ authorization: 'x' })).toEqual({ authorization: '[redacted]' });
    expect(redact({ Authorization: 'x' })).toEqual({ Authorization: '[redacted]' });
    expect(redact({ cookie: 'x' })).toEqual({ cookie: '[redacted]' });
    expect(redact({ Cookie: 'x' })).toEqual({ Cookie: '[redacted]' });
    expect(redact({ sessionCookie: 'x' })).toEqual({ sessionCookie: '[redacted]' });
    expect(redact({ credential: 'x' })).toEqual({ credential: '[redacted]' });
    expect(redact({ privateKey: 'x' })).toEqual({ privateKey: '[redacted]' });
    expect(redact({ otp: 'x' })).toEqual({ otp: '[redacted]' });
    expect(redact({ pin: 'x' })).toEqual({ pin: '[redacted]' });
    expect(redact({ apikey: 'x' })).toEqual({ apikey: '[redacted]' });
    expect(redact({ api_key: 'x' })).toEqual({ api_key: '[redacted]' });
    expect(redact({ bearer: 'x' })).toEqual({ bearer: '[redacted]' });
    expect(redact({ signature: 'x' })).toEqual({ signature: '[redacted]' });
    expect(redact({ seed: 'x' })).toEqual({ seed: '[redacted]' });
  });

  it('redacts a bearer/basic auth string by value, regardless of its key name', () => {
    expect(redact({ header: 'Bearer eyJhbGciOi.abc.def' })).toEqual({ header: '[redacted]' });
    expect(redact({ value: 'Basic dXNlcjpwYXNz' })).toEqual({ value: '[redacted]' });
    expect(redact({ value: 'bearer abc' })).toEqual({ value: '[redacted]' });
  });

  it('redacts nested secret-ish keys inside objects and arrays', () => {
    const input = {
      account: { id: '1', meta: { passwordHash: 'h', label: 'x' } },
      items: [{ appPasswordHash: 'y' }, { fine: 'ok' }],
    };
    expect(redact(input)).toEqual({
      account: { id: '1', meta: { passwordHash: '[redacted]', label: 'x' } },
      items: [{ appPasswordHash: '[redacted]' }, { fine: 'ok' }],
    });
  });

  it('redacts a whole subtree whose own key looks secret-ish, e.g. "credentials"', () => {
    expect(redact({ account: { id: '1', credentials: { passwordHash: 'h', label: 'x' } } })).toEqual({
      account: { id: '1', credentials: '[redacted]' },
    });
  });

  it('leaves non-secret keys untouched', () => {
    expect(redact({ displayName: 'Matt', isAdmin: true })).toEqual({ displayName: 'Matt', isAdmin: true });
  });

  it('stringifies BigInt', () => {
    expect(redact({ modseq: 42n })).toEqual({ modseq: '42' });
  });

  it('summarizes Buffer/Uint8Array by length', () => {
    expect(redact({ nonce: Buffer.alloc(12) })).toEqual({ nonce: '[bytes:12]' });
    expect(redact({ raw: new Uint8Array(5) })).toEqual({ raw: '[bytes:5]' });
  });

  it('formats Date as ISO', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(redact({ createdAt: d })).toEqual({ createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('passes through primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact(5)).toBe(5);
    expect(redact('hi')).toBe('hi');
    expect(redact(true)).toBe(true);
  });

  it('property: never leaves a value under a known secret-ish key, at the top level or nested one level deep', () => {
    // The oracle here is KNOWN_SECRET_KEYS, not redact.ts's own regex, so this can actually catch
    // a name the implementation forgot — unlike testing a regex against itself.
    const secretKeyArb = fc.constantFrom(...KNOWN_SECRET_KEYS);
    const benignKeyArb = fc.constantFrom('id', 'name', 'label', 'displayName', 'isAdmin', 'count', 'kind');
    const jsonValue = fc.jsonValue();
    const flatArb = fc.dictionary(fc.oneof(secretKeyArb, benignKeyArb), jsonValue);
    const nestedArb = fc.record({ inner: flatArb }).map((r) => ({ nested: r.inner }));

    fc.assert(
      fc.property(fc.oneof(flatArb, nestedArb), (obj) => {
        const result = redact(obj) as Record<string, unknown>;
        const flatKeys = Object.keys(obj).includes('nested')
          ? (obj as { nested: Record<string, unknown> }).nested
          : (obj as Record<string, unknown>);
        const flatResult = Object.keys(result).includes('nested')
          ? ((result['nested'] as Record<string, unknown> | undefined) ?? {})
          : result;
        for (const secretKey of KNOWN_SECRET_KEYS) {
          if (secretKey in flatKeys) {
            expect(flatResult[secretKey]).toBe('[redacted]');
          }
        }
      }),
    );
  });

  it('property: never throws on arbitrary composite values including BigInt/Date/Buffer', () => {
    const leaf = fc.oneof(
      fc.jsonValue(),
      fc.bigInt(),
      fc.date(),
      fc.uint8Array(),
    );
    const arb = fc.dictionary(fc.string(), leaf);
    fc.assert(
      fc.property(arb, (obj) => {
        expect(() => redact(obj)).not.toThrow();
      }),
    );
  });
});

describe('redact: invalid dates', () => {
  it('records an invalid Date as a string instead of throwing', () => {
    expect(redact({ at: new Date(Number.NaN) })).toEqual({ at: 'Invalid Date' });
  });
});
