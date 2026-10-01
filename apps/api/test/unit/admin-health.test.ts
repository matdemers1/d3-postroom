// PST-T-16.5 (PST-DA-033): the health tiles' details are pluralised at the source, never "(s)".
import { describe, expect, it } from 'vitest';
import { countOf } from '../../src/admin-health/index.js';

describe('countOf', () => {
  it('puts the noun in the right number', () => {
    expect(countOf(0, 'session')).toBe('0 sessions');
    expect(countOf(1, 'session')).toBe('1 session');
    expect(countOf(2, 'dead job')).toBe('2 dead jobs');
    expect(countOf(1, 'failed message')).toBe('1 failed message');
  });
});
