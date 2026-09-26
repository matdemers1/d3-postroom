// Adapter from IMAP SEARCH's text criteria onto the same query AST and SQL builder the API uses
// (PST-REQ-080), so IMAP SEARCH and the API can never disagree about what a term matches. This
// package has no dependency on @postroom/imap-proto; the IMAP daemon translates its own parsed
// SEARCH keys into the small shape below before calling in.
import { Prisma } from '@postroom/db';
import type { QueryAst, QueryNode } from './ast.js';

/** The IMAP SEARCH keys this adapter understands (RFC 3501 §6.4.4): BODY, TEXT (BODY plus the
 * envelope), FROM, TO, CC, SUBJECT and HEADER. Anything else — flags, dates, sizes, sequence sets —
 * is the IMAP daemon's own concern and never reaches here. */
export type ImapTextKey = 'BODY' | 'TEXT' | 'FROM' | 'TO' | 'CC' | 'SUBJECT' | 'HEADER';

export interface ImapTextCriterion {
  key: ImapTextKey;
  value: string;
  /** Required, and only meaningful, when `key === 'HEADER'`: the header field name. */
  field?: string;
}

function likeContains(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `%${escaped}%`;
}

/** One IMAP text criterion as a SQL predicate over `message_search`/`message`, aliased `ms`/`m` —
 * the same aliases `buildSearchSql` uses, so this composes into the same query. */
export function imapTextCriteriaSql(key: ImapTextKey, value: string, field?: string): Prisma.Sql {
  switch (key) {
    case 'BODY':
      return Prisma.sql`ms.body_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'TEXT':
      return Prisma.sql`(ms.subject ILIKE ${likeContains(value)} ESCAPE '\\' OR ms.from_text ILIKE ${likeContains(value)} ESCAPE '\\' OR ms.to_text ILIKE ${likeContains(value)} ESCAPE '\\' OR ms.body_text ILIKE ${likeContains(value)} ESCAPE '\\')`;
    case 'FROM':
      return Prisma.sql`ms.from_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'TO':
    case 'CC':
      return Prisma.sql`ms.to_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'SUBJECT':
      return Prisma.sql`ms.subject ILIKE ${likeContains(value)} ESCAPE '\\'`;
    case 'HEADER': {
      const f = (field ?? '').trim().toLowerCase();
      if (f === 'subject') return Prisma.sql`ms.subject ILIKE ${likeContains(value)} ESCAPE '\\'`;
      if (f === 'from') return Prisma.sql`ms.from_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
      if (f === 'to' || f === 'cc') return Prisma.sql`ms.to_text ILIKE ${likeContains(value)} ESCAPE '\\'`;
      // A header we don't index (message_search has no raw header store): match nothing rather
      // than silently widen the result set to "everything".
      return Prisma.sql`FALSE`;
    }
  }
}

function criterionToNode(c: ImapTextCriterion): QueryNode {
  switch (c.key) {
    case 'FROM':
      return { type: 'op', op: 'from', value: c.value };
    case 'TO':
      return { type: 'op', op: 'to', value: c.value };
    case 'CC':
      return { type: 'op', op: 'cc', value: c.value };
    case 'SUBJECT':
      return { type: 'op', op: 'subject', value: c.value };
    case 'BODY':
      return { type: 'op', op: 'body', value: c.value };
    case 'TEXT':
      return { type: 'word', value: c.value };
    case 'HEADER': {
      const f = (c.field ?? '').trim().toLowerCase();
      if (f === 'subject') return { type: 'op', op: 'subject', value: c.value };
      if (f === 'from') return { type: 'op', op: 'from', value: c.value };
      if (f === 'to' || f === 'cc') return { type: 'op', op: 'to', value: c.value };
      // Unindexed header: the empty OR is false, so this criterion can never match — and can
      // never widen the search either.
      return { type: 'or', nodes: [] };
    }
  }
}

/** Map a list of IMAP SEARCH text criteria (implicitly ANDed, as SEARCH's top level always is) onto
 * a `QueryAst` that `buildSearchSql`/`searchMessages` can run directly. */
export function imapSearchToAst(criteria: readonly ImapTextCriterion[]): QueryAst {
  if (criteria.length === 0) return { root: null };
  const nodes = criteria.map(criterionToNode);
  const [only] = nodes;
  return { root: nodes.length === 1 && only !== undefined ? only : { type: 'and', nodes } };
}
