// One composer per piece of writing, across its saves (PST-T-14.7). A resumed draft's URL names the
// draft (`/mail/:drafts/:id?compose=draft`, so a reload finds it), but every save REPLACES the draft
// and answers with a new id — so the URL is moved on to the new id, and without this the composer,
// keyed by what it is editing, would be torn down and rebuilt mid-sentence. The mail view keys the
// composer with composerKey(): a draft id this composer saved maps back to the id it was opened with.
import type { ComposeDraft } from '../compose';

const resumedAs = new Map<string, string>();

/** Remember that `savedId` is the same draft the composer opened as `openedId`. */
export function linkSavedDraft(openedId: string, savedId: string): void {
  const root = resumedAs.get(openedId) ?? openedId;
  if (savedId !== root) resumedAs.set(savedId, root);
}

/** The React key for the composer of `draft`: stable across a resumed draft's saves. */
export function composerKey(draft: Pick<ComposeDraft, 'mode' | 'sourceId' | 'resumeId'>): string {
  const resume = draft.resumeId ?? null;
  if (resume !== null) return `draft:${resumedAs.get(resume) ?? resume}`;
  return `${draft.mode}:${draft.sourceId ?? ''}`;
}
