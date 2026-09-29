// What the composer shows, decided purely (PST-T-14.7, PST-REQ-191, PST-ADR-011; design audit
// TF-06, TF-08, CPY-04, MOD-07): which rows are open, how much of a reply's quote is folded away, and
// what the formatting bar writes. Unit-tested; Composer.tsx only renders what these say.
import type { ComposeState } from '../compose';

/** The rows that are revealed on demand. To and Subject are always there. */
export interface Reveal {
  cc: boolean;
  bcc: boolean;
  from: boolean;
}

/**
 * Where a composer starts: a row is open when it already has something in it (a reply-all's Cc, a
 * resumed draft's Bcc, a draft sent from an alias) and closed otherwise — the operator's "too many
 * fields all at once" (PST-REQ-191).
 */
export function initialReveal(state: Pick<ComposeState, 'cc' | 'bcc'>, from: string | null = null, me: string | null = null): Reveal {
  return {
    cc: state.cc.trim() !== '',
    bcc: state.bcc.trim() !== '',
    from: from !== null && me !== null && from.toLowerCase() !== me.toLowerCase(),
  };
}

/** Open one row. Rows never close again by themselves: a revealed row with text in it stays. */
export function reveal(current: Reveal, row: keyof Reveal): Reveal {
  return current[row] ? current : { ...current, [row]: true };
}

// --- Quoted text, folded behind "···" (MOD-07, TF-08) ------------------------------------------------

/** The line a reply's quote starts with (compose.ts's draftFor writes it), or a forward's divider. */
const QUOTE_START = /^(?:On .+ wrote:|-{10} Forwarded message -{10})$/m;

export interface QuoteSplit {
  /** What the person writes — shown in the body. */
  head: string;
  /** The quote, blank lines before it included — folded until asked for. '' when there is none. */
  quote: string;
}

/**
 * Splits a body into what the person is writing and the quote beneath it. `head + quote` is always
 * the whole text again, so the quote can be folded away and joined back without a character lost.
 */
export function splitQuote(text: string): QuoteSplit {
  const match = QUOTE_START.exec(text);
  if (match === null) return { head: text, quote: '' };
  let start = match.index;
  // The blank line(s) that separate the reply from the quote go with the quote.
  while (start > 0 && text.charAt(start - 1) === '\n') start--;
  return { head: text.slice(0, start), quote: text.slice(start) };
}

/** A new head with the folded quote kept under it. */
export function joinQuote(head: string, quote: string): string {
  return head + quote;
}

// --- The formatting bar ("Aa"): Markdown written for the person ---------------------------------------

export type FormatAction = 'bold' | 'italic' | 'link' | 'list' | 'quote';

export const FORMAT_LABELS: Readonly<Record<FormatAction, string>> = {
  bold: 'Bold',
  italic: 'Italic',
  link: 'Link',
  list: 'Bulleted list',
  quote: 'Quote',
};

/**
 * Applies one formatting action to the selection [start, end) of `text` as Markdown, and says where
 * the selection lands. Inline marks wrap the selection (or a placeholder word); block marks prefix
 * every selected line.
 */
export function applyFormat(text: string, start: number, end: number, action: FormatAction): { text: string; start: number; end: number } {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(text.length, Math.max(start, end));
  const selected = text.slice(a, b);
  const inline = (before: string, after: string, placeholder: string) => {
    const inner = selected === '' ? placeholder : selected;
    const next = text.slice(0, a) + before + inner + after + text.slice(b);
    return { text: next, start: a + before.length, end: a + before.length + inner.length };
  };
  switch (action) {
    case 'bold':
      return inline('**', '**', 'bold text');
    case 'italic':
      return inline('_', '_', 'italic text');
    case 'link':
      return inline('[', '](https://)', selected === '' ? 'link text' : selected);
    case 'list':
    case 'quote': {
      const prefix = action === 'list' ? '- ' : '> ';
      const lineStart = text.lastIndexOf('\n', a - 1) + 1;
      const block = text.slice(lineStart, b);
      const prefixed = block
        .split('\n')
        .map((line) => prefix + line)
        .join('\n');
      const next = text.slice(0, lineStart) + prefixed + text.slice(b);
      return { text: next, start: lineStart, end: lineStart + prefixed.length };
    }
  }
}

/** The small words beside the draft status that say which rare options are on (TF-06). */
export function optionsSummary(o: { markdown: boolean; receipt: boolean; sign: boolean; encrypt: boolean; remind: boolean }): string {
  const parts: string[] = [];
  if (o.markdown) parts.push('Markdown');
  if (o.receipt) parts.push('Read receipt');
  if (o.sign) parts.push('Signed');
  if (o.encrypt) parts.push('Encrypted');
  if (o.remind) parts.push('Reminder');
  return parts.join(' · ');
}
