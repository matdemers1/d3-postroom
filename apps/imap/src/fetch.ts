// FETCH and UID FETCH (RFC 9051 §6.4.5, RFC 3516 BINARY; PST-REQ-070).
//
// Body data is never held in memory: every section is a streaming literal over a byte range of the
// decrypted blob, its size known up front from the structure scan (or, for BINARY, from one
// decoding pass). One response is written per message, as soon as it is built.
//
// A body fetch that is not a PEEK sets \Seen (unless the mailbox was EXAMINEd); the flag change is
// stored — bumping modseq like any STORE — before the data goes out, and FLAGS is added to that
// message's response.
import {
  dateToDateTime,
  fetchItems,
  fetchResponse,
  streamLiteral,
  type Command,
  type FetchAtt,
  type FetchResponseItem,
  type PartialRange,
  type Response,
  type ResponseCode,
  type Section,
  type SectionData,
} from '@postroom/imap-proto';
import { binaryDecodable, binarySize, blobRange, decodedBody, sliceStream, type BlobReader, type StructureCache } from './content.js';
import { hasFlag, SEEN } from './flags.js';
import { bodyStructureOf, envelopeOf, headerFields } from './render.js';
import { resolvePart, type MimeNode } from './structure.js';
import type { MailStore, MessageRow } from './store.js';
import type { MailboxView } from './view.js';

export interface FetchContext {
  readonly store: MailStore;
  readonly structures: StructureCache;
  readonly blobs: BlobReader;
  readonly view: MailboxView;
  readonly utf8: boolean;
  /** The session is CONDSTORE-aware: an implicit \\Seen change carries MODSEQ (RFC 7162 §3.1.4.1). */
  readonly condstore?: boolean;
  readonly saved: readonly number[] | null;
  write(response: Response): Promise<void>;
}

export interface FetchOutcome {
  readonly status: 'OK' | 'NO';
  readonly code: ResponseCode | null;
  readonly text: string;
}

type FetchCommand = Extract<Command, { name: 'FETCH' }>;

function marksSeen(item: FetchAtt): boolean {
  if (item.type === 'RFC822' || item.type === 'RFC822.TEXT') return true;
  if (item.type === 'BODY[]' || item.type === 'BINARY[]') return !item.peek;
  return false;
}

function needsStructure(item: FetchAtt): boolean {
  switch (item.type) {
    case 'ENVELOPE':
    case 'BODY':
    case 'BODYSTRUCTURE':
    case 'RFC822.HEADER':
    case 'RFC822.TEXT':
    case 'BINARY.SIZE':
      return true;
    case 'BODY[]':
      return item.section.part.length > 0 || item.section.text !== null;
    case 'BINARY[]':
      return item.part.length > 0;
    default:
      return false;
  }
}

/** A byte range of the blob, or literal bytes, or NIL. */
export type Span = { readonly kind: 'range'; readonly start: number; readonly end: number } | { readonly kind: 'bytes'; readonly data: Buffer } | null;

export function sectionSpan(root: MimeNode | null, size: number, section: Section): Span {
  if (section.part.length === 0 && section.text === null) return { kind: 'range', start: 0, end: size };
  if (root === null) return null;
  const base = section.part.length === 0 ? root : resolvePart(root, section.part);
  if (base === null) return null;
  switch (section.text) {
    case null:
      return { kind: 'range', start: base.bodyStart, end: base.bodyEnd };
    case 'MIME':
      return { kind: 'range', start: base.headerStart, end: base.bodyStart };
    default: {
      const msg = section.part.length === 0 ? root : base.kind === 'message' ? base.message : null;
      if (msg === null) return null;
      if (section.text === 'HEADER') return { kind: 'range', start: msg.headerStart, end: msg.bodyStart };
      if (section.text === 'TEXT') return { kind: 'range', start: msg.bodyStart, end: msg.bodyEnd };
      return { kind: 'bytes', data: headerFields(msg.headers, section.fields, section.text === 'HEADER.FIELDS.NOT') };
    }
  }
}

function spanData(blobs: BlobReader, sha256: string, span: Span, partial: PartialRange | null): SectionData {
  if (span === null) return null;
  if (span.kind === 'bytes') {
    if (partial === null) return span.data;
    return span.data.subarray(Math.min(partial.offset, span.data.length), Math.min(partial.offset + partial.length, span.data.length));
  }
  let { start, end } = span;
  if (partial !== null) {
    start = Math.min(end, start + partial.offset);
    end = Math.min(end, start + partial.length);
  }
  return streamLiteral(end - start, blobRange(blobs, sha256, start, end));
}

async function binaryData(ctx: FetchContext, row: MessageRow, root: MimeNode | null, part: readonly number[], partial: PartialRange | null): Promise<SectionData> {
  if (part.length === 0) return spanData(ctx.blobs, row.blobSha256, { kind: 'range', start: 0, end: row.size }, partial);
  const node = root === null ? null : resolvePart(root, part);
  if (node === null) return null;
  const size = await binarySize(ctx.blobs, row.blobSha256, node);
  const offset = partial === null ? 0 : Math.min(partial.offset, size);
  const length = partial === null ? size : Math.min(partial.length, size - offset);
  const source = partial === null ? decodedBody(ctx.blobs, row.blobSha256, node) : sliceStream(decodedBody(ctx.blobs, row.blobSha256, node), offset, length);
  return streamLiteral(length, source, true);
}

export async function runFetch(ctx: FetchContext, cmd: FetchCommand): Promise<FetchOutcome> {
  const items = fetchItems(cmd);
  if ((cmd.uid || cmd.changedSince !== null) && !items.some((i) => i.type === 'UID')) items.unshift({ type: 'UID' });
  const view = ctx.view;
  const pairs = cmd.uid ? view.resolveUids(cmd.set, ctx.saved) : view.resolveSeqs(cmd.set, ctx.saved);
  const live = pairs.filter(([, u]) => !view.isExpunged(u));
  let expungeIssued = live.length < pairs.length;
  let rows = await ctx.store.rowsByUids(
    view.mailboxId,
    live.map(([, u]) => u),
  );
  if (cmd.changedSince !== null) {
    const since = cmd.changedSince;
    rows = rows.filter((r) => r.modseq > since);
  }
  const byUid = new Map(rows.map((r) => [r.uid, r]));

  const wantStructure = items.some(needsStructure);
  const binaryParts = items.flatMap((i) => (i.type === 'BINARY[]' || i.type === 'BINARY.SIZE' ? [i.part] : []));

  // BINARY on an encoding we cannot undo is a tagged NO [UNKNOWN-CTE], before any output.
  if (binaryParts.some((p) => p.length > 0)) {
    for (const r of rows) {
      const { root } = await ctx.structures.get(r.blobSha256);
      for (const p of binaryParts) {
        const node = p.length === 0 ? null : resolvePart(root, p);
        if (node !== null && !binaryDecodable(node)) {
          return { status: 'NO', code: { type: 'UNKNOWN-CTE' }, text: 'Cannot decode the content transfer encoding of that part' };
        }
      }
    }
  }

  // \Seen, set before any data leaves.
  const seenSet = new Set<number>();
  if (!view.readOnly && items.some(marksSeen)) {
    const unseen = rows.filter((r) => !hasFlag(r.flags, SEEN)).map((r) => r.uid);
    if (unseen.length > 0) {
      const res = await ctx.store.storeFlags(view.mailboxId, unseen, 'add', [SEEN]);
      for (const r of res.rows) {
        const prior = byUid.get(r.uid);
        if (prior === undefined) continue;
        byUid.set(r.uid, { ...prior, flags: r.flags, modseq: r.modseq });
        if (res.changed.has(r.uid)) seenSet.add(r.uid);
      }
    }
  }

  const includeFlags = items.some((i) => i.type === 'FLAGS');
  for (const [seq, uid] of live) {
    const row = byUid.get(uid);
    if (row === undefined) {
      if (cmd.changedSince === null) expungeIssued = true;
      continue;
    }
    const root = wantStructure ? (await ctx.structures.get(row.blobSha256)).root : null;
    const out: FetchResponseItem[] = [];
    for (const item of items) {
      switch (item.type) {
        case 'UID':
          out.push({ name: 'UID', value: row.uid });
          break;
        case 'FLAGS':
          out.push({ name: 'FLAGS', flags: row.flags });
          break;
        case 'INTERNALDATE':
          out.push({ name: 'INTERNALDATE', value: dateToDateTime(row.internalDate, 0) });
          break;
        case 'RFC822.SIZE':
          out.push({ name: 'RFC822.SIZE', value: row.size });
          break;
        case 'MODSEQ':
          out.push({ name: 'MODSEQ', value: row.modseq });
          break;
        case 'ENVELOPE':
          if (root !== null) out.push({ name: 'ENVELOPE', envelope: envelopeOf(root.headers, ctx.utf8) });
          break;
        case 'BODY':
        case 'BODYSTRUCTURE':
          if (root !== null) out.push({ name: item.type, body: bodyStructureOf(root, ctx.utf8) });
          break;
        case 'RFC822':
          out.push({ name: 'RFC822', data: spanData(ctx.blobs, row.blobSha256, { kind: 'range', start: 0, end: row.size }, null) });
          break;
        case 'RFC822.HEADER':
          out.push({ name: 'RFC822.HEADER', data: spanData(ctx.blobs, row.blobSha256, sectionSpan(root, row.size, { part: [], text: 'HEADER', fields: [] }), null) });
          break;
        case 'RFC822.TEXT':
          out.push({ name: 'RFC822.TEXT', data: spanData(ctx.blobs, row.blobSha256, sectionSpan(root, row.size, { part: [], text: 'TEXT', fields: [] }), null) });
          break;
        case 'BODY[]':
          out.push({
            name: 'BODY[]',
            section: item.section,
            origin: item.partial === null ? null : item.partial.offset,
            data: spanData(ctx.blobs, row.blobSha256, sectionSpan(root, row.size, item.section), item.partial),
          });
          break;
        case 'BINARY[]':
          out.push({
            name: 'BINARY[]',
            part: item.part,
            origin: item.partial === null ? null : item.partial.offset,
            data: await binaryData(ctx, row, root, item.part, item.partial),
          });
          break;
        case 'BINARY.SIZE': {
          const node = item.part.length === 0 || root === null ? null : resolvePart(root, item.part);
          const size = item.part.length === 0 ? row.size : node === null ? 0 : await binarySize(ctx.blobs, row.blobSha256, node);
          out.push({ name: 'BINARY.SIZE', part: item.part, size });
          break;
        }
      }
    }
    if (seenSet.has(uid) && !includeFlags) out.push({ name: 'FLAGS', flags: row.flags });
    if (seenSet.has(uid) && ctx.condstore === true && !items.some((i) => i.type === 'MODSEQ')) out.push({ name: 'MODSEQ', value: row.modseq });
    if (includeFlags || seenSet.has(uid)) view.noteModseq(uid, row.modseq);
    await ctx.write(fetchResponse(seq, out, { utf8: ctx.utf8 }));
  }
  if (expungeIssued) return { status: 'OK', code: { type: 'EXPUNGEISSUED' }, text: 'Some messages were expunged by another session' };
  return { status: 'OK', code: null, text: 'FETCH completed' };
}
