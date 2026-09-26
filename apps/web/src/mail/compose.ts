// What a new reply, reply-all, forward or blank message starts with, and what the composer sends
// and saves (PST-T-3.11) — the rules live here, pure and unit-tested, so the composer and the
// keyboard shortcuts agree on them.
import { ApiError, type ComposeFields, type MessageBody, type MessageDetail, type PendingSend, type SavedDraft, type SendResult } from '../api';
import type { ComposeMode } from './route';
import { addressOf, displayName, fullDate, header, splitAddresses } from './format';

export interface ComposeDraft {
  mode: ComposeMode;
  to: string;
  cc: string;
  subject: string;
  /** The Message-ID this answers (RFC 5322 In-Reply-To), angle brackets included; null for new/forward. */
  inReplyTo: string | null;
  /** The References chain to send: the original's References plus its Message-ID. */
  references: string[];
  body: string;
  /** The message being answered or forwarded. */
  sourceId: string | null;
}

export interface ComposeSource {
  detail: MessageDetail;
  body: MessageBody | null;
}

export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`.trimEnd();
}

export function forwardSubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`.trimEnd();
}

function bracket(id: string | null): string | null {
  if (id === null || id.trim() === '') return null;
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

function quote(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** Drops `me` and duplicates from an address list, keeping the entries as written. */
function without(entries: readonly string[], exclude: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set(exclude);
  for (const e of entries) {
    const a = addressOf(e);
    if (a === '' || seen.has(a)) continue;
    seen.add(a);
    out.push(e);
  }
  return out;
}

/**
 * The prefilled draft. `me` is the signed-in account's address, left out of reply-all.
 * A reply goes to Reply-To when the sender set one, else From.
 */
export function draftFor(mode: ComposeMode, source: ComposeSource | null, me: string | null, locale?: string): ComposeDraft {
  const blank: ComposeDraft = { mode, to: '', cc: '', subject: '', inReplyTo: null, references: [], body: '', sourceId: null };
  if (mode === 'new' || source === null) return blank;

  const { detail, body } = source;
  const from = header(body, 'From') ?? detail.from ?? '';
  const replyTo = header(body, 'Reply-To');
  const text = body?.text ?? '';
  const when = fullDate(detail.date, locale);
  const sender = from === '' ? 'the sender' : displayName(from);

  if (mode === 'forward') {
    const lines = ['', '', '---------- Forwarded message ----------', `From: ${from}`, `Date: ${when}`, `Subject: ${detail.subject ?? ''}`];
    const to = header(body, 'To');
    if (to !== null) lines.push(`To: ${to}`);
    lines.push('', text);
    return { ...blank, subject: forwardSubject(detail.subject), body: lines.join('\n'), sourceId: detail.id };
  }

  const messageId = bracket(detail.messageIdHeader);
  const references = [...detail.references.map((r) => bracket(r) ?? r), ...(messageId === null ? [] : [messageId])];
  const mine = new Set(me === null ? [] : [me.toLowerCase()]);
  const primary = splitAddresses(replyTo ?? from);
  let to = without(primary, mine);
  let cc: string[] = [];
  if (mode === 'replyall') {
    const toSeen = new Set([...mine, ...to.map(addressOf)]);
    to = [...to, ...without(splitAddresses(header(body, 'To') ?? ''), toSeen)];
    cc = without(splitAddresses(header(body, 'Cc') ?? ''), new Set([...mine, ...to.map(addressOf)]));
  }
  // Replying to your own sent message: answer the original recipients rather than yourself.
  if (to.length === 0) to = without(splitAddresses(header(body, 'To') ?? ''), mine);
  return {
    mode,
    to: to.join(', '),
    cc: cc.join(', '),
    subject: replySubject(detail.subject),
    inReplyTo: messageId,
    references,
    body: text === '' ? '' : `\n\nOn ${when}, ${sender} wrote:\n${quote(text)}`,
    sourceId: detail.id,
  };
}

/** What the composer's fields hold. */
export interface ComposeState {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  forwardOf: string | null;
}

export function initialState(draft: ComposeDraft): ComposeState {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: '',
    subject: draft.subject,
    text: draft.body,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    forwardOf: draft.mode === 'forward' ? draft.sourceId : null,
  };
}

/** The request body: address fields split into one entry per address. */
export function fieldsOf(state: ComposeState): ComposeFields {
  return {
    to: splitAddresses(state.to),
    cc: splitAddresses(state.cc),
    bcc: splitAddresses(state.bcc),
    subject: state.subject.replace(/[\r\n]+/g, ' '),
    text: state.text,
    inReplyTo: state.inReplyTo,
    references: state.references,
    forwardOf: state.forwardOf,
  };
}

export function hasRecipients(state: ComposeState): boolean {
  return splitAddresses(state.to).length + splitAddresses(state.cc).length + splitAddresses(state.bcc).length > 0;
}

/** A saved draft, back in the composer's fields. */
export function stateFromSaved(saved: SavedDraft): ComposeState {
  return {
    to: saved.to.join(', '),
    cc: saved.cc.join(', '),
    bcc: saved.bcc.join(', '),
    subject: saved.subject,
    text: saved.text,
    inReplyTo: saved.inReplyTo,
    references: saved.references,
    forwardOf: saved.forwardOf,
  };
}

/** The saved draft this composer should pick up again: the same kind of answer to the same message. */
export function resumableDraft(drafts: readonly SavedDraft[], draft: ComposeDraft): SavedDraft | null {
  if (draft.sourceId === null) return null;
  return drafts.find((d) => d.sourceId === draft.sourceId && d.mode === draft.mode) ?? null;
}

/** A refused send, in words the person can act on. */
export function sendErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Postroom did not answer, so nothing was sent. Check your connection and try again.';
  const message = typeof error.body === 'object' && error.body !== null && typeof (error.body as { message?: unknown }).message === 'string' ? (error.body as { message: string }).message : null;
  switch (error.code) {
    case 'no_recipients':
      return 'Add at least one recipient.';
    case 'invalid_recipient':
      return message ?? 'One of the addresses is not one Postroom can send to.';
    case 'too_many_recipients':
      return message ?? 'That is too many recipients for one message.';
    case 'from_not_owned':
      return 'You can only send from your own addresses.';
    case 'dkim_unconfigured':
      return 'Your domain has no DKIM keys yet, and Postroom never sends unsigned mail. Ask the operator to create them.';
    case 'recipient_cap':
      return 'You have reached your sending limit for now. Nothing was sent; try again later.';
    case 'blobstore_not_configured':
      return 'Postroom is not set up to store mail yet, so nothing was sent.';
    case 'send_at_past':
      return 'Pick a time in the future to send it.';
    case 'send_at_too_far':
      return 'A message can be scheduled at most a year ahead.';
    default:
      return `Nothing was sent (${error.code}). Try again.`;
  }
}

// --- Undo send, send later, remind if no reply (PST-T-9.1) --------------------------------------------

/** The undo window when the person has not chosen one (PST-REQ-140). 0 turns undo off. */
export const UNDO_DEFAULT_SECONDS = 10;
export const UNDO_MAX_SECONDS = 30;
/** The choices the composer offers; 0 turns undo off. */
export const UNDO_CHOICES: readonly number[] = [0, 5, 10, 20, 30];
const UNDO_KEY = 'postroom.undoSeconds';

/** The undo window this browser uses: a whole number of seconds, 0–30, default 10. */
export function undoSeconds(storage: Pick<Storage, 'getItem'> | null): number {
  const raw = storage?.getItem(UNDO_KEY) ?? null;
  if (raw === null || !/^\d{1,3}$/.test(raw)) return UNDO_DEFAULT_SECONDS;
  return Math.min(UNDO_MAX_SECONDS, Number(raw));
}

export function setUndoSeconds(storage: Pick<Storage, 'setItem'> | null, seconds: number): void {
  storage?.setItem(UNDO_KEY, String(Math.max(0, Math.min(UNDO_MAX_SECONDS, Math.round(seconds)))));
}

/** Remind-if-no-reply choices, in seconds (null: no reminder). */
export const REMIND_CHOICES: readonly { label: string; seconds: number | null }[] = [
  { label: 'No reminder', seconds: null },
  { label: 'If no reply in 1 day', seconds: 86_400 },
  { label: 'If no reply in 3 days', seconds: 3 * 86_400 },
  { label: 'If no reply in a week', seconds: 7 * 86_400 },
];

/** When to send: now (with the undo window), or at a chosen local time (a datetime-local value). */
export type SendTiming = { kind: 'now' } | { kind: 'later'; local: string };

export type SendOptions = { undoSeconds?: number; sendAt?: string; remindAfterSeconds?: number };

/**
 * The timing fields of the send request, or why they cannot be sent. A later time must be in the
 * future; "now" sends the undo window (0 sends straight away).
 */
export function sendOptions(timing: SendTiming, undo: number, remindAfterSeconds: number | null, now: Date): { ok: true; options: SendOptions } | { ok: false; error: string } {
  const remind = remindAfterSeconds === null ? {} : { remindAfterSeconds };
  if (timing.kind === 'now') return { ok: true, options: { ...(undo > 0 ? { undoSeconds: undo } : {}), ...remind } };
  const at = new Date(timing.local);
  if (timing.local === '' || Number.isNaN(at.getTime())) return { ok: false, error: 'Choose when to send it.' };
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'Pick a time in the future to send it.' };
  return { ok: true, options: { sendAt: at.toISOString(), ...remind } };
}

/** A Date as an <input type="datetime-local"> value, in local time, to the minute. */
export function toLocalInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The answer to a send is held (202) rather than sent (201). */
export function isHeld(result: SendResult | PendingSend): result is PendingSend {
  return 'state' in result && 'releaseAt' in result;
}

/** Whole seconds left before a held send goes (never negative). */
export function secondsLeft(releaseAt: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(releaseAt).getTime() - now.getTime()) / 1000));
}

/** Snooze choices relative to `now`, in local time: later today, tomorrow morning, next week. */
export function snoozeChoices(now: Date): { label: string; until: Date }[] {
  const at = (days: number, hour: number): Date => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const choices: { label: string; until: Date }[] = [];
  const later = new Date(now.getTime() + 3 * 3_600_000);
  if (later.getDate() === now.getDate()) choices.push({ label: 'Later today', until: later });
  choices.push({ label: 'Tomorrow morning', until: at(1, 8) });
  // The next Monday, a week out at most.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  choices.push({ label: 'Next week', until: at(toMonday, 8) });
  return choices;
}

/** The toast's state for a given moment: what it says and whether Undo is still offered. */
export function toastState(pending: PendingSend, now: Date, locale?: string): { text: string; canUndo: boolean; done: boolean } {
  const left = secondsLeft(pending.releaseAt, now);
  if (pending.kind === 'scheduled') {
    const when = new Date(pending.releaseAt).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
    return { text: `Scheduled for ${when}.`, canUndo: left > 0, done: false };
  }
  if (left > 0) return { text: `Sending… ${String(left)} s`, canUndo: true, done: false };
  return { text: 'Sent.', canUndo: false, done: true };
}
