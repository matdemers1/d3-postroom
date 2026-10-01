// PST-T-16.7 (PST-REQ-197): recovery codes are ten distinct, CSPRNG-drawn codes from an
// unambiguous alphabet; typing is forgiving; the stored hash is peppered Argon2id; and a code is
// spent by a conditional update that only one caller can win.
import { describe, expect, it } from 'vitest';
import {
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
  matchRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  replaceRecoveryCodes,
  spendRecoveryCode,
} from '../../src/auth/recovery.js';

const PEPPER = 'unit-pepper-0123456789abcdef';

describe('the alphabet', () => {
  it('is 32 distinct symbols with nothing that reads as something else', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_ALPHABET).size).toBe(32);
    for (const ambiguous of ['I', 'L', 'O', 'U']) expect(RECOVERY_ALPHABET).not.toContain(ambiguous);
  });
});

describe('generating', () => {
  it('ten distinct ten-symbol codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      for (const ch of code) expect(RECOVERY_ALPHABET).toContain(ch);
    }
  });

  it('uses every symbol, roughly evenly (an unbiased draw)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2_000; i++) for (const ch of generateRecoveryCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    // 20,000 symbols over 32 → ~625 each; a biased mask would starve or flood some symbols.
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(450);
      expect(n).toBeLessThan(800);
    }
  });

  it('shows a code as two groups of five', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });
});

describe('normalizing what was typed', () => {
  it('ignores case, spaces and dashes', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('  ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ab cd–ef gh jk')).toBe('ABCDEFGHJK');
  });

  it('reads I and L as 1 and O as 0, the way the alphabet intends', () => {
    expect(normalizeRecoveryCode('IL0O0-11111')).toBe('1100011111');
  });

  it('is null for anything that cannot be a recovery code — including a six-digit TOTP code', () => {
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('123 456')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE-FGHJ')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE-FGHJKM')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE-FGHJU')).toBeNull();
    expect(normalizeRecoveryCode('ABCDE_FGHJK')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });

  it('round-trips every generated code through its display form', () => {
    for (const code of generateRecoveryCodes()) {
      expect(normalizeRecoveryCode(formatRecoveryCode(code))).toBe(code);
      expect(normalizeRecoveryCode(formatRecoveryCode(code).toLowerCase())).toBe(code);
    }
  });
});

describe('hashing and matching', () => {
  it('stores peppered Argon2id, never the code, and matches only with the right code and pepper', async () => {
    const codes = generateRecoveryCodes(3);
    const hashes = await hashRecoveryCodes(codes, PEPPER);
    expect(hashes).toHaveLength(3);
    for (const [i, hash] of hashes.entries()) {
      expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$/);
      expect(hash).not.toContain(codes[i]);
    }
    const rows = hashes.map((codeHash, i) => ({ id: `row-${String(i)}`, codeHash }));
    expect(await matchRecoveryCode(rows, codes[1] ?? '', PEPPER)).toBe('row-1');
    expect(await matchRecoveryCode(rows, 'ZZZZZZZZZZ', PEPPER)).toBeNull();
    expect(await matchRecoveryCode(rows, codes[1] ?? '', 'another-pepper-0123456789')).toBeNull();
    expect(await matchRecoveryCode([{ id: 'corrupt', codeHash: 'not a hash' }], codes[0] ?? '', PEPPER)).toBeNull();
  });
});

describe('spending and replacing (the transaction half)', () => {
  /** A stand-in for the one table these touch, with Postgres's row semantics for the calls used. */
  function fakeTx() {
    const rows: { id: string; accountId: string; codeHash: string; usedAt: Date | null; createdAt: Date }[] = [];
    const calls: unknown[] = [];
    const tx = {
      recoveryCode: {
        updateMany: ({ where, data }: { where: { id: string; accountId: string; usedAt: null }; data: { usedAt: Date } }) => {
          calls.push(where);
          let count = 0;
          for (const row of rows) {
            if (row.id === where.id && row.accountId === where.accountId && row.usedAt === where.usedAt) {
              row.usedAt = data.usedAt;
              count += 1;
            }
          }
          return Promise.resolve({ count });
        },
        deleteMany: ({ where }: { where: { accountId: string } }) => {
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.accountId === where.accountId) rows.splice(i, 1);
          return Promise.resolve({ count: before - rows.length });
        },
        createMany: ({ data }: { data: { accountId: string; codeHash: string; createdAt: Date }[] }) => {
          for (const d of data) rows.push({ id: `id-${String(rows.length)}-${d.codeHash}`, usedAt: null, ...d });
          return Promise.resolve({ count: data.length });
        },
      },
    };
    return { tx: tx as unknown as Parameters<typeof spendRecoveryCode>[0], rows, calls };
  }

  it('spends a code only while it is unused: the first use wins, the second is refused', async () => {
    const { tx, rows, calls } = fakeTx();
    rows.push({ id: 'c1', accountId: 'a1', codeHash: 'h', usedAt: null, createdAt: new Date() });
    const at = new Date('2026-10-01T12:00:00Z');
    expect(await spendRecoveryCode(tx, 'a1', 'c1', at)).toBe(true);
    expect(rows[0]?.usedAt).toEqual(at);
    expect(await spendRecoveryCode(tx, 'a1', 'c1', at)).toBe(false);
    // The guard is in the statement itself, not a read before it.
    expect(calls).toEqual([
      { id: 'c1', accountId: 'a1', usedAt: null },
      { id: 'c1', accountId: 'a1', usedAt: null },
    ]);
  });

  it('never spends another account’s code', async () => {
    const { tx, rows } = fakeTx();
    rows.push({ id: 'c1', accountId: 'a1', codeHash: 'h', usedAt: null, createdAt: new Date() });
    expect(await spendRecoveryCode(tx, 'a2', 'c1', new Date())).toBe(false);
    expect(rows[0]?.usedAt).toBeNull();
  });

  it('replacing removes the whole old set, used and unused, and leaves other accounts alone', async () => {
    const { tx, rows } = fakeTx();
    rows.push(
      { id: 'old1', accountId: 'a1', codeHash: 'h1', usedAt: new Date(), createdAt: new Date() },
      { id: 'old2', accountId: 'a1', codeHash: 'h2', usedAt: null, createdAt: new Date() },
      { id: 'other', accountId: 'a2', codeHash: 'h3', usedAt: null, createdAt: new Date() },
    );
    const replaced = await replaceRecoveryCodes(tx, 'a1', ['n1', 'n2', 'n3'], new Date());
    expect(replaced).toBe(2);
    expect(rows.filter((r) => r.accountId === 'a1').map((r) => r.codeHash)).toEqual(['n1', 'n2', 'n3']);
    expect(rows.filter((r) => r.accountId === 'a2')).toHaveLength(1);
  });
});
