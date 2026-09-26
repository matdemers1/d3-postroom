// The naive Bayes tokenizer (PST-T-5.3). Pure and bounded: the same message always gives the same
// tokens, and no message gives more than MAX_TOKENS, however large it is.
//
// Tokens, in priority order (header tokens first, so a long body can never crowd them out):
//   h:<name>            presence of a header that marks bulk or machine mail (h:list-unsubscribe)
//   h:precedence=<v>    and the value of Precedence / Auto-Submitted
//   list:<id>           the List-Id's identifier (between the angle brackets)
//   from:<domain>       the From address's domain (and from:<parent> for a subdomain)
//   s:<word>            a word of the subject
//   <word>              a word of the first MAX_BODY_CHARS of the plain-text body
//
// Words are lowercased runs of letters and digits (apostrophes, '-' and '_' inside a word are kept),
// between MIN_WORD and MAX_WORD characters; runs of digits alone are dropped (order numbers, dates
// and prices teach nothing that generalises).

import type { HeaderLike } from '../signals.js';

export const MAX_TOKENS = 400;
export const MAX_BODY_CHARS = 8 * 1024;
export const MAX_SUBJECT_CHARS = 512;
export const MIN_WORD = 2;
export const MAX_WORD = 40;

/** Headers whose mere presence is a token. */
export const PRESENCE_HEADERS = [
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'list-post',
  'precedence',
  'auto-submitted',
  'feedback-id',
  'x-campaign',
  'x-mailer',
  'x-auto-response-suppress',
] as const;

export interface TokenInput {
  readonly subject?: string | null;
  /** The From header or bare address; only its domain is used. */
  readonly from?: string | null;
  /** Plain text of the body; only the first MAX_BODY_CHARS are read. */
  readonly bodyText?: string | null;
  /** The message's header fields, when available. */
  readonly headers?: readonly HeaderLike[];
}

const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'_-]*[\p{L}\p{N}])?/gu;
const DIGITS = /^\p{N}+$/u;

export function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD)) {
    const w = m[0];
    if (w.length < MIN_WORD || w.length > MAX_WORD || DIGITS.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** The domain of the last address-looking thing in a From value, lowercased; null when none. */
export function fromDomain(from: string): string | null {
  const matches = [...from.matchAll(/@([A-Za-z0-9.-]+)/g)];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const domain = (last[1] ?? '').toLowerCase().replace(/\.+$/, '').replace(/^\.+/, '');
  return domain.includes('.') ? domain : null;
}

function header(headers: readonly HeaderLike[], name: string): string | null {
  for (const h of headers) if (h.name.toLowerCase() === name) return h.value;
  return null;
}

/** Tokens for one message, at most MAX_TOKENS (repeats kept: the model is multinomial). */
export function tokenize(input: TokenInput): string[] {
  const out: string[] = [];
  const push = (t: string): boolean => {
    if (out.length >= MAX_TOKENS) return false;
    out.push(t);
    return true;
  };

  const headers = input.headers ?? [];
  const present = new Set(headers.map((h) => h.name.toLowerCase()));
  for (const name of PRESENCE_HEADERS) if (present.has(name)) push(`h:${name}`);
  for (const name of ['precedence', 'auto-submitted'] as const) {
    const v = header(headers, name);
    const value = v === null ? '' : (words(v)[0] ?? '');
    if (value !== '') push(`h:${name}=${value}`);
  }
  const listId = header(headers, 'list-id');
  if (listId !== null) {
    const id = (/<([^>]+)>/.exec(listId)?.[1] ?? listId).trim().toLowerCase();
    if (id !== '' && id.length <= 200) push(`list:${id}`);
  }

  const fromValue = input.from ?? header(headers, 'from');
  const domain = fromValue === null ? null : fromDomain(fromValue);
  if (domain !== null) {
    push(`from:${domain}`);
    const labels = domain.split('.');
    if (labels.length > 2) push(`from:${labels.slice(-2).join('.')}`);
  }

  const subject = input.subject ?? header(headers, 'subject') ?? '';
  for (const w of words(subject.slice(0, MAX_SUBJECT_CHARS))) if (!push(`s:${w}`)) return out;

  const body = (input.bodyText ?? '').slice(0, MAX_BODY_CHARS);
  for (const w of words(body)) if (!push(w)) return out;
  return out;
}

/** Occurrences of each token, in first-seen order. */
export function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}
