// PST-T-14.1 (design audit INT/IA; PST-REQ-129): Discard moves the draft to Trash and says so; it
// never hard-deletes, not even as a fallback.
import { describe, expect, it, vi } from 'vitest';
import { discardDraft, DRAFT_KEPT, DRAFT_TRASHED, trashOf, type DiscardApi } from '../../src/mail/discard';

function client(over: Partial<DiscardApi> = {}): DiscardApi & { patchMessage: ReturnType<typeof vi.fn> } {
  return {
    message: vi.fn((id: string) => Promise.resolve({ id, modseq: '42', mailboxId: 'drafts' })),
    patchMessage: vi.fn(() => Promise.resolve({})),
    ...over,
  } as DiscardApi & { patchMessage: ReturnType<typeof vi.fn> };
}

describe('discardDraft', () => {
  it('moves the draft into Trash with its current MODSEQ, and says "Draft moved to Trash."', async () => {
    const c = client();
    const outcome = await discardDraft(c, 'd-1', 'trash');
    expect(c.patchMessage).toHaveBeenCalledWith('d-1', '42', { mailboxId: 'trash' });
    expect(outcome).toEqual({ kind: 'trashed', text: DRAFT_TRASHED });
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
