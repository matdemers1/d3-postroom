// Discard in the composer moves the draft to Trash — it never hard-deletes (PST-T-14.1, design audit
// INT/IA; PST-REQ-129: nothing is removed silently, everything passes through Trash with a visible
// clock). The draft is an ordinary message in Drafts, so this is the same move the reading pane's
// Delete makes: read the row's MODSEQ, then PATCH it into Trash. Pure over the API it is handed, so
// it is unit-tested without a browser.
import type { Mailbox, MessageDetail, MessagePatch } from '../api';

export interface DiscardApi {
  message: (id: string) => Promise<Pick<MessageDetail, 'id' | 'modseq' | 'mailboxId'>>;
  patchMessage: (id: string, modseq: string, patch: MessagePatch) => Promise<unknown>;
}

/** What happened to the draft, and the one sentence the mail view says about it. */
export type DiscardOutcome = { kind: 'nothing' } | { kind: 'trashed'; text: string } | { kind: 'kept'; text: string };

export const DRAFT_TRASHED = 'Draft moved to Trash.';
export const DRAFT_KEPT = 'The draft could not be moved to Trash, so it is still in Drafts.';

/** The account's Trash, if the mailbox list has loaded and has one. */
export function trashOf(mailboxes: readonly Pick<Mailbox, 'id' | 'specialUse'>[] | null): string | null {
  return mailboxes?.find((m) => m.specialUse === 'trash')?.id ?? null;
}

/**
 * Moves a saved draft to Trash. A draft never saved (`draftId` null) has nothing to move. Any
 * failure — no Trash, the row gone, a refusal, no answer — leaves the draft where it was and says
 * so: the fallback is never a delete.
 */
export async function discardDraft(client: DiscardApi, draftId: string | null, trashId: string | null): Promise<DiscardOutcome> {
  if (draftId === null) return { kind: 'nothing' };
  if (trashId === null) return { kind: 'kept', text: DRAFT_KEPT };
  try {
    const row = await client.message(draftId);
    if (row.mailboxId === trashId) return { kind: 'trashed', text: DRAFT_TRASHED };
    await client.patchMessage(row.id, row.modseq, { mailboxId: trashId });
    return { kind: 'trashed', text: DRAFT_TRASHED };
  } catch {
    return { kind: 'kept', text: DRAFT_KEPT };
  }
}
