// One composer per piece of writing, across its saves (PST-T-14.7). While a draft is being written
// its URL names it (`?compose=draft`, so a reload finds it) — but every save REPLACES the draft and
// answers with a new id, and a new message only gets an id at its first save. So the URL moves on
// to each new id, and without this the composer, keyed by what it is editing, would be torn down and
// rebuilt mid-sentence. A composer records every id it saves under its own key; the mail view keys
// the composer with composerKey(), which maps such an id back to that key.
import type { ComposeDraft } from '../compose';

const keyOfSaved = new Map<string, string>();

/** Remember that `savedId` is the draft the composer keyed `key` is writing. */
export function linkSavedDraft(key: string, savedId: string): void {
  keyOfSaved.set(savedId, key);
}

/** The React key for the composer of `draft`: stable across a draft's saves. */
export function composerKey(draft: Pick<ComposeDraft, 'mode' | 'sourceId' | 'resumeId'>): string {
  const resume = draft.resumeId ?? null;
  if (resume !== null) return keyOfSaved.get(resume) ?? `draft:${resume}`;
  return `${draft.mode}:${draft.sourceId ?? ''}`;
}

/** The composer keyed `key` has closed: its drafts, opened again later, get keys of their own. */
export function forgetDrafts(key: string): void {
  for (const [id, k] of keyOfSaved) if (k === key) keyOfSaved.delete(id);
}
