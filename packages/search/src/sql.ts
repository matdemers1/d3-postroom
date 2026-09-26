// Builds the SQL for a parsed query over `message_search` (joined to `message` and `mailbox`),
// shared by the REST search endpoint and IMAP SEARCH (PST-T-3.7). Every user-supplied value flows
// through `Prisma.sql` template parameters — never string interpolation — so quotes, backslashes
// and ILIKE wildcards in a search term can only ever narrow or leave a query, never widen or break
// it.
import { Prisma, type Db } from '@postroom/db';
import type { LeafNode, OperatorName, QueryAst, QueryNode } from './ast.js';

/** Escape `%`, `_` and `\` so a value used inside `ILIKE '%...%'` matches literally. */
function likeContains(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `%${escaped}%`;
}

const SPECIAL_USES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'rejects']);

interface ParsedSize {
  bytes: number;
}

function parseSize(value: string): ParsedSize | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([bBkKmMgG]?)$/.exec(value.trim());
  if (m === null) return undefined;
  const num = Number.parseFloat(m[1] ?? '');
  if (Number.isNaN(num)) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return { bytes: Math.round(num * mult) };
}

/** Parse `YYYY-MM-DD`, `YYYY/MM/DD` or a relative `Nd`/`Nw` offset into a UTC midnight Date. */
export function parseDateValue(value: string, now: Date = new Date()): Date | undefined {
  const trimmed = value.trim();
  const abs = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(trimmed);
  if (abs !== null) {
    const y = Number(abs[1]);
    const mo = Number(abs[2]);
    const d = Number(abs[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
    return dt;
  }
  const rel = /^(\d+)\s*([dw])$/i.exec(trimmed);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? '').toLowerCase();
    const days = unit === 'w' ? n * 7 : n;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - days);
    return start;
  }
  return undefined;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function opPredicate(op: OperatorName, value: string): Prisma.Sql {
  switch (op) {
    case 'from':
      return Prisma.sql`ms.from_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'to':
    case 'cc':
      return Prisma.sql`ms.to_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'subject':
      return Prisma.sql`ms.subject ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'filename':
      return Prisma.sql`ms.attachment_names ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'body':
      return Prisma.sql`ms.body_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'has':
      return value.trim().toLowerCase() === 'attachment' ? Prisma.sql`ms.has_attachment = true` : Prisma.sql`TRUE`;
    case 'is': {
      const v = value.trim().toLowerCase();
      if (v === 'unread') return Prisma.sql`NOT (m.flags @> ARRAY['\\Seen']::text[])`;
      if (v === 'read') return Prisma.sql`m.flags @> ARRAY['\\Seen']::text[]`;
      if (v === 'flagged' || v === 'starred') return Prisma.sql`m.flags @> ARRAY['\\Flagged']::text[]`;
      return Prisma.sql`TRUE`;
    }
    case 'in': {
      const v = value.trim().toLowerCase();
      if (v === 'anywhere' || v.length === 0) return Prisma.sql`TRUE`;
      if (SPECIAL_USES.has(v)) return Prisma.sql`mb.special_use = ${v}::special_use`;
      return Prisma.sql`lower(mb.name) = lower(${value})`;
    }
    case 'before': {
      const date = parseDateValue(value);
      return date === undefined ? Prisma.sql`TRUE` : Prisma.sql`m.internal_date < ${date}`;
    }
    case 'after': {
      const date = parseDateValue(value);
      return date === undefined ? Prisma.sql`TRUE` : Prisma.sql`m.internal_date >= ${addDays(date, 1)}`;
    }
    case 'larger': {
      const size = parseSize(value);
      return size === undefined ? Prisma.sql`TRUE` : Prisma.sql`m.size > ${size.bytes}`;
    }
    case 'smaller': {
      const size = parseSize(value);
      return size === undefined ? Prisma.sql`TRUE` : Prisma.sql`m.size < ${size.bytes}`;
    }
  }
}

function leafPredicate(node: LeafNode): Prisma.Sql {
  switch (node.type) {
    case 'word':
      return Prisma.sql`(ms.tsv @@ plainto_tsquery('simple', ${node.value}) OR ms.subject ILIKE ${likeContains(node.value)} ESCAPE '\\' OR ms.body_text ILIKE ${likeContains(node.value)} ESCAPE '\\' OR ms.from_text ILIKE ${likeContains(node.value)} ESCAPE '\\')`;
    case 'phrase':
      return Prisma.sql`(ms.tsv @@ phraseto_tsquery('simple', ${node.value}) OR ms.body_text ILIKE ${likeContains(node.value)} ESCAPE '\\' OR ms.subject ILIKE ${likeContains(node.value)} ESCAPE '\\')`;
    case 'op':
      return opPredicate(node.op, node.value);
  }
}

function nodePredicate(node: QueryNode): Prisma.Sql {
  switch (node.type) {
    case 'word':
    case 'phrase':
    case 'op':
      return leafPredicate(node);
    case 'not':
      return Prisma.sql`NOT (${leafPredicate(node.node)})`;
    case 'and':
      return node.nodes.length === 0 ? Prisma.sql`TRUE` : Prisma.join(node.nodes.map(nodePredicate), ' AND ', '(', ')');
    case 'or':
      // The empty disjunction is false (the mathematically correct identity), used by callers as a
      // "never matches" leaf — e.g. an IMAP HEADER field this schema doesn't index.
      return node.nodes.length === 0 ? Prisma.sql`FALSE` : Prisma.join(node.nodes.map(nodePredicate), ' OR ', '(', ')');
  }
}

/** Collect the free-text (word/phrase) terms in `node`, ignoring negated ones, for ranking. */
function rankTerms(node: QueryNode, out: string[]): void {
  switch (node.type) {
    case 'word':
    case 'phrase':
      out.push(node.value);
      return;
    case 'op':
      return;
    case 'not':
      return;
    case 'and':
    case 'or':
      for (const n of node.nodes) rankTerms(n, out);
  }
}

export interface SearchOptions {
  accountId: string;
  mailboxId?: string;
  limit?: number;
  /** Opaque keyset cursor: an ISO timestamp of the last row's internal_date, older rows only. */
  cursor?: string;
}

export interface SearchRow {
  messageId: string;
  mailboxId: string;
  uid: number;
  subject: string | null;
  internalDate: Date;
  rank: number;
  snippet: string;
}

/** Build the parameterised SQL for `ast` against `opts`. Exported so IMAP SEARCH and the API share
 * one code path (PST-REQ-080). */
export function buildSearchSql(ast: QueryAst, opts: SearchOptions): Prisma.Sql {
  const limit = opts.limit ?? 50;
  const terms: string[] = [];
  if (ast.root !== null) rankTerms(ast.root, terms);
  const rankQuery = terms.join(' ');

  const conditions: Prisma.Sql[] = [Prisma.sql`ms.account_id = ${opts.accountId}`];
  if (opts.mailboxId !== undefined) conditions.push(Prisma.sql`m.mailbox_id = ${opts.mailboxId}`);
  if (ast.root !== null) conditions.push(nodePredicate(ast.root));
  if (opts.cursor !== undefined) conditions.push(Prisma.sql`m.internal_date < ${new Date(opts.cursor)}`);

  const rankExpr = rankQuery.length > 0 ? Prisma.sql`ts_rank_cd(ms.tsv, plainto_tsquery('simple', ${rankQuery}))` : Prisma.sql`0`;

  return Prisma.sql`
    SELECT
      m.id AS "messageId",
      m.mailbox_id AS "mailboxId",
      m.uid AS "uid",
      m.subject AS "subject",
      m.internal_date AS "internalDate",
      ${rankExpr}::float8 AS "rank",
      ts_headline('simple', left(ms.body_text, 4000), plainto_tsquery('simple', ${rankQuery}), 'MaxFragments=1, MaxWords=25, MinWords=5') AS "snippet"
    FROM message_search ms
    JOIN message m ON m.id = ms.message_id
    JOIN mailbox mb ON mb.id = m.mailbox_id
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY "rank" DESC, m.internal_date DESC, m.id DESC
    LIMIT ${limit}
  `;
}

/** Run a query for one account. Shared by the REST search endpoint. */
export async function searchMessages(db: Db, ast: QueryAst, opts: SearchOptions): Promise<SearchRow[]> {
  const sql = buildSearchSql(ast, opts);
  return db.$queryRaw<SearchRow[]>(sql);
}
