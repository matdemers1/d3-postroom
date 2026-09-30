// The composer's attachments (PST-T-15.11, PST-REQ-195, PST-ADR-013), as pure state: which files
// are uploading, which are held as uploads on the server, which failed and why; what is refused
// before any request (a file bigger than the limit, a set past the total or the count); the total
// against the limit; what blocks Send; and what the draft and the send carry. Every rule is here,
// unit-tested (test/unit/compose-attachments.test.ts); the composer only wires it to the XHR in
// ./upload.ts and to the chips in ./AttachmentChips.tsx.
//
// The File objects themselves are not state: the composer keeps them beside it, by key, so a failed
// upload can be retried without asking for the file again.
import { ApiError, serverUnreachable, type ComposeLimits, type ComposeUpload, type DraftInput, type DraftSaved, type OmittedAttachment, type SavedDraft } from '../../../api';
import { byteSize } from '../../format';

/** What the server says when it cannot be asked (PST-ADR-013's defaults): 17 MiB, 20 files. The
 *  composer always asks (GET /api/compose/limits); this is only its fallback. */
export const DEFAULT_LIMITS: ComposeLimits = { maxAttachmentBytes: 17 * 1024 * 1024, maxAttachments: 20 };

/** The total line shows from this share of the limit on. */
export const NEAR_LIMIT = 0.7;

/** What the composer knows about a file before it is sent anywhere. */
export interface FileFacts {
  name: string;
  size: number;
  type: string;
}

interface Base {
  /** This chip's own key: stable across upload, failure and retry. */
  key: string;
  name: string;
  size: number;
  contentType: string;
}

export type AttachmentItem =
  | (Base & { kind: 'uploading'; loaded: number })
  | (Base & { kind: 'done'; id: string })
  /** `retryable`: the file is still in hand to upload again. A held upload the server has since
   *  swept is not — it can only be removed and attached again. */
  | (Base & { kind: 'failed'; reason: string; retryable: boolean });

export type Attachments = readonly AttachmentItem[];

let counter = 0;
/** A fresh chip key. */
export function newKey(): string {
  counter += 1;
  return `att-${String(counter)}`;
}

/** Bytes across every chip — uploading, held or failed: each would be sent once it is there. */
export function totalBytes(items: Attachments): number {
  return items.reduce((sum, a) => sum + a.size, 0);
}

/**
 * Which of `files` may be added to `items`, in order: each one that fits what is left of the total
 * and of the count is admitted; the rest are refused, with one sentence that names them and says
 * why. Nothing refused is ever uploaded.
 */
export function admit<F extends FileFacts>(items: Attachments, files: readonly F[], limits: ComposeLimits): { admitted: F[]; refusal: string | null } {
  const max = byteSize(limits.maxAttachmentBytes);
  let bytes = totalBytes(items);
  let count = items.length;
  const admitted: F[] = [];
  const tooBig: F[] = [];
  const overTotal: F[] = [];
  const overCount: F[] = [];
  for (const f of files) {
    if (f.size > limits.maxAttachmentBytes) tooBig.push(f);
    else if (count + 1 > limits.maxAttachments) overCount.push(f);
    else if (bytes + f.size > limits.maxAttachmentBytes) overTotal.push(f);
    else {
      admitted.push(f);
      bytes += f.size;
      count += 1;
    }
  }
  const parts: string[] = [];
  if (tooBig.length > 0) {
    parts.push(
      tooBig.length === 1
        ? `${quoteName(tooBig[0])} is ${distinctSizes(tooBig[0]?.size ?? 0, limits.maxAttachmentBytes)[0]}, more than the ${distinctSizes(tooBig[0]?.size ?? 0, limits.maxAttachmentBytes)[1]} a message can carry, so it was not attached.`
        : `${names(tooBig)} are each more than the ${max} a message can carry, so they were not attached.`,
    );
  }
  if (overTotal.length > 0) {
    parts.push(`${names(overTotal)} would take this message past its ${max} limit, so ${overTotal.length === 1 ? 'it was' : 'they were'} not attached. Remove something to make room.`);
  }
  if (overCount.length > 0) {
    parts.push(`A message can carry at most ${String(limits.maxAttachments)} files, so ${names(overCount)} ${overCount.length === 1 ? 'was' : 'were'} not attached.`);
  }
  return { admitted, refusal: parts.length === 0 ? null : parts.join(' ') };
}

/**
 * Two sizes that must not read the same when they differ ("20.0 MB, more than the 20.0 MB"): the
 * usual wording, else two decimals, else exact bytes.
 */
export function distinctSizes(a: number, b: number): [string, string] {
  const plain: [string, string] = [byteSize(a), byteSize(b)];
  if (a === b || plain[0] !== plain[1]) return plain;
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (a >= 1024 * 1024 && b >= 1024 * 1024 && mb(a) !== mb(b)) return [mb(a), mb(b)];
  const exact = (n: number): string => `${n.toLocaleString('en-US')} bytes`;
  return [exact(a), exact(b)];
}

function quoteName(f: { name: string } | undefined): string {
  return `“${f?.name ?? ''}”`;
}

function names(files: readonly { name: string }[]): string {
  const q = files.map(quoteName);
  if (q.length === 1) return q[0] ?? '';
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1] ?? ''}`;
}

/** A file admitted: a chip, uploading from 0. */
export function started(items: Attachments, key: string, file: FileFacts): AttachmentItem[] {
  return [...items, { key, name: file.name, size: file.size, contentType: file.type === '' ? 'application/octet-stream' : file.type, kind: 'uploading', loaded: 0 }];
}

function update(items: Attachments, key: string, f: (a: AttachmentItem) => AttachmentItem): AttachmentItem[] {
  const next = items.map((a) => (a.key === key ? f(a) : a));
  // Nothing changed: the same array, so the composer does not render for nothing.
  return next.every((a, i) => a === items[i]) ? (items as AttachmentItem[]) : next;
}

/** Upload progress: bytes sent so far (only while it is uploading, never backwards). */
export function progressed(items: Attachments, key: string, loaded: number): AttachmentItem[] {
  return update(items, key, (a) => (a.kind === 'uploading' && loaded > a.loaded ? { ...a, loaded: Math.min(loaded, a.size) } : a));
}

/** The server holds it: the chip carries the upload's id (and the server's name and size for it). */
export function succeeded(items: Attachments, key: string, upload: ComposeUpload): AttachmentItem[] {
  return update(items, key, (a) =>
    a.kind === 'uploading' ? { key: a.key, kind: 'done', id: upload.id, name: upload.filename === '' ? a.name : upload.filename, size: upload.size, contentType: upload.contentType } : a,
  );
}

/** It could not be uploaded: the chip says why, and offers Retry. */
export function failed(items: Attachments, key: string, reason: string): AttachmentItem[] {
  return update(items, key, (a) => (a.kind === 'uploading' ? { key: a.key, name: a.name, size: a.size, contentType: a.contentType, kind: 'failed', reason, retryable: true } : a));
}

/** Held uploads the server no longer has (swept after a day): the chips say so, with no Retry. */
export function gone(items: Attachments, keys: readonly string[]): AttachmentItem[] {
  const set = new Set(keys);
  let next = items as AttachmentItem[];
  for (const k of set) {
    next = update(next, k, (a) =>
      a.kind === 'done' ? { key: a.key, name: a.name, size: a.size, contentType: a.contentType, kind: 'failed', reason: GONE_REASON, retryable: false } : a,
    );
  }
  return next;
}

export const GONE_REASON = 'No longer on the server. Remove it and attach it again.';

/** Retry: the failed chip is uploading again, from 0. */
export function retrying(items: Attachments, key: string): AttachmentItem[] {
  return update(items, key, (a) => (a.kind === 'failed' && a.retryable ? { key: a.key, name: a.name, size: a.size, contentType: a.contentType, kind: 'uploading', loaded: 0 } : a));
}

/** Remove: the chip goes, whatever state it was in. */
export function removed(items: Attachments, key: string): AttachmentItem[] {
  return items.filter((a) => a.key !== key);
}

/** A saved draft's attachments (GET /api/compose/drafts/:id), as held chips. */
export function fromSaved(uploads: readonly ComposeUpload[] | undefined): AttachmentItem[] {
  return (uploads ?? []).map((u) => ({ key: newKey(), kind: 'done', id: u.id, name: u.filename, size: u.size, contentType: u.contentType }));
}

/** What a draft save and a send carry: the held uploads' ids, in the order they are shown. */
export function uploadIds(items: Attachments): string[] {
  return items.flatMap((a) => (a.kind === 'done' ? [a.id] : []));
}

export function uploading(items: Attachments): boolean {
  return items.some((a) => a.kind === 'uploading');
}

/** Why Send cannot go yet, or null: a file still uploading, or one that failed. */
export function sendBlock(items: Attachments): string | null {
  const busy = items.filter((a) => a.kind === 'uploading');
  if (busy.length > 0) return busy.length === 1 ? `Wait for ${quoteName(busy[0])} to finish uploading.` : `Wait for ${String(busy.length)} files to finish uploading.`;
  const lost = items.filter((a) => a.kind === 'failed' && !a.retryable);
  if (lost.length > 0) return `${names(lost)} ${lost.length === 1 ? 'is' : 'are'} no longer on the server. Remove ${lost.length === 1 ? 'it' : 'them'} and attach ${lost.length === 1 ? 'it' : 'them'} again before sending.`;
  const bad = items.filter((a) => a.kind === 'failed');
  if (bad.length > 0) return `${names(bad)} could not be uploaded. Retry ${bad.length === 1 ? 'it' : 'them'} or remove ${bad.length === 1 ? 'it' : 'them'} before sending.`;
  return null;
}

/** Whole percent uploaded, 0–100. An empty file has nothing left to send: 100. */
export function percent(item: AttachmentItem): number {
  if (item.kind !== 'uploading') return 100;
  if (item.size <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor((item.loaded / item.size) * 100)));
}

/** "4.2 MB of 20 MB" — shown once the total passes NEAR_LIMIT of the limit; null before then. */
export function totalLine(items: Attachments, limits: ComposeLimits): string | null {
  const total = totalBytes(items);
  if (items.length === 0 || total < limits.maxAttachmentBytes * NEAR_LIMIT) return null;
  const [used, max] = distinctSizes(total, limits.maxAttachmentBytes);
  return `${used} of ${max}`;
}

/** An upload refused or lost, in words for the chip. */
export function uploadErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return serverUnreachable('Retry when you are back online.');
  switch (error.code) {
    case 'attachment_too_large':
      return 'Too large for this server.';
    case 'invalid_filename':
      return 'The server refused this file name. Rename the file and attach it again.';
    case 'blobstore_not_configured':
      return 'Postroom is not set up to store files yet.';
    // The account's outstanding uploads, across every unsent draft (PST-ADR-013).
    case 'upload_quota_exceeded':
      return 'Too many attachments waiting — send or remove some first.';
    default:
      if (error.status === 401) return 'You were signed out. Sign in again, then retry.';
      if (error.status === 403) return 'The server refused this upload.';
      return `The upload failed (${error.code}).`;
  }
}

/** A send or save refused because of its attachments, in words; null when it was something else. */
export function attachmentRefusalText(error: unknown, limits: ComposeLimits): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'attachments_too_large':
      return `The attachments are more than the ${byteSize(limits.maxAttachmentBytes)} a message can carry. Remove something, then send.`;
    case 'too_many_attachments':
      return `A message can carry at most ${String(limits.maxAttachments)} files. Remove some, then send.`;
    // An upload vanished between the send being checked and being sent: nothing went.
    case 'attachment_gone':
      return 'An attachment was removed — attach it again. Nothing was sent.';
    default:
      return null;
  }
}

/** What a screen reader hears as uploads start and end — never each percent. */
export function announceStart(files: readonly FileFacts[]): string {
  if (files.length === 0) return '';
  return files.length === 1 ? `Uploading ${files[0]?.name ?? ''}.` : `Uploading ${String(files.length)} files.`;
}

export function announceDone(name: string): string {
  return `${name} attached.`;
}

export function announceFailed(name: string, reason: string): string {
  return `${name} could not be uploaded. ${reason}`;
}

/** Whether a drag carries files (not text or a link being dragged about). */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (types === null || types === undefined) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** A draft part too large to carry on, which stays in the saved draft on the server (PST-ADR-013). */
export function omittedText(o: Pick<OmittedAttachment, 'filename' | 'size'>): string {
  return `${o.filename} (${byteSize(o.size)}) stays in the draft on the server but is too large to send from here.`;
}

/** Whether a paste should attach its files: only when it carries no text. Copying from a spreadsheet,
 *  a document or a web page puts the text AND a picture of it on the clipboard — that is a text paste. */
export function pasteAttaches(types: readonly string[] | DOMStringList | null | undefined, fileCount: number): boolean {
  if (fileCount === 0) return false;
  const list = types === null || types === undefined ? [] : Array.from(types as ArrayLike<string>);
  return !list.includes('text/plain') && !list.includes('text/html');
}

// --- A draft save whose held uploads were swept (PST-T-15.11) ---------------------------------------

/**
 * The server keeps an upload a day; a draft's parts are registered again as fresh uploads whenever
 * the draft is read (GET /api/compose/drafts/:id). So a chip saved into the draft can be re-pointed at
 * its part's fresh upload, matched by name and size, in order. A chip that matches nothing (attached
 * since the last save) keeps its id.
 */
export function remapIds(items: Attachments, fresh: readonly ComposeUpload[]): Map<string, string> {
  const pool = [...fresh];
  const out = new Map<string, string>();
  for (const a of items) {
    if (a.kind !== 'done') continue;
    const i = pool.findIndex((u) => u.filename === a.name && u.size === a.size);
    if (i < 0) continue;
    const [u] = pool.splice(i, 1);
    if (u !== undefined) out.set(a.key, u.id);
  }
  return out;
}

/** Re-point held chips at new upload ids, by key (chips removed meanwhile are left out). */
export function withIds(items: Attachments, ids: ReadonlyMap<string, string>): AttachmentItem[] {
  let next = items as AttachmentItem[];
  for (const [key, id] of ids) next = update(next, key, (a) => (a.kind === 'done' && a.id !== id ? { ...a, id } : a));
  return next;
}

export interface DraftSaveApi {
  createDraft(input: DraftInput): Promise<DraftSaved>;
  replaceDraft(id: string, input: DraftInput): Promise<DraftSaved>;
  draft(id: string): Promise<SavedDraft>;
}

export type DraftSaveOutcome =
  | { ok: true; saved: DraftSaved; ids: Map<string, string>; omitted: OmittedAttachment[] | null }
  | { ok: false; error: unknown; ids: Map<string, string>; omitted: OmittedAttachment[] | null; goneKeys: string[]; goneText: string | null };

const is404 = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

/** The upload id a refusal names, when it names one. */
function namedUpload(error: unknown): string | null {
  if (!(error instanceof ApiError) || typeof error.body !== 'object' || error.body === null) return null;
  const b = error.body as { id?: unknown; uploadId?: unknown };
  if (typeof b.uploadId === 'string') return b.uploadId;
  if (typeof b.id === 'string') return b.id;
  return null;
}

/**
 * Save the draft: create it, or replace `draftId`. A 404 is either the draft gone (sent or discarded
 * in another tab: a new one is made, as before) or a held upload swept: then the draft is read again,
 * which registers its parts afresh, the chips are re-pointed at them, and the save is tried once more.
 * If it still fails, the chips that could be the missing upload are named.
 */
export async function saveDraft(api: DraftSaveApi, draftId: string | null, inputFor: (ids: string[]) => DraftInput, items: Attachments): Promise<DraftSaveOutcome> {
  const ids = new Map<string, string>();
  let omitted: OmittedAttachment[] | null = null;
  const current = (): string[] => items.flatMap((a) => (a.kind === 'done' ? [ids.get(a.key) ?? a.id] : []));
  const put = (id: string | null): Promise<DraftSaved> => (id === null ? api.createDraft(inputFor(current())) : api.replaceDraft(id, inputFor(current())));
  const fail = (error: unknown, goneKeys: string[] = [], goneText: string | null = null): DraftSaveOutcome => ({ ok: false, error, ids, omitted, goneKeys, goneText });
  const done = (saved: DraftSaved): DraftSaveOutcome => ({ ok: true, saved, ids, omitted });
  const held = items.filter((a) => a.kind === 'done');

  let first: unknown;
  try {
    return done(await put(draftId));
  } catch (e) {
    if (!is404(e)) return fail(e);
    first = e;
  }

  /** The chips not re-pointed are the ones that can be missing; name them, or the one the server named. */
  const missing = (error: unknown): DraftSaveOutcome => {
    const named = namedUpload(error);
    const byName = named === null ? undefined : held.find((a) => (ids.get(a.key) ?? a.id) === named);
    const suspects = byName !== undefined ? [byName] : held.filter((a) => !ids.has(a.key));
    if (suspects.length === 0) return fail(error);
    const text =
      suspects.length === 1
        ? `The draft was not saved: ${quoteName(suspects[0])} is no longer on the server (an attachment is kept a day before it is saved). Remove it and attach it again.`
        : `The draft was not saved: ${names(suspects)} are no longer on the server (an attachment is kept a day before it is saved). Remove them and attach them again.`;
    return fail(error, suspects.map((a) => a.key), text);
  };

  // No held uploads: the 404 can only be the draft, gone elsewhere — start a new one.
  if (held.length === 0) {
    if (draftId === null) return fail(first);
    try {
      return done(await api.createDraft(inputFor([])));
    } catch (e) {
      return fail(e);
    }
  }

  // A new draft that was never saved has no parts to register again.
  if (draftId === null) return missing(first);

  let fresh: SavedDraft;
  try {
    fresh = await api.draft(draftId);
  } catch (e) {
    if (!is404(e)) return fail(first);
    // The draft is gone elsewhere: a new one, with what is held.
    try {
      return done(await put(null));
    } catch (e2) {
      return is404(e2) ? missing(e2) : fail(e2);
    }
  }
  omitted = fresh.omittedAttachments ?? null;
  for (const [k, v] of remapIds(items, fresh.attachments ?? [])) ids.set(k, v);
  try {
    return done(await put(draftId));
  } catch (e) {
    return is404(e) ? missing(e) : fail(e);
  }
}
