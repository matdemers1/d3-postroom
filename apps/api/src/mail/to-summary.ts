// PST-T-16.12 (PST-REQ-199): the stored to-summary a Sent or Drafts row shows in place of the
// sender — the first recipient's display name (else its address) and how many recipients there
// are. The twin of apps/worker/src/stages/recipients.ts's recipientSummary (the worker cannot
// import from the API, nor the API from the worker's src); the integration test
// apps/api/test/integration/mail-to-summary.test.ts holds them to the same answer.
//
// For the API's own filing paths (the composer's Sent copy and drafts), which already hold the
// parsed recipients: `toSummaryColumns([...to, ...cc, ...bcc])` spreads straight into the message
// row's data.
import type { Mailbox } from '@postroom/mime';

/** The longest name a row keeps; a longer one is cut, not rejected (as from_name is, PST-T-14.2). */
const MAX_NAME = 200;

/** C0 and C1 controls (and DEL): an encoded-word can smuggle them into a decoded name. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  return Array.from(t).slice(0, MAX_NAME).join('');
}

export interface ToSummaryColumns {
  /** The first recipient's display name, else its address; null when there are no recipients. */
  readonly toName: string | null;
  /** Distinct recipients (by address, case-insensitively); 0 when there are none. */
  readonly toCount: number;
}

/**
 * The to-summary of a message's recipients, in header order (To, then Cc, then Bcc). A mailbox with
 * neither an address nor a name is not a recipient; the same address twice counts once.
 */
export function toSummaryColumns(recipients: readonly Mailbox[]): ToSummaryColumns {
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
