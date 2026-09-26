// Pure logic behind ReadingPane's thread view (PST-T-3.15, PST-REQ-079): given a thread's messages
// in the order GET /api/threads/:id returns them (oldest first), which rows start expanded, and
// what a collapsed row says. Kept apart from ReadingPane.tsx (which imports @d3cloud/ui, and so its
// CSS) so this can be unit tested directly under Node, the same way phish.ts is.
import type { MessageSummary } from '../api';

export interface ThreadRow {
  message: MessageSummary;
  /** Newest, the message the reader opened, and anything toggled open by hand. */
  expanded: boolean;
}

/** The thread is only worth its own conversation view once it has more than one message; a lone
 *  message reads exactly as it always has. */
export function isConversation(messages: readonly MessageSummary[]): boolean {
  return messages.length > 1;
}

/**
 * Older messages collapsed, the newest expanded, and whichever message the reader opened (which
 * may not be the newest, e.g. after following a search result) — plus anything toggled by hand.
 * `messages` is taken as already ordered oldest-first; this only decides which rows are open.
 */
export function threadRows(messages: readonly MessageSummary[], openId: string | null, toggled: ReadonlySet<string>): ThreadRow[] {
  const newestId = messages.length === 0 ? null : (messages[messages.length - 1]?.id ?? null);
  return messages.map((message) => ({
    message,
    expanded: message.id === newestId || message.id === openId || toggled.has(message.id),
  }));
}

/** Flips one row's manual override. Never mutates its input. */
export function toggleRow(toggled: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(toggled);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A collapsed row's summary: the sender, and the subject only when it differs from the thread's
 *  own (a plain "Re: X" reply adds nothing collapsed that the thread heading hasn't already said). */
export function collapsedSummary(message: Pick<MessageSummary, 'from' | 'subject'>, threadSubject: string | null): string {
  const from = message.from ?? '(unknown sender)';
  if (message.subject === null || message.subject === threadSubject) return from;
  return `${from} — ${message.subject}`;
}

/** True when a freshly arrived message (from an SSE `message.new` event) could belong to the open
 *  thread and so is worth a re-fetch — cheap and conservative: anything is worth checking, since the
 *  event carries no threadId of its own and a spurious re-fetch costs one GET. */
export function mightJoinThread(threadId: string | null): boolean {
  return threadId !== null;
}
