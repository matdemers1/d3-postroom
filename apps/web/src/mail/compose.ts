// What a new reply, reply-all, forward or blank message starts with. PST-T-3.11 builds the real
// composer (sending, drafts, attachments) on top of this — the prefill rules live here, pure and
// unit-tested, so the composer and the keyboard shortcuts agree on them.
import type { MessageBody, MessageDetail } from '../api';
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
