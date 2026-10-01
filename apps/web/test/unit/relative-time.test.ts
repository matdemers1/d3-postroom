import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/components/RelativeTime';

const now = new Date('2026-10-01T15:00:00Z').getTime();
const at = (ms: number) => new Date(now + ms).toISOString();

describe('relativeTime', () => {
  it('says just now and in a moment inside 45 seconds', () => {
    expect(relativeTime(at(-10_000), now)).toBe('just now');
    expect(relativeTime(at(10_000), now)).toBe('in a moment');
  });
  it('counts minutes, hours and days both ways', () => {
    expect(relativeTime(at(-3 * 60_000), now)).toBe('3 min ago');
    expect(relativeTime(at(4 * 60_000), now)).toBe('in 4 min');
    expect(relativeTime(at(-2 * 3_600_000), now)).toBe('2 h ago');
    expect(relativeTime(at(-86_400_000), now)).toBe('1 day ago');
    expect(relativeTime(at(3 * 86_400_000), now)).toBe('in 3 days');
  });
  it('falls back to a short date after a week', () => {
    expect(relativeTime(at(-20 * 86_400_000), now)).toMatch(/Sep/);
    expect(relativeTime('2024-01-02T00:00:00Z', now)).toMatch(/2024/);
  });
  it('shows a dash for an unreadable value', () => {
    expect(relativeTime('nope', now)).toBe('—');
  });
});
