// The query AST shared by the parser, the formatter, the SQL builder and the IMAP SEARCH adapter.

/** Operators recognised after a colon, e.g. `from:alice@example.com`. */
export const OPERATOR_NAMES = [
  'from',
  'to',
  'cc',
  'subject',
  'has',
  'in',
  'before',
  'after',
  'is',
  'larger',
  'smaller',
  'filename',
  // Mainly for imapSearchToAst (IMAP's BODY key: a body-only match, unlike a bare word which also
  // matches subject and from), but a bare `body:` query text also works since it's just another
  // operator name here.
  'body',
] as const;

export type OperatorName = (typeof OPERATOR_NAMES)[number];

export function isOperatorName(key: string): key is OperatorName {
  return (OPERATOR_NAMES as readonly string[]).includes(key.toLowerCase());
}

export type LeafNode =
  | { type: 'word'; value: string }
  | { type: 'phrase'; value: string }
  | { type: 'op'; op: OperatorName; value: string };

export type QueryNode = LeafNode | { type: 'not'; node: LeafNode } | { type: 'and'; nodes: QueryNode[] } | { type: 'or'; nodes: QueryNode[] };

/** The parsed query. `root === null` means an empty (or whitespace-only) query. */
export interface QueryAst {
  root: QueryNode | null;
}

export interface ParseResult {
  ast: QueryAst;
  warnings: string[];
}
