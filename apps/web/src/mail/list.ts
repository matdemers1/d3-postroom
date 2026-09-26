// The message list's state, as a reducer: pages loaded, a new message arriving over SSE, an
// optimistic flag change or move, and the cursor that j/k move. Pure, so every transition is
// unit-tested — including the ones that must NOT happen (a duplicate from SSE, a cursor that runs
// off the end after an archive).
import type { MessageSummary } from '../api';

export interface ListState {
  mailboxId: string | null;
  messages: MessageSummary[];
  nextCursor: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Index of the keyboard cursor (the focused row), or -1 when the list is empty. */
  cursor: number;
}

export type ListAction =
  | { type: 'reset'; mailboxId: string | null }
  | { type: 'loaded'; mailboxId: string; messages: MessageSummary[]; nextCursor: string | null; append: boolean }
  | { type: 'failed'; mailboxId: string }
  | { type: 'upsert'; message: MessageSummary }
  | { type: 'remove'; id: string }
  /** The server's copy of a row after a write: replaces it if it is listed, never inserts. */
  | { type: 'patch'; message: MessageSummary }
  | { type: 'flags'; id: string; add: readonly string[]; remove: readonly string[] }
  | { type: 'cursor'; index: number }
  | { type: 'cursorTo'; id: string }
  | { type: 'move'; delta: 1 | -1 };

export const initialList: ListState = { mailboxId: null, messages: [], nextCursor: null, status: 'idle', cursor: -1 };

/** Newest first: the API's order (by UID, descending). */
function byUidDesc(a: MessageSummary, b: MessageSummary): number {
  return b.uid - a.uid;
}

function clampCursor(cursor: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(cursor, 0), length - 1);
}

export function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case 'reset':
      return { ...initialList, mailboxId: action.mailboxId, status: action.mailboxId === null ? 'idle' : 'loading' };
    case 'loaded': {
      if (action.mailboxId !== state.mailboxId) return state;
      const cursorId = state.messages[state.cursor]?.id;
      const merged = action.append ? dedupe([...state.messages, ...action.messages]) : dedupe(action.messages);
      merged.sort(byUidDesc);
      const kept = cursorId === undefined ? -1 : merged.findIndex((m) => m.id === cursorId);
      return {
        ...state,
        messages: merged,
        nextCursor: action.nextCursor,
        status: 'ready',
        cursor: kept >= 0 ? kept : clampCursor(state.cursor < 0 ? 0 : state.cursor, merged.length),
      };
    }
    case 'failed':
      return action.mailboxId === state.mailboxId ? { ...state, status: 'error' } : state;
    case 'upsert': {
      if (action.message.mailboxId !== state.mailboxId) return state;
      const cursorId = state.messages[state.cursor]?.id;
      const others = state.messages.filter((m) => m.id !== action.message.id);
      const messages = [...others, action.message].sort(byUidDesc);
      const kept = cursorId === undefined ? 0 : messages.findIndex((m) => m.id === cursorId);
      return { ...state, messages, cursor: clampCursor(kept, messages.length) };
    }
    case 'remove': {
      const index = state.messages.findIndex((m) => m.id === action.id);
      if (index < 0) return state;
      const messages = state.messages.filter((m) => m.id !== action.id);
      // The row under the cursor went: the cursor stays in place, which is now the next (older) one.
      const cursor = index < state.cursor ? state.cursor - 1 : state.cursor;
      return { ...state, messages, cursor: clampCursor(cursor, messages.length) };
    }
    case 'patch':
      return state.messages.some((m) => m.id === action.message.id)
        ? { ...state, messages: state.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
        : state;
    case 'flags':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, flags: applyFlags(m.flags, action.add, action.remove) } : m)),
      };
    case 'cursor':
      return { ...state, cursor: clampCursor(action.index, state.messages.length) };
    case 'cursorTo': {
      const index = state.messages.findIndex((m) => m.id === action.id);
      return index < 0 ? state : { ...state, cursor: index };
    }
    case 'move':
      return { ...state, cursor: clampCursor(state.cursor + action.delta, state.messages.length) };
  }
}

function dedupe(messages: readonly MessageSummary[]): MessageSummary[] {
  const seen = new Map<string, MessageSummary>();
  for (const m of messages) seen.set(m.id, m);
  return [...seen.values()];
}

export function applyFlags(flags: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const out = flags.filter((f) => !remove.includes(f));
  for (const f of add) if (!out.includes(f)) out.push(f);
  return out;
}

export const SEEN = '\\Seen';
export const FLAGGED = '\\Flagged';
export const isUnread = (m: { flags: readonly string[] }): boolean => !m.flags.includes(SEEN);
export const isStarred = (m: { flags: readonly string[] }): boolean => m.flags.includes(FLAGGED);

/** The rows to render for a virtualised list: [start, end) with an overscan either side. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 8): { start: number; end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(viewport, rowHeight)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/** The scrollTop that brings row `index` fully into view, or null when it already is. */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number | null {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}
