import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BASE32_ALPHABET,
  PACKAGE,
  PREFIX_LENGTH,
  SECRET_LENGTH,
  generateAppPassword,
  groupForDisplay,
  parseAppPassword,
  randomBase32,
} from '../../src/index.js';

describe('@postroom/credentials', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/credentials');
  });
});

describe('generateAppPassword', () => {
  it('is 8 prefix + 20 secret base32 characters, shown in groups of four', () => {
    const g = generateAppPassword();
    expect(PREFIX_LENGTH).toBe(8);
    expect(SECRET_LENGTH).toBeGreaterThanOrEqual(20);
    expect(g.normalized).toMatch(/^[a-z2-7]{28}$/);
    expect(g.prefix).toBe(g.normalized.slice(0, 8));
    expect(g.display).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){6}$/);
    // The first two groups are the prefix, so the display is `<prefix>-<secret…>`.
    expect(g.display.replace('-', '').slice(0, 8)).toBe(g.prefix);
    expect(g.display.startsWith(`${g.prefix.slice(0, 4)}-${g.prefix.slice(4)}-`)).toBe(true);
  });

  it('carries at least 100 bits in the secret (5 bits per character, uniform)', () => {
    expect(SECRET_LENGTH * Math.log2(BASE32_ALPHABET.length)).toBeGreaterThanOrEqual(100);
    // Every one of the 256 byte values maps to a character, 8 bytes per character: unbiased.
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const counts = new Map<string, number>();
    for (const ch of randomBase32(256, () => all)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
  });

  it('draws from the whole alphabet and does not repeat', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const g = generateAppPassword();
      seen.add(g.normalized);
      for (const c of g.normalized) chars.add(c);
    }
    expect(seen.size).toBe(2_000);
    expect(chars.size).toBe(32);
  });

  it('is deterministic in its randomness source (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 28, maxLength: 28 }), (bytes) => {
        const g = generateAppPassword(() => Buffer.from(bytes));
        expect(g.normalized).toHaveLength(28);
        expect(/^[a-z2-7]+$/.test(g.normalized)).toBe(true);
        expect(parseAppPassword(g.display)).toEqual({ prefix: g.prefix, normalized: g.normalized });
      }),
    );
  });
});

describe('parseAppPassword', () => {
  const base32 = fc.string({ unit: fc.constantFrom(...BASE32_ALPHABET.split('')), minLength: 28, maxLength: 28 });

  it('round-trips any grouping, case or spacing a user might type', () => {
    fc.assert(
      fc.property(base32, fc.constantFrom('-', ' ', '', '  '), fc.boolean(), (normalized, sep, upper) => {
        const typed = groupForDisplay(normalized).replaceAll('-', sep);
        const parsed = parseAppPassword(upper ? typed.toUpperCase() : typed);
        expect(parsed).toEqual({ prefix: normalized.slice(0, 8), normalized });
      }),
    );
  });

  it('accepts the plain `<prefix>-<secret>` form', () => {
    const g = generateAppPassword();
    expect(parseAppPassword(`${g.prefix}-${g.normalized.slice(8)}`)).toEqual({ prefix: g.prefix, normalized: g.normalized });
  });

  it('refuses anything that cannot be an app password', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const parsed = parseAppPassword(s);
        if (parsed !== null) expect(parsed.normalized).toMatch(/^[a-z2-7]{28}$/);
      }),
    );
    expect(parseAppPassword('correct horse battery staple')).toBeNull();
    expect(parseAppPassword('a'.repeat(27))).toBeNull();
    expect(parseAppPassword('a'.repeat(29))).toBeNull();
    expect(parseAppPassword('0'.repeat(28))).toBeNull();
    expect(parseAppPassword('a'.repeat(200))).toBeNull();
  });
});
