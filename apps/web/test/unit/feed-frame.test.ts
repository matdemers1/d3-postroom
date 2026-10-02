// PST-T-17.3 (design finding PST-DA-084): the Newsletters feed sizes each body frame from the render
// ticket's server-side estimate — the sandboxed, scriptless, cross-origin frame cannot report its
// own height. A short message gets a short frame; a long one is capped, with "Read in full".
// The browser behaviour is e2e/tests/feed-and-profile.spec.ts.
import { describe, expect, it, vi } from 'vitest';

// The component library ships CSS, which Node cannot import; nothing here renders.
vi.mock('@d3cloud/ui', () => ({}));
vi.mock('../../src/mail/feed.css', () => ({}));
import { FEED_FRAME_MAX, FEED_FRAME_MIN, feedFrameSize } from '../../src/mail/Feed';

describe('feedFrameSize', () => {
  it('gives a one-line message a short frame: its estimate plus the hairline and a little room', () => {
    expect(feedFrameSize({ narrow: 58, wide: 58 }, 734)).toEqual({ height: 68, capped: false });
    expect(feedFrameSize({ narrow: 58, wide: 58 }, 734).height).toBeLessThan(200);
  });

  it('never goes below the minimum', () => {
    expect(feedFrameSize({ narrow: 0, wide: 0 }, 734)).toEqual({ height: FEED_FRAME_MIN, capped: false });
  });

  it('caps a long message at FEED_FRAME_MAX and says so', () => {
    expect(FEED_FRAME_MAX).toBe(480);
    expect(feedFrameSize({ narrow: 9000, wide: 4000 }, 734)).toEqual({ height: FEED_FRAME_MAX, capped: true });
    // The boundary: the estimate plus its allowance just fits, one more pixel does not.
    expect(feedFrameSize({ narrow: 470, wide: 470 }, 734)).toEqual({ height: 480, capped: false });
    expect(feedFrameSize({ narrow: 471, wide: 471 }, 734)).toEqual({ height: FEED_FRAME_MAX, capped: true });
  });

  it('uses the wide estimate at or above 720px, and before the frame has been measured', () => {
    const estimate = { narrow: 300, wide: 100 };
    expect(feedFrameSize(estimate, 720).height).toBe(110);
    expect(feedFrameSize(estimate, 1200).height).toBe(110);
    expect(feedFrameSize(estimate, 0).height).toBe(110);
    expect(feedFrameSize(estimate, -2).height).toBe(110);
  });

  it('interpolates between the narrow (360px) and wide (720px) estimates', () => {
    const estimate = { narrow: 300, wide: 100 };
    expect(feedFrameSize(estimate, 360).height).toBe(310);
    expect(feedFrameSize(estimate, 540).height).toBe(210);
  });

  it('grows the narrow estimate in proportion below 360px, where text wraps more', () => {
    expect(feedFrameSize({ narrow: 100, wide: 60 }, 180).height).toBe(210);
  });

  it('treats a ticket with no estimate (an older server) as long: capped, with "Read in full"', () => {
    expect(feedFrameSize(undefined, 734)).toEqual({ height: FEED_FRAME_MAX, capped: true });
  });
});
