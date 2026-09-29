// Discard in the composer moves the draft to Trash — it never hard-deletes (PST-T-14.1, design audit
// INT/IA; PST-REQ-129: nothing is removed silently, everything passes through Trash with a visible
// clock). The draft is an ordinary message in Drafts, so this is the same move the reading pane's
// Delete makes: read the row's MODSEQ, then PATCH it into Trash. PST-T-14.7 adds the way back: the
// toast's Undo moves the trashed copy (a move answers with a NEW id) home to Drafts. Pure over the
// API it is handed, so it is unit-tested without a browser.
import type { Mailbox, MessageDetail, MessagePatch } from '../api';

export interface DiscardApi {
  message: (id: string) => Promise<Pick<MessageDetail, 'id' | 'modseq' | 'mailboxId'>>;
  patchMessage: (id: string, modseq: string, patch: MessagePatch) => Promise<unknown>;
}

/** What happened to the draft, and the one sentence the mail view says about it. */
export type DiscardOutcome =
  | { kind: 'nothing' }
  /** `trashedId` is the copy now in Trash (null if the server did not say), for Undo. */
  | { kind: 'trashed'; text: string; trashedId: string | null }
  | { kind: 'kept'; text: string }
  /** Undo put it back in Drafts. */
  | { kind: 'restored'; text: string }
  /** Undo could not: it is still in Trash. */
  | { kind: 'unrestored'; text: string };

export const DRAFT_TRASHED = 'Draft moved to Trash.';
export const DRAFT_KEPT = 'The draft could not be moved to Trash, so it is still in Drafts.';
export const DRAFT_RESTORED = 'Draft moved back to Drafts.';
export const DRAFT_NOT_RESTORED = 'The draft could not be moved back. It is still in Trash.';

/** The account's Trash, if the mailbox list has loaded and has one. */
export function trashOf(mailboxes: readonly Pick<Mailbox, 'id' | 'specialUse'>[] | null): string | null {
  return mailboxes?.find((m) => m.specialUse === 'trash')?.id ?? null;
}

/** The account's Drafts, where Undo sends a discarded draft back to. */
export function draftsOf(mailboxes: readonly Pick<Mailbox, 'id' | 'specialUse'>[] | null): string | null {
  return mailboxes?.find((m) => m.specialUse === 'drafts')?.id ?? null;
}

function idOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const id = (answer as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
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
    if (row.mailboxId === trashId) return { kind: 'trashed', text: DRAFT_TRASHED, trashedId: row.id };
    const moved = await client.patchMessage(row.id, row.modseq, { mailboxId: trashId });
    return { kind: 'trashed', text: DRAFT_TRASHED, trashedId: idOf(moved) };
  } catch {
    return { kind: 'kept', text: DRAFT_KEPT };
  }
}

/**
 * Undo: moves the discarded draft from Trash back into Drafts. Reads the row first — its MODSEQ, and
 * whether it is still in Trash at all (another device may have moved it). Never deletes anything.
 */
export async function restoreDraft(client: DiscardApi, trashedId: string | null, draftsId: string | null): Promise<Extract<DiscardOutcome, { kind: 'restored' | 'unrestored' }>> {
  if (trashedId === null || draftsId === null) return { kind: 'unrestored', text: DRAFT_NOT_RESTORED };
  try {
    const row = await client.message(trashedId);
    if (row.mailboxId !== draftsId) await client.patchMessage(row.id, row.modseq, { mailboxId: draftsId });
    return { kind: 'restored', text: DRAFT_RESTORED };
  } catch {
    return { kind: 'unrestored', text: DRAFT_NOT_RESTORED };
  }
}
