import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/redact.js';

const SECRET_KEY = /password|secret|token|totp|key|hash|dek|kek/i;

describe('redact', () => {
  it('redacts a top-level secret-ish key', () => {
    expect(redact({ password: 'hunter2' })).toEqual({ password: '[redacted]' });
    expect(redact({ apiToken: 'abc' })).toEqual({ apiToken: '[redacted]' });
    expect(redact({ TOTP_SECRET: 'xyz' })).toEqual({ TOTP_SECRET: '[redacted]' });
  });

  it('redacts nested secret-ish keys inside objects and arrays', () => {
    const input = {
      account: { id: '1', credentials: { passwordHash: 'h', label: 'x' } },
      items: [{ appPasswordHash: 'y' }, { fine: 'ok' }],
    };
    expect(redact(input)).toEqual({
      account: { id: '1', credentials: { passwordHash: '[redacted]', label: 'x' } },
      items: [{ appPasswordHash: '[redacted]' }, { fine: 'ok' }],
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

  it('property: never leaves a value under a secret-ish key, and never throws, over arbitrary JSON-ish input', () => {
    const secretKeyArb = fc.constantFrom('password', 'secret', 'token', 'apiKey', 'passwordHash', 'totpSecret', 'wrappedDek', 'kekId');
    const jsonValue = fc.jsonValue();
    const objectArb = fc.dictionary(fc.oneof(secretKeyArb, fc.string()), jsonValue);

    fc.assert(
      fc.property(objectArb, (obj) => {
        const result = redact(obj) as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          if (SECRET_KEY.test(key)) {
            expect(result[key]).toBe('[redacted]');
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
