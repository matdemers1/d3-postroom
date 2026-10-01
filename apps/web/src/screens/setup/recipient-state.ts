// PST-T-17.14 (admin critique X3): the test message's recipient state as a dot and a word, like every
// other admin status. Neutral while it moves and once it is delivered; colour only when it needs you.
import type { RecipientState } from '../../api';

export function recipientTone(state: RecipientState): 'neutral' | 'attention' | 'danger' {
  switch (state) {
    case 'queued':
    case 'attempting':
    case 'delivered':
      return 'neutral';
    case 'deferred':
      return 'attention';
    case 'bounced':
    case 'cancelled':
      return 'danger';
  }
}

/** "Delivered", "Deferred": the state as a word. */
export function recipientWord(state: RecipientState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}
