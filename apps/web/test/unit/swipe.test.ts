// PST-T-16.15 (PST-DA-066): the phone swipe's decisions, pure. Which gesture is the row's, what a
// drag of (dx, dy) on a row of a given width means, and where the 40% line is. The browser behaviour
// (a real swipe, the Undo toast, reduced motion) is e2e/tests/mobile.spec.ts.
import { describe, expect, it } from 'vitest';
import { CLAIM_DISTANCE, COMMIT_FRACTION, claimsGesture, decideSwipe, readLabel, swipeOffset } from '../../src/mobile/swipe';

const W = 390;
const both = { canArchive: true };

describe('claimsGesture', () => {
  it('waits until the finger has moved more than 10 px', () => {
    expect(claimsGesture(0, 0)).toBe('undecided');
    expect(claimsGesture(CLAIM_DISTANCE, 3)).toBe('undecided');
    expect(claimsGesture(-CLAIM_DISTANCE, -CLAIM_DISTANCE)).toBe('undecided');
  });

  it('claims a drag that is past 10 px and more horizontal than vertical, either way', () => {
    expect(claimsGesture(-11, 2)).toBe('claim');
    expect(claimsGesture(40, 30)).toBe('claim');
  });

  it('lets a vertical-ish drag go to the list (scroll)', () => {
    expect(claimsGesture(2, 40)).toBe('scroll');
    expect(claimsGesture(30, 30)).toBe('scroll');
    expect(claimsGesture(-12, 20)).toBe('scroll');
  });
});

describe('decideSwipe', () => {
  it('is none for a tap, a tiny drag and a vertical scroll', () => {
    expect(decideSwipe(0, 0, W, both)).toBe('none');
    expect(decideSwipe(-8, 2, W, both)).toBe('none');
    expect(decideSwipe(-120, 150, W, both)).toBe('none');
  });

  it('reveals Archive dragging left and Read/Unread dragging right, below 40%', () => {
    expect(decideSwipe(-60, 4, W, both)).toBe('reveal-archive');
    expect(decideSwipe(60, 4, W, both)).toBe('reveal-read');
  });

  it('commits only past 40% of the row width', () => {
    const line = W * COMMIT_FRACTION;
    expect(decideSwipe(-line, 0, W, both)).toBe('reveal-archive');
    expect(decideSwipe(-(line + 1), 0, W, both)).toBe('commit-archive');
    expect(decideSwipe(line, 0, W, both)).toBe('reveal-read');
    expect(decideSwipe(line + 1, 0, W, both)).toBe('commit-read');
    expect(decideSwipe(-W, 0, W, both)).toBe('commit-archive');
  });

  it('has no trailing action where the mailbox cannot be archived from', () => {
    expect(decideSwipe(-200, 0, W, { canArchive: false })).toBe('none');
    expect(decideSwipe(200, 0, W, { canArchive: false })).toBe('commit-read');
  });

  it('is none for a row with no width', () => {
    expect(decideSwipe(-100, 0, 0, both)).toBe('none');
  });
});

describe('swipeOffset', () => {
  it('follows the finger, never past the row, and not toward a side with no action', () => {
    expect(swipeOffset(-120, W, both)).toBe(-120);
    expect(swipeOffset(-900, W, both)).toBe(-W);
    expect(swipeOffset(900, W, both)).toBe(W);
    expect(swipeOffset(-120, W, { canArchive: false })).toBe(0);
    expect(swipeOffset(120, W, { canArchive: false })).toBe(120);
    expect(swipeOffset(50, 0, both)).toBe(0);
  });
});

describe('readLabel', () => {
  it('names the toggle by what it will do', () => {
    expect(readLabel(true)).toBe('Mark read');
    expect(readLabel(false)).toBe('Mark unread');
  });
});
