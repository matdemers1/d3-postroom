// Gmail-like query syntax: bare words (AND), "quoted phrases", OR between terms, -negation,
// parentheses, and operators (from:, to:, cc:, subject:, has:, in:, before:, after:, is:, larger:,
// smaller:, filename:). Never throws — anything it can't make sense of becomes a plain word, with a
// warning recorded rather than surfaced as an error (PST-REQ-080).
import { isOperatorName, type LeafNode, type OperatorName, type ParseResult, type QueryNode } from './ast.js';

function isWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

interface State {
  readonly s: string;
  i: number;
  readonly warnings: string[];
}

function skipWs(st: State): void {
  while (st.i < st.s.length && isWs(st.s[st.i])) st.i++;
}

function atEnd(st: State): boolean {
  return st.i >= st.s.length;
}

/** True if `OR` (as a whole word) starts at the current position; consumes it if so. */
function tryConsumeOr(st: State): boolean {
  if (st.s[st.i] === 'O' && st.s[st.i + 1] === 'R' && (st.i + 2 >= st.s.length || isWs(st.s[st.i + 2]) || st.s[st.i + 2] === ')')) {
    st.i += 2;
    return true;
  }
  return false;
}

function readQuoted(st: State): string {
  // st.s[st.i] === '"'
  st.i++;
  let value = '';
  while (!atEnd(st) && st.s[st.i] !== '"') {
    value += st.s.charAt(st.i);
    st.i++;
  }
  if (st.s[st.i] === '"') st.i++;
  else st.warnings.push('unterminated quoted phrase');
  return value;
}

function readBareToken(st: State, stopAtColon: boolean): string {
  let value = '';
  while (!atEnd(st) && !isWs(st.s[st.i]) && st.s[st.i] !== '(' && st.s[st.i] !== ')') {
    if (stopAtColon && st.s[st.i] === ':') break;
    value += st.s.charAt(st.i);
    st.i++;
  }
  return value;
}

function parseLeafOrGroup(st: State): QueryNode | null {
  skipWs(st);
  if (atEnd(st) || st.s[st.i] === ')') return null;

  let negate = false;
  if (st.s[st.i] === '-' && !isWs(st.s[st.i + 1]) && st.s[st.i + 1] !== undefined) {
    negate = true;
    st.i++;
  }

  let node: QueryNode | undefined;

  if (st.s[st.i] === '(') {
    st.i++;
    const inner = parseOr(st);
    skipWs(st);
    if (st.s[st.i] === ')') st.i++;
    else st.warnings.push('unbalanced parenthesis');
    node = inner ?? { type: 'and', nodes: [] };
  } else if (st.s[st.i] === '"') {
    node = { type: 'phrase', value: readQuoted(st) };
  } else {
    const key = readBareToken(st, true);
    if (!atEnd(st) && st.s[st.i] === ':' && key.length > 0 && isOperatorName(key)) {
      st.i++;
      let value: string;
      if (st.s[st.i] === '"') value = readQuoted(st);
      else value = readBareToken(st, false);
      node = { type: 'op', op: key.toLowerCase() as OperatorName, value };
    } else if (!atEnd(st) && st.s[st.i] === ':') {
      // Not a known operator: keep reading as a plain word, colon and all.
      st.i++;
      const rest = readBareToken(st, false);
      node = { type: 'word', value: key + ':' + rest };
    } else {
      node = { type: 'word', value: key };
    }
  }

  if (negate) {
    if (node.type === 'and' || node.type === 'or') {
      // Negating a group isn't meaningful in this grammar; drop the negation rather than throw.
      st.warnings.push('negated group is not supported; ignoring the negation');
    } else {
      node = { type: 'not', node: node as LeafNode };
    }
  }

  return node;
}

function parseAnd(st: State): QueryNode | null {
  const nodes: QueryNode[] = [];
  for (;;) {
    skipWs(st);
    if (atEnd(st) || st.s[st.i] === ')') break;
    const save = st.i;
    if (tryConsumeOr(st)) {
      st.i = save;
      break;
    }
    const node = parseLeafOrGroup(st);
    if (node === null) break;
    nodes.push(node);
  }
  if (nodes.length === 0) return null;
  const [only] = nodes;
  return nodes.length === 1 && only !== undefined ? only : { type: 'and', nodes };
}

function parseOr(st: State): QueryNode | null {
  const nodes: QueryNode[] = [];
  const first = parseAnd(st);
  if (first !== null) nodes.push(first);
  for (;;) {
    skipWs(st);
    const save = st.i;
    if (!tryConsumeOr(st)) {
      st.i = save;
      break;
    }
    const next = parseAnd(st);
    if (next !== null) nodes.push(next);
    else st.warnings.push('dangling OR with no right-hand term');
  }
  if (nodes.length === 0) return null;
  const [only] = nodes;
  return nodes.length === 1 && only !== undefined ? only : { type: 'or', nodes };
}

/** Parse a Gmail-like search query. Never throws; invalid syntax degrades to plain words. */
export function parseQuery(q: string): ParseResult {
  const st: State = { s: q, i: 0, warnings: [] };
  const root = parseOr(st);
  skipWs(st);
  if (!atEnd(st)) {
    // Anything left over (e.g. a stray ")") becomes a trailing word rather than being lost.
    st.warnings.push('unexpected trailing input');
    const rest = q.slice(st.i);
    const extra: QueryNode = { type: 'word', value: rest };
    const merged: QueryNode | null = root === null ? extra : root.type === 'and' ? { type: 'and', nodes: [...root.nodes, extra] } : { type: 'and', nodes: [root, extra] };
    return { ast: { root: merged }, warnings: st.warnings };
  }
  return { ast: { root }, warnings: st.warnings };
}
