// PST-T-16.15 (PST-DA-066, PST-REQ-190, PST-REQ-155): the phone list's swipe gesture, as pure
// decisions — no DOM — so the thresholds are unit-tested without a browser (test/unit/swipe.test.ts).
// Dragging a row left runs Archive (the trailing action); dragging it right toggles read/unread (the
// leading one). Swipe is an accelerator for a touch screen: the row's own actions stay the way in for
// the keyboard and for screen readers, and nothing here adds a focus stop.

/** Touch screens; a mouse or trackpad keeps the hover cluster. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** A drag past this share of the row's width commits the action on release. */
export const COMMIT_FRACTION = 0.4;

/** The gesture is claimed only once it has moved this far (px) and is more horizontal than vertical. */
export const CLAIM_DISTANCE = 10;

export type SwipeClaim = 'undecided' | 'claim' | 'scroll';

/**
 * Whose gesture is this? Under 10 px either way it is undecided; past that, a drag that is more
 * horizontal than vertical is the row's swipe, anything else is the list scrolling (the row lets go).
 */
export function claimsGesture(dx: number, dy: number): SwipeClaim {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax <= CLAIM_DISTANCE && ay <= CLAIM_DISTANCE) return 'undecided';
  if (ax > ay && ax > CLAIM_DISTANCE) return 'claim';
  if (ay > CLAIM_DISTANCE) return 'scroll';
  return 'undecided';
}

export type SwipeOutcome = 'none' | 'reveal-archive' | 'reveal-read' | 'commit-archive' | 'commit-read';

export interface SwipeOptions {
  /** False where the mailbox cannot be archived from (the Archive itself): the trailing side is dead. */
  canArchive: boolean;
}

/**
 * What a drag of (dx, dy) on a row `width` px wide means right now. `reveal-*` shows the action
 * surface under the row; `commit-*` is a drag past 40% of the width, which on release runs the
 * action and while dragging marks it as armed. `none` is a vertical or tiny drag, or a side with no
 * action.
 */
export function decideSwipe(dx: number, dy: number, width: number, options: SwipeOptions): SwipeOutcome {
  if (claimsGesture(dx, dy) !== 'claim' || width <= 0) return 'none';
  const past = Math.abs(dx) / width > COMMIT_FRACTION;
  if (dx < 0) {
    if (!options.canArchive) return 'none';
    return past ? 'commit-archive' : 'reveal-archive';
  }
  return past ? 'commit-read' : 'reveal-read';
}

/** How far the row is drawn from rest: follows the finger, never past the row's own width, and not at
 * all toward a side with no action. */
export function swipeOffset(dx: number, width: number, options: SwipeOptions): number {
  if (width <= 0) return 0;
  if (dx < 0 && !options.canArchive) return 0;
  return Math.max(-width, Math.min(width, dx));
}

/** The visible label of the leading surface for a row in its current state. */
export const readLabel = (unread: boolean): string => (unread ? 'Mark read' : 'Mark unread');
