// The composer's attachments (PST-T-15.11, PST-REQ-195, PST-ADR-013), as pure state: which files
// are uploading, which are held as uploads on the server, which failed and why; what is refused
// before any request (a file bigger than the limit, a set past the total or the count); the total
// against the limit; what blocks Send; and what the draft and the send carry. Every rule is here,
// unit-tested (test/unit/compose-attachments.test.ts); the composer only wires it to the XHR in
// ./upload.ts and to the chips in ./AttachmentChips.tsx.
//
// The File objects themselves are not state: the composer keeps them beside it, by key, so a failed
// upload can be retried without asking for the file again.
import { ApiError, serverUnreachable, type ComposeLimits, type ComposeUpload } from '../../../api';
import { byteSize } from '../../format';

/** What the server says when it cannot be asked (PST-ADR-013's defaults): 20 MiB, 20 files. */
export const DEFAULT_LIMITS: ComposeLimits = { maxAttachmentBytes: 20 * 1024 * 1024, maxAttachments: 20 };

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
  | (Base & { kind: 'failed'; reason: string });

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
        ? `${quoteName(tooBig[0])} is ${byteSize(tooBig[0]?.size ?? 0)}, more than the ${max} a message can carry, so it was not attached.`
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
  return update(items, key, (a) => (a.kind === 'uploading' ? { key: a.key, name: a.name, size: a.size, contentType: a.contentType, kind: 'failed', reason } : a));
}

/** Retry: the failed chip is uploading again, from 0. */
export function retrying(items: Attachments, key: string): AttachmentItem[] {
  return update(items, key, (a) => (a.kind === 'failed' ? { key: a.key, name: a.name, size: a.size, contentType: a.contentType, kind: 'uploading', loaded: 0 } : a));
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
  const bad = items.filter((a) => a.kind === 'failed');
  if (bad.length > 0) return `${names(bad)} could not be uploaded. Retry ${bad.length === 1 ? 'it' : 'them'} or remove ${bad.length === 1 ? 'it' : 'them'} before sending.`;
  return null;
}

/** Whole percent uploaded, 0–100. An empty file is done as soon as it starts. */
export function percent(item: AttachmentItem): number {
  if (item.kind !== 'uploading') return 100;
  if (item.size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((item.loaded / item.size) * 100)));
}

/** "4.2 MB of 20 MB" — shown once the total passes NEAR_LIMIT of the limit; null before then. */
export function totalLine(items: Attachments, limits: ComposeLimits): string | null {
  const total = totalBytes(items);
  if (items.length === 0 || total < limits.maxAttachmentBytes * NEAR_LIMIT) return null;
  return `${byteSize(total)} of ${byteSize(limits.maxAttachmentBytes)}`;
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
