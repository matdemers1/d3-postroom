import { describe, expect, it } from 'vitest';
import { trackersBlockedNote } from '../../src/mail/trackers';

describe('trackersBlockedNote (PST-REQ-116)', () => {
  it('says "3 trackers blocked" for the fixture count', () => {
    expect(trackersBlockedNote({ trackersBlocked: 3, linksCleaned: 0 })).toBe('3 trackers blocked');
  });
  it('names both counts, singular and plural', () => {
    expect(trackersBlockedNote({ trackersBlocked: 1, linksCleaned: 2 })).toBe('1 tracker blocked · 2 links cleaned');
  });
  it('shows nothing when nothing was removed', () => {
    expect(trackersBlockedNote({ trackersBlocked: 0, linksCleaned: 0 })).toBeNull();
  });
});
