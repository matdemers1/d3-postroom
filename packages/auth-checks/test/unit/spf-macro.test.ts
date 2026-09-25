import { describe, expect, it } from 'vitest';
import { expandMacros, SpfPermError } from '../../src/index.js';
import { macroExampleCases } from './fixtures/spf/macro-examples.js';

describe('SPF macro expansion (RFC 7208 SS7)', () => {
  for (const { name, template, ctx, expected } of macroExampleCases) {
    it(`expands ${name}`, () => {
      expect(expandMacros(template, ctx)).toBe(expected);
    });
  }

  it('expands the literal escapes %%, %_ and %-', () => {
    expect(expandMacros('%%_%_-%-', { sender: 'a@b.com', domain: 'b.com', ip: '1.2.3.4', ipVersion: 4, helo: 'b.com', inExp: false })).toBe(
      '%_ -%20',
    );
  });

  it('uppercase letters URL-escape their expansion', () => {
    const ctx = { sender: 'a b@b.com', domain: 'b.com', ip: '1.2.3.4', ipVersion: 4 as const, helo: 'b.com', inExp: false };
    expect(expandMacros('%{L}', ctx)).toBe('a%20b');
  });

  it('rejects c, r and t outside an exp= explanation', () => {
    const ctx = { sender: 'a@b.com', domain: 'b.com', ip: '1.2.3.4', ipVersion: 4 as const, helo: 'b.com', inExp: false };
    expect(() => expandMacros('%{c}', ctx)).toThrow(SpfPermError);
    expect(() => expandMacros('%{r}', ctx)).toThrow(SpfPermError);
    expect(() => expandMacros('%{t}', ctx)).toThrow(SpfPermError);
  });

  it('allows c, r and t inside an exp= explanation', () => {
    const ctx = {
      sender: 'a@b.com',
      domain: 'b.com',
      ip: '1.2.3.4',
      ipVersion: 4 as const,
      helo: 'b.com',
      inExp: true,
      receivingDomain: 'checker.example.net',
      timestamp: 1234567890,
    };
    expect(expandMacros('%{c} %{r} %{t}', ctx)).toBe('1.2.3.4 checker.example.net 1234567890');
  });

  it('rejects an unterminated or unknown macro as a syntax error', () => {
    const ctx = { sender: 'a@b.com', domain: 'b.com', ip: '1.2.3.4', ipVersion: 4 as const, helo: 'b.com', inExp: false };
    expect(() => expandMacros('%{s', ctx)).toThrow(SpfPermError);
    expect(() => expandMacros('%{q}', ctx)).toThrow(SpfPermError);
    expect(() => expandMacros('%q', ctx)).toThrow(SpfPermError);
  });
});
