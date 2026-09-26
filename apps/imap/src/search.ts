// SEARCH and UID SEARCH (RFC 9051 §6.4.4, PST-REQ-070).
//
// Keys that are columns — sequence sets, UIDs, flags, keywords, dates, sizes, MODSEQ — compile to
// SQL. Keys that need the message's text — FROM, TO, CC, BCC, SUBJECT, HEADER, BODY, TEXT — are
// evaluated here, per candidate message:
//   - header keys against the message's own header fields (decoded: RFC 2047 words and display
//     names), read from the structure cache;
//   - BODY and TEXT against message_search.body_text when the worker has indexed the message
//     (PST-T-3.13 populates it; nothing does yet), otherwise by decoding the message's text parts
//     (transfer encoding and charset), up to BODY_SCAN_LIMIT characters per message.
// The top-level criteria are an implicit AND: the column keys filter in SQL first, so text is only
// read for messages that can still match.
//
// Dates compare in UTC, disregarding time (the server's zone is UTC). SENT* uses the Date header as
// filed (message.sent_at) and falls back to the internal date when it had none.
// \Recent is always empty (see flags.ts): RECENT and NEW match nothing, OLD matches everything.
import type { ImapDate, SearchKey, SequenceSet } from '@postroom/imap-proto';
import { decodeBytes, decodeEncodedWords, type HeaderList } from '@postroom/mime';
import { Prisma } from '@postroom/db';
import { decodedBody, type BlobReader, type StructureCache } from './content.js';
import { hasFlag } from './flags.js';
import type { MimeNode } from './structure.js';
import type { MailStore } from './store.js';
import type { MailboxView } from './view.js';

export const BODY_SCAN_LIMIT = 1024 * 1024;

export interface SearchContext {
  readonly store: MailStore;
  readonly structures: StructureCache;
  readonly blobs: BlobReader;
  readonly view: MailboxView;
  /** SEARCHRES `$`, as UIDs. */
  readonly saved: readonly number[] | null;
}

interface Candidate {
  id: string;
  uid: number;
  flags: string[];
  size: number;
  internal_date: Date;
  sent_at: Date | null;
  modseq: bigint;
  blob_sha256: string;
}

const TEXT_KEYS = new Set(['FROM', 'TO', 'CC', 'BCC', 'SUBJECT', 'HEADER', 'BODY', 'TEXT']);

function needsText(key: SearchKey): boolean {
  if (TEXT_KEYS.has(key.type)) return true;
  if (key.type === 'NOT') return needsText(key.key);
  if (key.type === 'OR') return needsText(key.left) || needsText(key.right);
  if (key.type === 'AND') return key.keys.some(needsText);
  return false;
}

function isoDate(d: ImapDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function utcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayOf(d: ImapDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

/** UIDs the key's sequence set names, among the messages the client has been told about. */
function setUids(ctx: SearchContext, set: SequenceSet, uid: boolean): number[] {
  const pairs = uid ? ctx.view.resolveUids(set, ctx.saved) : ctx.view.resolveSeqs(set, ctx.saved);
  return pairs.map(([, u]) => u);
}

const FLAG_KEYS: Record<string, [string, boolean]> = {
  ANSWERED: ['\\Answered', true],
  DELETED: ['\\Deleted', true],
  DRAFT: ['\\Draft', true],
  FLAGGED: ['\\Flagged', true],
  SEEN: ['\\Seen', true],
  UNANSWERED: ['\\Answered', false],
  UNDELETED: ['\\Deleted', false],
  UNDRAFT: ['\\Draft', false],
  UNFLAGGED: ['\\Flagged', false],
  UNSEEN: ['\\Seen', false],
};

/** SQL for a key without text keys. */
function compile(ctx: SearchContext, key: SearchKey): Prisma.Sql {
  const flag = FLAG_KEYS[key.type];
  if (flag !== undefined) {
    const [name, want] = flag;
    return want ? Prisma.sql`(${name} = ANY(m.flags))` : Prisma.sql`(NOT (${name} = ANY(m.flags)))`;
  }
  switch (key.type) {
    case 'ALL':
    case 'OLD':
      return Prisma.sql`TRUE`;
    case 'NEW':
    case 'RECENT':
      return Prisma.sql`FALSE`;
    case 'KEYWORD':
    case 'UNKEYWORD': {
      const has = Prisma.sql`EXISTS (SELECT 1 FROM unnest(m.flags) AS f WHERE lower(f) = lower(${key.flag}))`;
      return key.type === 'KEYWORD' ? has : Prisma.sql`(NOT ${has})`;
    }
    case 'BEFORE':
      return Prisma.sql`((m.internal_date AT TIME ZONE 'UTC')::date < ${isoDate(key.date)}::date)`;
    case 'ON':
      return Prisma.sql`((m.internal_date AT TIME ZONE 'UTC')::date = ${isoDate(key.date)}::date)`;
    case 'SINCE':
      return Prisma.sql`((m.internal_date AT TIME ZONE 'UTC')::date >= ${isoDate(key.date)}::date)`;
    case 'SENTBEFORE':
      return Prisma.sql`((COALESCE(m.sent_at, m.internal_date) AT TIME ZONE 'UTC')::date < ${isoDate(key.date)}::date)`;
    case 'SENTON':
      return Prisma.sql`((COALESCE(m.sent_at, m.internal_date) AT TIME ZONE 'UTC')::date = ${isoDate(key.date)}::date)`;
    case 'SENTSINCE':
      return Prisma.sql`((COALESCE(m.sent_at, m.internal_date) AT TIME ZONE 'UTC')::date >= ${isoDate(key.date)}::date)`;
    case 'LARGER':
      return Prisma.sql`(m.size > ${key.size})`;
    case 'SMALLER':
      return Prisma.sql`(m.size < ${key.size})`;
    case 'MODSEQ':
      return Prisma.sql`(m.modseq >= ${key.modseq})`;
    case 'UID':
    case 'SEQ': {
      const uids = setUids(ctx, key.set, key.type === 'UID');
      return uids.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`(m.uid = ANY(${uids}::int[]))`;
    }
    case 'NOT':
      return Prisma.sql`(NOT ${compile(ctx, key.key)})`;
    case 'OR':
      return Prisma.sql`(${compile(ctx, key.left)} OR ${compile(ctx, key.right)})`;
    case 'AND':
      return key.keys.length === 0 ? Prisma.sql`TRUE` : Prisma.sql`(${Prisma.join(key.keys.map((k) => compile(ctx, k)), ' AND ')})`;
    default:
      throw new Error(`search key ${key.type} needs the message text`);
  }
}

/** Lazily-loaded text of one candidate. */
class MessageText {
  private headers: HeaderList | null = null;
  private root: MimeNode | null = null;
  private body: string | null = null;

  constructor(
    private readonly ctx: SearchContext,
    private readonly row: Candidate,
  ) {}

  private async structure(): Promise<MimeNode> {
    if (this.root === null) {
      const s = await this.ctx.structures.get(this.row.blob_sha256);
      this.root = s.root;
      this.headers = s.root.headers;
    }
    return this.root;
  }

  async header(name: string): Promise<string[]> {
    await this.structure();
    return (this.headers?.getAll(name) ?? []).map((v) => decodeEncodedWords(v));
  }

  async allHeaders(): Promise<string> {
    await this.structure();
    return (this.headers?.fields ?? []).map((f) => `${f.name}: ${decodeEncodedWords(f.value)}`).join('\n');
  }

  async bodyText(): Promise<string> {
    if (this.body !== null) return this.body;
    const indexed = await this.ctx.store.searchText(this.row.id);
    if (indexed !== null) {
      this.body = indexed.bodyText;
      return this.body;
    }
    const root = await this.structure();
    const parts: string[] = [];
    let budget = BODY_SCAN_LIMIT;
    const visit = async (node: MimeNode): Promise<void> => {
      if (budget <= 0) return;
      if (node.kind === 'multipart') {
        for (const c of node.children) await visit(c);
        return;
      }
      if (node.kind === 'message' && node.message !== null) {
        await visit(node.message);
        return;
      }
      if (node.contentType.type !== 'text') return;
      const bytes: Buffer[] = [];
      let n = 0;
      for await (const chunk of decodedBody(this.ctx.blobs, this.row.blob_sha256, node)) {
        bytes.push(Buffer.from(chunk));
        n += chunk.length;
        if (n >= budget * 4) break;
      }
      const text = decodeBytes(Buffer.concat(bytes), node.contentType.params['charset'] ?? null).text.slice(0, budget);
      budget -= text.length;
      parts.push(text);
    };
    await visit(root);
    this.body = parts.join('\n');
    return this.body;
  }
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

async function evaluate(ctx: SearchContext, key: SearchKey, row: Candidate, text: MessageText): Promise<boolean> {
  const flag = FLAG_KEYS[key.type];
  if (flag !== undefined) return hasFlag(row.flags, flag[0]) === flag[1];
  switch (key.type) {
    case 'ALL':
    case 'OLD':
      return true;
    case 'NEW':
    case 'RECENT':
      return false;
    case 'KEYWORD':
      return hasFlag(row.flags, key.flag);
    case 'UNKEYWORD':
      return !hasFlag(row.flags, key.flag);
    case 'BEFORE':
      return utcDay(row.internal_date) < dayOf(key.date);
    case 'ON':
      return utcDay(row.internal_date) === dayOf(key.date);
    case 'SINCE':
      return utcDay(row.internal_date) >= dayOf(key.date);
    case 'SENTBEFORE':
      return utcDay(row.sent_at ?? row.internal_date) < dayOf(key.date);
    case 'SENTON':
      return utcDay(row.sent_at ?? row.internal_date) === dayOf(key.date);
    case 'SENTSINCE':
      return utcDay(row.sent_at ?? row.internal_date) >= dayOf(key.date);
    case 'LARGER':
      return row.size > key.size;
    case 'SMALLER':
      return row.size < key.size;
    case 'MODSEQ':
      return row.modseq >= key.modseq;
    case 'UID':
    case 'SEQ':
      return setUids(ctx, key.set, key.type === 'UID').includes(row.uid);
    case 'NOT':
      return !(await evaluate(ctx, key.key, row, text));
    case 'OR':
      return (await evaluate(ctx, key.left, row, text)) || evaluate(ctx, key.right, row, text);
    case 'AND':
      for (const k of key.keys) if (!(await evaluate(ctx, k, row, text))) return false;
      return true;
    case 'FROM':
    case 'TO':
    case 'CC':
    case 'BCC':
    case 'SUBJECT':
      return (await text.header(key.type)).some((v) => contains(v, key.value));
    case 'HEADER': {
      const values = await text.header(key.field);
      return key.value === '' ? values.length > 0 : values.some((v) => contains(v, key.value));
    }
    case 'BODY':
      return contains(await text.bodyText(), key.value);
    case 'TEXT':
      return contains(await text.allHeaders(), key.value) || contains(await text.bodyText(), key.value);
    default:
      // The flag keys, answered from FLAG_KEYS above.
      return false;
  }
}

/** The UIDs matching `criteria` (an implicit AND), ascending. */
export async function search(ctx: SearchContext, criteria: readonly SearchKey[]): Promise<number[]> {
  const inSql = criteria.filter((k) => !needsText(k));
  const inJs = criteria.filter(needsText);
  const where = inSql.length === 0 ? Prisma.sql`TRUE` : Prisma.join(inSql.map((k) => compile(ctx, k)), ' AND ');
  // Only messages the client has been told about: a newer one has no sequence number yet.
  const rows = await ctx.store.db.$queryRaw<Candidate[]>`
    SELECT m.id::text AS id, m.uid, m.flags, m.size, m.internal_date, m.sent_at, m.modseq, m.blob_sha256
    FROM message AS m
    WHERE m.mailbox_id = ${ctx.view.mailboxId}::uuid AND m.uid <= ${ctx.view.maxUid} AND ${where}
    ORDER BY m.uid`;
  const out: number[] = [];
  for (const row of rows) {
    if (ctx.view.isExpunged(row.uid)) continue;
    if (inJs.length > 0) {
      const text = new MessageText(ctx, { ...row, modseq: row.modseq });
      let ok = true;
      for (const k of inJs) {
        if (!(await evaluate(ctx, k, { ...row, modseq: row.modseq }, text))) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    out.push(row.uid);
  }
  return out;
}
