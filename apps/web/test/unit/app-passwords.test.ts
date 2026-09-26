// PST-T-10.3 / PST-REQ-153: the "last used" column reads as a relative time close to now, and falls
// back to an absolute date once a password has gone unused long enough that "9 days ago" would be
// more confusing than helpful.
import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/screens/app-passwords-format.js';

describe('relativeTime', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');

  it('reads "Never" for a password that has not been used', () => {
    expect(relativeTime(null, now)).toBe('Never');
  });

  it('collapses anything under a minute, including clock skew, to "Just now"', () => {
    expect(relativeTime(new Date('2026-09-26T11:59:59.500Z').toISOString(), now)).toBe('Just now');
    expect(relativeTime(new Date('2026-09-26T12:00:00.500Z').toISOString(), now)).toBe('Just now');
  });

  it('counts minutes, singular and plural', () => {
    expect(relativeTime(new Date('2026-09-26T11:59:00.000Z').toISOString(), now)).toBe('1 minute ago');
    expect(relativeTime(new Date('2026-09-26T11:45:00.000Z').toISOString(), now)).toBe('15 minutes ago');
  });

  it('counts hours once past sixty minutes', () => {
    expect(relativeTime(new Date('2026-09-26T11:00:00.000Z').toISOString(), now)).toBe('1 hour ago');
    expect(relativeTime(new Date('2026-09-26T06:00:00.000Z').toISOString(), now)).toBe('6 hours ago');
  });

  it('counts days once past twenty-four hours', () => {
    expect(relativeTime(new Date('2026-09-25T12:00:00.000Z').toISOString(), now)).toBe('1 day ago');
    expect(relativeTime(new Date('2026-09-21T12:00:00.000Z').toISOString(), now)).toBe('5 days ago');
  });

  it('falls back to an absolute date past thirty days', () => {
    const iso = new Date('2026-06-01T12:00:00.000Z').toISOString();
    const result = relativeTime(iso, now);
    expect(result).not.toMatch(/ago$/);
    expect(result).toBe(new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  });
});
