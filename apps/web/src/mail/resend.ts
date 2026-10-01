// "Edit and resend" (PST-T-16.14, design finding PST-DA-024): a bounced or cancelled recipient leads
// somewhere. Pure helpers, so they run under Node without @d3cloud/ui: who the new message goes to,
// the draft it is made from, what is left behind (attachments), and the admin queue link.
//
// The new message is an ordinary draft made with POST /api/compose/drafts — nothing is sent — and the
// reader lands in the composer with it open. It carries the same Subject and the same text body the
// Sent copy had. Attachments are not copied (a draft takes uploaded ids, and a sent message's parts
// are not uploads), and neither is formatted (HTML-only) content: resendNotes says so, up front.
import type { DeliveryRecipient, DraftInput, MessageBody } from '../api';

/** A recipient that offers "Edit and resend": the mail never reached them, and nothing will retry it. */
export function canResend(state: DeliveryRecipient['state']): boolean {
  return state === 'bounced' || state === 'cancelled';
}

/**
 * Who the new message goes to. A bounced recipient: just that address (the others got it). A cancelled
 * one: every recipient of the message that was cancelled — cancelling pulls a whole message, and
 * resending to the ones that were delivered would send them a duplicate.
 */
export function resendTargets(recipients: readonly Pick<DeliveryRecipient, 'address' | 'state'>[], clicked: Pick<DeliveryRecipient, 'address' | 'state'>): string[] {
  const addresses = clicked.state === 'cancelled' ? recipients.filter((r) => r.state === 'cancelled').map((r) => r.address) : [clicked.address];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses.length > 0 ? addresses : [clicked.address]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/** What the new draft is made from: the sent message's Subject and its text body. */
export interface ResendSource {
  subject: string | null;
  text: string | null;
}

/** The draft: the same To (the failed recipients), Subject and body, and nothing threaded or forwarded. */
export function resendDraftInput(source: ResendSource, to: readonly string[]): DraftInput {
  return {
    to: [...to],
    cc: [],
    bcc: [],
    subject: source.subject ?? '',
    text: source.text ?? '',
    inReplyTo: null,
    references: [],
    forwardOf: null,
    mode: null,
    sourceId: null,
  };
}

/** What the draft leaves behind, in plain words — shown beside the button, never dropped silently. */
export function resendNotes(body: Pick<MessageBody, 'text' | 'textTruncated' | 'html' | 'attachments'> | null): string[] {
  if (body === null) return [];
  const notes: string[] = [];
  if (body.attachments.length > 0) notes.push(body.attachments.length === 1 ? 'The attachment isn’t copied. Add it again in the composer.' : 'Attachments aren’t copied. Add them again in the composer.');
  if (body.text === null && body.html !== null) notes.push('Only the plain text is copied, and this message has none.');
  else if (body.textTruncated) notes.push('This message is long, so only the start of it is copied.');
  return notes;
}

/** The admin queue, filtered to one outbound message (the queue's `?message=`). */
export function queuePath(outboundId: string): string {
  return `/admin/queue?message=${encodeURIComponent(outboundId)}`;
}
