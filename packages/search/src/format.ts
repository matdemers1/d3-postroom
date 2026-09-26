// Render a QueryAst back to Gmail-like query syntax, the inverse of parseQuery. Used to prove the
// parser round-trips (fast-check: parse(format(ast)) is equivalent to ast) and for echoing a
// normalised query back to a caller.
import type { LeafNode, QueryAst, QueryNode } from './ast.js';

function needsQuoting(value: string): boolean {
  // Conservative: anything that could be re-lexed as a keyword, a group, or another operator's
  // key gets quoted. Over-quoting is harmless for round-tripping; under-quoting is not.
  return value.length === 0 || /[\s()":]/.test(value) || value === 'OR' || value.startsWith('-');
}

function formatWord(value: string): string {
  return needsQuoting(value) ? `"${value.replace(/"/g, '')}"` : value;
}

function formatLeaf(node: LeafNode): string {
  switch (node.type) {
    case 'word':
      return formatWord(node.value);
    case 'phrase':
      return `"${node.value.replace(/"/g, '')}"`;
    case 'op':
      return `${node.op}:${formatWord(node.value)}`;
  }
}

/** Format `node` as it would appear inside an AND list (space-separated). */
function formatAndChild(node: QueryNode): string {
  if (node.type === 'or') return `(${formatOr(node)})`;
  return formatNode(node);
}

/** Format `node` as it would appear inside an OR list (` OR `-separated). */
function formatOrChild(node: QueryNode): string {
  return formatNode(node);
}

function formatAnd(node: { type: 'and'; nodes: QueryNode[] }): string {
  return node.nodes.map(formatAndChild).join(' ');
}

function formatOr(node: { type: 'or'; nodes: QueryNode[] }): string {
  return node.nodes.map(formatOrChild).join(' OR ');
}

function formatNode(node: QueryNode): string {
  switch (node.type) {
    case 'word':
    case 'phrase':
    case 'op':
      return formatLeaf(node);
    case 'not':
      return `-${formatLeaf(node.node)}`;
    case 'and':
      return formatAnd(node);
    case 'or':
      return formatOr(node);
  }
}

/** Render `ast` back to query text. `parseQuery(formatQuery(ast))` is equivalent to `ast`. */
export function formatQuery(ast: QueryAst): string {
  return ast.root === null ? '' : formatNode(ast.root);
}
