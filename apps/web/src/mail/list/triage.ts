// PST-T-14.5 (PST-REQ-190, PST-ADR-011): the pure half of the triage loop — what a row says about
// its sender, which messages an archive/delete/move acts on, which message opens next, how an undo
// is planned, and the x-selection. Kept free of React and @d3cloud/ui so it is unit tested directly
// under Node, the way thread.ts and split.ts are.
//
// The list stays PER-MESSAGE (IMAP folders, iPhone Mail parity); a thread is never collapsed into
// one row. What changes is the reach of a move made on an OPEN message: it takes every member of
// that message's thread in the same mailbox with it, so a three-message conversation is archived
// with one e, not three.
import { serverUnreachable, type MessageSummary } from '../../api';
import { sortsAboveTop } from '../list';

/** Fields the API sends on a summary that the web type does not name yet. */
export type RowSummary = MessageSummary & {
  /** PST-T-6.5's sorter score: the first message from this address. */
  newSender?: boolean;
  /** Not sent by the API yet; the row shows the paperclip when it is. */
  hasAttachments?: boolean;
  expiresAt?: string | null;
};

// --- What a row says about its sender -------------------------------------------------------------

/** Two letters for the avatar: from the display name's first two words, else the address's local part. */
export function initials(fromName: string | null | undefined, from: string | null): string {
  const source = fromName !== null && fromName !== undefined && fromName.trim() !== '' ? fromName : (from ?? '').split('@')[0] ?? '';
  const words = source
    .split(/[\s._+-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w !== '');
  if (words.length === 0) return '?';
  const first = graphemes(words[0] ?? '');
  const last = words.length > 1 ? graphemes(words[words.length - 1] ?? '') : [];
  const pair = last.length === 0 ? first.slice(0, 2).join('') : `${first[0] ?? ''}${last[0] ?? ''}`;
  return pair.toLocaleUpperCase();
}

/**
 * PST-T-15.2: the name the row's Avatar is given — it draws the initials from it and hashes it for
 * the tint (`tint="auto"`), so one sender is one colour everywhere. The display name when there is
 * one, else the address's local part split into words ("ada.lovelace" → "ada lovelace", so the
 * initials are "AL"), else "?".
 */
export function avatarName(fromName: string | null | undefined, from: string | null): string {
  if (fromName !== null && fromName !== undefined && fromName.trim() !== '') return fromName.trim();
  const local = ((from ?? '').split('@')[0] ?? '').split(/[._+-]+/).filter((w) => w !== '').join(' ');
  return local === '' ? '?' : local;
}

/** User-perceived characters, so an accented or combined letter is never cut in half. */
function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

export interface SenderLine {
  /** What the row leads with: the display name, or the address when there is none. */
  name: string;
  /** The address beside the name — only when it tells the reader something (see senderLine). */
  address: string | null;
  firstTime: boolean;
  warned: boolean;
}

/**
 * The name, with the address beside it ONLY for a first-time sender or a message with a phishing
 * warning — the two cases where "who is this, really?" is the question. Everyone else is known by
 * name. A sender without a display name is shown by address, once.
 */
export function senderLine(m: Pick<RowSummary, 'from' | 'fromName' | 'newSender'>, warned = false): SenderLine {
  const address = m.from ?? null;
  const name = m.fromName !== null && m.fromName !== undefined && m.fromName.trim() !== '' ? m.fromName.trim() : null;
  const firstTime = m.newSender === true;
  if (name === null) return { name: address ?? '(unknown sender)', address: null, firstTime, warned };
  const showAddress = (firstTime || warned) && address !== null && address.toLowerCase() !== name.toLowerCase();
  return { name, address: showAddress ? address : null, firstTime, warned };
}

/** The one-line preview: null (not summarised yet) and '' (no text) both render as nothing. */
export function snippetLine(snippet: string | null | undefined): string {
  if (snippet === null || snippet === undefined) return '';
  return snippet.replace(/\s+/g, ' ').trim();
}

// --- Which messages a move acts on ------------------------------------------------------------------

/**
 * The members of `open`'s thread that sit in the same mailbox as it, from what the list has loaded —
 * the open message first. A message with no thread is its own and only member.
 */
export function threadMembersInMailbox(listed: readonly MessageSummary[], open: MessageSummary): MessageSummary[] {
  if (open.threadId === null) return [open];
  const others = listed.filter((m) => m.id !== open.id && m.threadId === open.threadId && m.mailboxId === open.mailboxId);
  return [open, ...others];
}

/** Adds `extra` members (from GET /api/threads/:id) the list had not loaded, same mailbox only, no repeats. */
export function mergeMembers(known: readonly MessageSummary[], extra: readonly MessageSummary[], mailboxId: string): MessageSummary[] {
  const seen = new Set(known.map((m) => m.id));
  const out = [...known];
  for (const m of extra) {
    if (m.mailboxId !== mailboxId || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// --- Which message opens next -------------------------------------------------------------------------

/**
 * After `removed` leave the list, the message to open in `anchorId`'s place: the nearest one BELOW
 * it (older — the list is newest first, so this is the direction you are reading in), or the
 * nearest one above when nothing below survives. Null when nothing is left. An anchor that is not
 * listed (opened from a search, or already gone) falls back to the first survivor.
 */
export function nextAfterRemoval(messages: readonly Pick<MessageSummary, 'id'>[], removed: ReadonlySet<string>, anchorId: string | null): string | null {
  const index = anchorId === null ? -1 : messages.findIndex((m) => m.id === anchorId);
  if (index < 0) return messages.find((m) => !removed.has(m.id))?.id ?? null;
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && !removed.has(m.id)) return m.id;
  }
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && !removed.has(m.id)) return m.id;
  }
  return null;
}

// --- Undo ----------------------------------------------------------------------------------------------

/** One message a triage moved: its NEW id and MODSEQ in the destination, and where it came from. */
export interface MovedRecord {
  originalId: string;
  movedId: string;
  movedModseq: string;
  fromMailboxId: string;
}

export interface UndoPatch {
  id: string;
  modseq: string;
  mailboxId: string;
}

/**
 * The inverse of a triage, as the PATCHes that make it: each moved copy — by the id the server gave
 * it in the destination, never the old one (a move is a new UID there) — goes back to the mailbox it
 * came from. Messages whose move never landed have nothing to undo.
 */
export function undoPatches(moved: readonly MovedRecord[]): UndoPatch[] {
  return moved.map((r) => ({ id: r.movedId, modseq: r.movedModseq, mailboxId: r.fromMailboxId }));
}

/** "Moved to Archive · Subject" for one message; "Moved 3 messages to Archive" (or "Snoozed until … · 3 messages") for several. */
export function triageMessage(verb: string, count: number, subject: string | null): string {
  if (count === 1) {
    const s = subject === null || subject.trim() === '' ? '(no subject)' : subject.trim();
    return `${verb} · ${s}`;
  }
  return /^Moved /.test(verb) ? verb.replace(/^Moved/, `Moved ${String(count)} messages`) : `${verb} · ${String(count)} messages`;
}

// --- Snooze: say so only once the server has (PST-T-16.1, PST-DA-071) ------------------------------------

/** One conversation's snooze request: `status` is the API's refusal, or null when it never answered; `ok` when it went through. */
export type SnoozeAttempt = { threadId: string; ok: true } | { threadId: string; ok: false; status: number | null };

export interface SnoozeSettled {
  /** Conversations the server snoozed: these leave the list, and only these are named in the toast. */
  done: string[];
  /** Conversations it did not: they stay where they are, open if they were. */
  failed: string[];
  /** What to tell the operator when any failed; null when every one went through. */
  error: string | null;
}

/**
 * Decides what a finished snooze means. Nothing is reported or removed before this: the row, the open
 * message and the "Snoozed until" toast all follow `done`, and `error` is shown for the rest — the
 * same honesty as the toolbar's attemptSnooze (PST-T-14.1).
 */
export function settleSnooze(attempts: readonly SnoozeAttempt[]): SnoozeSettled {
  const done: string[] = [];
  const failed: string[] = [];
  let unreachable = false;
  let gone = false;
  for (const a of attempts) {
    if (a.ok) done.push(a.threadId);
    else {
      failed.push(a.threadId);
      if (a.status === null) unreachable = true;
      else if (a.status === 404) gone = true;
    }
  }
  if (failed.length === 0) return { done, failed, error: null };
  const many = failed.length > 1;
  const stays = many ? 'they’re still here' : 'it’s still here';
  const error = unreachable
    ? serverUnreachable(many ? 'Those conversations weren’t snoozed.' : 'It wasn’t snoozed.')
    : gone && !many
      ? 'That conversation is gone, so it wasn’t snoozed.'
      : `Couldn’t snooze ${many ? `${String(failed.length)} conversations` : 'that'} — ${stays}.`;
  return { done, failed, error };
}

// --- Selection (x) -------------------------------------------------------------------------------------

export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Keeps only ids still listed — a selected row that another client moved away is no longer selected. */
export function pruneSelected(selected: ReadonlySet<string>, listed: readonly Pick<MessageSummary, 'id'>[]): Set<string> {
  if (selected.size === 0) return selected as Set<string>;
  const ids = new Set(listed.map((m) => m.id));
  const next = new Set([...selected].filter((id) => ids.has(id)));
  return next.size === selected.size ? (selected as Set<string>) : next;
}

/** The selected messages, in list order. */
export function selectedMessages<T extends Pick<MessageSummary, 'id'>>(listed: readonly T[], selected: ReadonlySet<string>): T[] {
  return listed.filter((m) => selected.has(m.id));
}

// --- Live arrivals (the "N new" pill) ---------------------------------------------------------------------

/**
 * Splits a fresh first page into what may go straight into the list and what must wait behind the
 * pill: anything new that would sort above the newest row on screen (by date, PST-T-14.10), when the
 * reader is not at rest at the top (scrolled down, or the pointer is over the list) — inserting it
 * would shift the rows under them. A new row that sorts lower (a message moved back in keeps its
 * date) goes in at its place.
 */
export function holdBackArrivals<T extends Pick<MessageSummary, 'id' | 'uid' | 'internalDate'>>(
  page: readonly T[],
  listed: readonly Pick<MessageSummary, 'id' | 'uid' | 'internalDate'>[],
  calm: boolean,
): { keep: T[]; held: T[] } {
  if (calm || listed.length === 0) return { keep: [...page], held: [] };
  const ids = new Set(listed.map((m) => m.id));
  const keep: T[] = [];
  const held: T[] = [];
  for (const m of page) (!ids.has(m.id) && sortsAboveTop(m, listed) ? held : keep).push(m);
  return { keep, held };
}
