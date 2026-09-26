// What a new reply, reply-all, forward or blank message starts with, and what the composer sends
// and saves (PST-T-3.11) — the rules live here, pure and unit-tested, so the composer and the
// keyboard shortcuts agree on them.
import { ApiError, type ComposeFields, type MessageBody, type MessageDetail, type SavedDraft } from '../api';
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
    default:
      return `Nothing was sent (${error.code}). Try again.`;
  }
}
