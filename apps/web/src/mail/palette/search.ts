// The palette's Messages group (PST-T-15.5, PST-REQ-194): what it asks GET /api/search, and when.
// Pure and DOM-free, so the chip-to-query mapping, the result rows and the debounce that drops
// stale answers are unit-tested without a browser.
//
// The filter chips map onto what the search API already honours, nothing more:
//   In: <mailbox>   → the endpoint's own `mailboxId` parameter
//   From            → the grammar's `from:` operator, over what was typed (packages/search)
//   Has attachment  → `has:attachment`
//   Date            → `after:7d` — the grammar's relative date, the last seven days
import type { Mailbox, MessageSummary } from '../../api';
import { listDate } from '../format';

/** The chips, each on or off. */
export interface PaletteFilters {
  /** Only the mailbox the mail view is showing. */
  inMailbox: boolean;
  /** What was typed is the sender, not a word anywhere in the message. */
  from: boolean;
  hasAttachment: boolean;
  /** The last seven days. */
  recent: boolean;
}

export const NO_FILTERS: Readonly<PaletteFilters> = { inMailbox: false, from: false, hasAttachment: false, recent: false };

/** How many message rows the palette shows — a jump list, not the list view. */
export const MESSAGE_LIMIT = 8;
/** Typing pauses this long before the palette asks the API. */
export const SEARCH_DEBOUNCE_MS = 180;
/** The Date chip's reach, in the grammar's relative form. */
export const RECENT_AFTER = '7d';

export interface SearchRequest {
  q: string;
  mailboxId?: string;
}

/** The request the typed text and the chips make, or null when there is nothing to ask. The
 * grammar reads a quoted value to the next double quote with no escape, so a From value drops any. */
export function searchRequest(text: string, filters: PaletteFilters, mailboxId: string | null): SearchRequest | null {
  const typed = text.trim();
  const terms: string[] = [];
  if (typed !== '') {
    if (filters.from) {
      const who = typed.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
      if (who !== '') terms.push(`from:"${who}"`);
    } else {
      terms.push(typed);
    }
  }
  if (filters.hasAttachment) terms.push('has:attachment');
  if (filters.recent) terms.push(`after:${RECENT_AFTER}`);
  if (terms.length === 0) return null;
  return { q: terms.join(' '), ...(filters.inMailbox && mailboxId !== null ? { mailboxId } : {}) };
}

/** A stable key for a request — the same text and chips ask the same thing. */
export function requestKey(request: SearchRequest | null): string | null {
  return request === null ? null : `${request.mailboxId ?? '*'}\u0000${request.q}`;
}

/** The sender as the list names them: the display name, else the address. */
export function senderName(m: Pick<MessageSummary, 'from' | 'fromName'>): string {
  const name = m.fromName?.trim() ?? '';
  if (name !== '') return name;
  return m.from ?? 'Unknown sender';
}

/** A result row's secondary text: "Priya Shah · 10:24". */
export function messageDescription(m: Pick<MessageSummary, 'from' | 'fromName' | 'date'>, now: Date = new Date()): string {
  return `${senderName(m)} · ${listDate(m.date, now)}`;
}

/** A result row's name: the subject, or a stand-in the list would also show. */
export function messageLabel(m: Pick<MessageSummary, 'subject'>): string {
  const subject = m.subject?.trim() ?? '';
  return subject === '' ? '(no subject)' : subject;
}

/** The mailbox the In chip names: the one in the URL, the inbox at '/'. */
export function currentMailbox(mailboxes: readonly Mailbox[] | null, routeMailboxId: string | null): Mailbox | null {
  if (mailboxes === null) return null;
  if (routeMailboxId !== null) return mailboxes.find((m) => m.id === routeMailboxId) ?? null;
  return mailboxes.find((m) => m.specialUse === 'inbox' || m.name.toUpperCase() === 'INBOX') ?? null;
}

/**
 * Whether the Messages group comes first. It does — it is what the palette is mostly for — unless
 * a command's own name contains what was typed: then that command is the top row, and a search
 * answer arriving a moment later never moves the selection off it ("rec" → Move to Receipts, then
 * Enter, files the message rather than opening whatever matched "rec").
 */
export function messagesLead(topCommandLabel: string | null, text: string): boolean {
  const typed = text.trim().toLowerCase();
  if (topCommandLabel === null || typed === '') return true;
  return !topCommandLabel.toLowerCase().includes(typed);
}

export type SearchOutcome = { ok: true; messages: MessageSummary[] } | { ok: false };

export interface SearchScheduler {
  /** Asks for `request` after the debounce; null (or a new request) drops whatever was pending. */
  schedule: (request: SearchRequest | null) => void;
  cancel: () => void;
}

/**
 * Debounces the search and ignores every answer but the latest request's. The API client has no
 * abort, so a superseded request is allowed to finish and its answer is simply dropped.
 */
export function createSearchScheduler(
  run: (request: SearchRequest) => Promise<{ messages: MessageSummary[] }>,
  onSettled: (key: string, outcome: SearchOutcome) => void,
  delayMs: number = SEARCH_DEBOUNCE_MS,
): SearchScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    cancel,
    schedule: (request) => {
      cancel();
      if (request === null) return;
      const mine = generation;
      const key = requestKey(request) ?? '';
      timer = setTimeout(() => {
        timer = null;
        run(request).then(
          (page) => {
            if (mine === generation) onSettled(key, { ok: true, messages: page.messages.slice(0, MESSAGE_LIMIT) });
          },
          () => {
            if (mine === generation) onSettled(key, { ok: false });
          },
        );
      }, delayMs);
    },
  };
}
