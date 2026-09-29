import { describe, expect, it } from 'vitest';
import { displayNameOf } from '../../src/index.js';

describe('displayNameOf (PST-T-14.2)', () => {
  it('returns the first mailbox display name', () => {
    expect(displayNameOf('Linda Demers <linda.demers@example.com>')).toBe('Linda Demers');
    expect(displayNameOf('"Demers, Linda" <l@example.com>, Bob <b@example.com>')).toBe('Demers, Linda');
  });

  it('decodes RFC 2047 encoded-words', () => {
    expect(displayNameOf('=?UTF-8?Q?Ren=C3=A9e_L=C3=A9vesque?= <r@example.com>')).toBe('Renée Lévesque');
    expect(displayNameOf('=?UTF-8?B?5bGx55Sw?= <y@example.jp>')).toBe('山田');
  });

  it('takes the old-style comment name', () => {
    expect(displayNameOf('jane@example.com (Jane Doe)')).toBe('Jane Doe');
  });

  it('is null with no header or no name', () => {
    expect(displayNameOf(null)).toBeNull();
    expect(displayNameOf('bare@example.com')).toBeNull();
    expect(displayNameOf('"  " <x@example.com>')).toBeNull();
  });

  it('collapses folded whitespace and caps the length', () => {
    expect(displayNameOf('Linda\r\n   Demers <l@example.com>')).toBe('Linda Demers');
    expect(displayNameOf(`${'a'.repeat(500)} <a@example.com>`)?.length).toBe(200);
  });
});
