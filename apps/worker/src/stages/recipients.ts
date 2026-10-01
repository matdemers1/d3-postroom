// PST-T-16.12 (PST-REQ-199): the pure half of the to-summary — what a Sent or Drafts row shows in
// place of the sender. The first recipient (To, then Cc, then Bcc) by its decoded display name, else
// its address, and how many distinct recipients there are across all three. Bcc is counted because
// it is who the message went to; it only survives on our own Drafts copies (a sent message carries no
// Bcc header), so a Sent copy filed from Drafts keeps the Drafts count, and everything else counts To + Cc. The parse stage derives it; ./to-summary.ts backfills it.
import { parseMailboxes, type Mailbox } from '@postroom/mime';

/** The longest name a row keeps; a longer one is cut, not rejected (as from_name is, PST-T-14.2). */
const MAX_NAME = 200;

/** C0 and C1 controls (and DEL): an encoded-word can smuggle them into a decoded name. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  return Array.from(t).slice(0, MAX_NAME).join('');
}

export interface ToSummary {
  /** The first recipient's display name, else its address; null when there are no recipients. */
  readonly toName: string | null;
  /** Distinct recipients (by address, case-insensitively); 0 when there are none. */
  readonly toCount: number;
}

/**
 * The to-summary of a message's recipients, in header order. A mailbox with neither an address nor
 * a name is not a recipient; the same address twice counts once. The API's twin is
 * apps/api/src/mail/to-summary.ts (toSummaryColumns) — keep them in step.
 */
export function recipientSummary(recipients: readonly Mailbox[]): ToSummary {
  const seen = new Set<string>();
  let toName: string | null = null;
  for (const r of recipients) {
    const address = clean(r.address);
    const name = clean(r.name);
    if (address === '' && name === '') continue;
    const key = address === '' ? `name:${name.toLowerCase()}` : address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    toName ??= name === '' ? address : name;
  }
  return { toName, toCount: seen.size };
}

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc'] as const;

/** The to-summary of a header block: every To, then every Cc, then every Bcc field (groups flattened). */
export function toSummaryOfHeaders(headers: readonly { name: string; value: string }[]): ToSummary {
  const recipients: Mailbox[] = [];
  for (const field of RECIPIENT_FIELDS) {
    for (const h of headers) if (h.name.trim().toLowerCase() === field) recipients.push(...parseMailboxes(h.value));
  }
  return recipientSummary(recipients);
}
