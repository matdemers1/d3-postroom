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

/**
 * A collapsed row's one-line preview of its body (PST-T-11.4): the words the sender wrote, not the
 * quote of the message before it or the "On …, X wrote:" line that introduces it. Null when there is
 * no text part, or nothing but quoted text.
 */
export function snippetOf(text: string | null | undefined, max = 140): string | null {
  if (text === null || text === undefined) return null;
  const words: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('>')) continue;
    if (/^On .+ wrote:$/.test(line)) break;
    if (line === '--' || line === '-- ') break;
    words.push(line);
    if (words.join(' ').length >= max) break;
  }
  const joined = words.join(' ').replace(/\s+/g, ' ').trim();
  if (joined === '') return null;
  return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}

/**
 * The line under a conversation's subject (PST-T-15.3, the redesign canvas): "3 messages · Priya
 * Shah, Jonah Reyes, you" — how many, then who wrote, in the order they first did, with the signed-in
 * account as "you" and last. Names come from the list's own fields (fromName, else the address);
 * `me` is compared by address, case-insensitively. A lone message has no line: its header says who.
 */
export function participantsLine(messages: readonly Pick<MessageSummary, 'from' | 'fromName'>[], me: string | null, max = 3): string | null {
  if (messages.length < 2) return null;
  const mine = me === null ? '' : me.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  let includesMe = false;
  for (const m of messages) {
    const address = (m.from ?? '').trim().toLowerCase();
    const given = (m.fromName ?? '').trim();
    const name = given === '' ? (m.from ?? '').trim() : given;
    const key = address === '' ? name : address;
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (mine !== '' && address === mine) includesMe = true;
    else names.push(name);
  }
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const who = [...shown, ...(rest > 0 ? [`${String(rest)} more`] : []), ...(includesMe ? ['you'] : [])];
  const count = `${String(messages.length)} messages`;
  return who.length === 0 ? count : `${count} · ${who.join(', ')}`;
}
