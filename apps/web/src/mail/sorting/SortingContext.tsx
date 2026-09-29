// PST-T-14.9: what the reading pane's chips and Person card need from the mail view, without
// threading props through ReadingPane — where the list is (so a header chip follows the same "only
// where the bucket isn't implied" rule as the rows), which message is open, and the one correction
// path (MailView's correct(): the move, the next message, the Toast with Undo).
import { createContext, useContext } from 'react';
import type { MessageSummary } from '../../api';
import type { ChipContext, FilingBucket } from './sorting';

export interface SortingActions {
  /** Where the list is: search, the Inbox (and its segment), or another mailbox. */
  list: ChipContext;
  openId: string | null;
  openBucket: string | null;
  /** A correction: a move plus a recorded sender preference, with an Undo Toast. */
  correct: (message: MessageSummary, bucket: FilingBucket, scope: 'sender' | 'domain', source: 'chip' | 'card') => void;
}

export const SortingContext = createContext<SortingActions | null>(null);

export function useSorting(): SortingActions | null {
  return useContext(SortingContext);
}
