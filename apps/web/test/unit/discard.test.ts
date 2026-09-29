// PST-T-14.1 (design audit INT/IA; PST-REQ-129): Discard moves the draft to Trash and says so; it
// never hard-deletes, not even as a fallback.
import { describe, expect, it, vi } from 'vitest';
import { discardDraft, draftsOf, DRAFT_KEPT, DRAFT_NOT_RESTORED, DRAFT_RESTORED, DRAFT_TRASHED, restoreDraft, trashOf, type DiscardApi } from '../../src/mail/discard';

function client(over: Partial<DiscardApi> = {}): DiscardApi & { patchMessage: ReturnType<typeof vi.fn> } {
  return {
    message: vi.fn((id: string) => Promise.resolve({ id, modseq: '42', mailboxId: 'drafts' })),
    patchMessage: vi.fn((id: string) => Promise.resolve({ id: `${id}-moved` })),
    ...over,
  } as DiscardApi & { patchMessage: ReturnType<typeof vi.fn> };
}

describe('discardDraft', () => {
  it('moves the draft into Trash with its current MODSEQ, and says "Draft moved to Trash."', async () => {
    const c = client();
    const outcome = await discardDraft(c, 'd-1', 'trash');
    expect(c.patchMessage).toHaveBeenCalledWith('d-1', '42', { mailboxId: 'trash' });
    // A move answers with the NEW id: the copy in Trash, which Undo moves back (PST-T-14.7).
    expect(outcome).toEqual({ kind: 'trashed', text: DRAFT_TRASHED, trashedId: 'd-1-moved' });
    expect(DRAFT_TRASHED).toBe('Draft moved to Trash.');
  });

  it('has nothing to move for a draft that was never saved', async () => {
    const c = client();
    expect(await discardDraft(c, null, 'trash')).toEqual({ kind: 'nothing' });
    expect(c.patchMessage).not.toHaveBeenCalled();
  });

  it('keeps the draft, and says so, when there is no Trash or the move fails', async () => {
    const c = client();
    expect(await discardDraft(c, 'd-1', null)).toEqual({ kind: 'kept', text: DRAFT_KEPT });
    expect(c.patchMessage).not.toHaveBeenCalled();
    const failing = client({ patchMessage: vi.fn(() => Promise.reject(new Error('412'))) });
    expect(await discardDraft(failing, 'd-1', 'trash')).toEqual({ kind: 'kept', text: DRAFT_KEPT });
  });

  it('the client it is handed has no delete at all', () => {
    expect(Object.keys(client())).not.toContain('deleteDraft');
  });
});

describe('trashOf', () => {
  it('finds Trash by its special use', () => {
    expect(trashOf([{ id: 'a', specialUse: 'inbox' }, { id: 't', specialUse: 'trash' }])).toBe('t');
    expect(trashOf(null)).toBeNull();
  });
});

// PST-T-14.7: the toast's Undo moves the discarded draft home to Drafts — and still never deletes.
describe('restoreDraft', () => {
  it('moves the trashed copy back into Drafts with its current MODSEQ', async () => {
    const c = client({ message: vi.fn((id: string) => Promise.resolve({ id, modseq: '7', mailboxId: 'trash' })) });
    expect(await restoreDraft(c, 'd-1-moved', 'drafts')).toEqual({ kind: 'restored', text: DRAFT_RESTORED });
    expect(c.patchMessage).toHaveBeenCalledWith('d-1-moved', '7', { mailboxId: 'drafts' });
  });

  it('does nothing more when it is already back in Drafts', async () => {
    const c = client({ message: vi.fn((id: string) => Promise.resolve({ id, modseq: '7', mailboxId: 'drafts' })) });
    expect(await restoreDraft(c, 'd-1', 'drafts')).toEqual({ kind: 'restored', text: DRAFT_RESTORED });
    expect(c.patchMessage).not.toHaveBeenCalled();
  });

  it('says it is still in Trash when there is nothing to move, no Drafts, or the move fails', async () => {
    const c = client();
    expect(await restoreDraft(c, null, 'drafts')).toEqual({ kind: 'unrestored', text: DRAFT_NOT_RESTORED });
    expect(await restoreDraft(c, 'd-1', null)).toEqual({ kind: 'unrestored', text: DRAFT_NOT_RESTORED });
    const failing = client({ patchMessage: vi.fn(() => Promise.reject(new Error('412'))), message: vi.fn((id: string) => Promise.resolve({ id, modseq: '1', mailboxId: 'trash' })) });
    expect(await restoreDraft(failing, 'd-1', 'drafts')).toEqual({ kind: 'unrestored', text: DRAFT_NOT_RESTORED });
  });

  it('finds Drafts by its special use', () => {
    expect(draftsOf([{ id: 'a', specialUse: 'inbox' }, { id: 'd', specialUse: 'drafts' }])).toBe('d');
    expect(draftsOf(null)).toBeNull();
  });
});
