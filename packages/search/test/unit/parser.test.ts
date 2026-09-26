// Proves parseQuery never throws, and that parse(format(ast)) round-trips (PST-T-3.7).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OPERATOR_NAMES, type LeafNode, type QueryNode } from '../../src/ast.js';
import { formatQuery } from '../../src/format.js';
import { parseQuery } from '../../src/parser.js';

// A restricted alphabet that never introduces its own ambiguity (quotes, colons, parens, "-"
// prefixes, or the literal word "OR"), so the round-trip property can assert exact structural
// equality without a canonicalization step for these leaves.
const safeWord = fc.stringMatching(/^[a-zA-Z0-9]+$/).filter((s) => s.length > 0 && s !== 'OR');
const safePhrase = fc.stringMatching(/^[a-zA-Z0-9 ]+$/).filter((s) => s.trim().length > 0);
const nonBodyOperator = fc.constantFrom(...OPERATOR_NAMES.filter((o) => o !== 'body'));

const leafArb: fc.Arbitrary<LeafNode> = fc.oneof(
  safeWord.map((value): LeafNode => ({ type: 'word', value })),
  safePhrase.map((value): LeafNode => ({ type: 'phrase', value })),
  fc.tuple(nonBodyOperator, safeWord).map(([op, value]): LeafNode => ({ type: 'op', op, value })),
);

/** Leaves and NOT-of-leaf: what the parser can actually produce for a single atom. */
const atomArb: fc.Arbitrary<QueryNode> = fc.oneof(leafArb, leafArb.map((node): QueryNode => ({ type: 'not', node })));

// AND of atoms, and OR of (AND of atoms) — the two flat shapes the grammar actually distinguishes.
// `formatQuery` composes these correctly for round-tripping; deeper nesting is exercised in the
// "does not throw" property below via raw strings instead.
const andArb: fc.Arbitrary<QueryNode> = fc.array(atomArb, { minLength: 1, maxLength: 4 }).map((nodes) => (nodes.length === 1 ? (nodes[0] as QueryNode) : { type: 'and', nodes }));
const astArb: fc.Arbitrary<QueryNode | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: andArb },
  { weight: 3, arbitrary: fc.array(andArb, { minLength: 2, maxLength: 3 }).map((nodes): QueryNode => ({ type: 'or', nodes })) },
);

describe('parseQuery', () => {
  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => parseQuery(input)).not.toThrow();
      }),
    );
  });

  it('never throws on adversarial operator-shaped input', () => {
    const pieces = fc.constantFrom('(', ')', '"', '-', 'OR', ':', 'from:', 'is:unread', '  ', '\n');
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 20 }), (parts) => {
        expect(() => parseQuery(parts.join(''))).not.toThrow();
      }),
    );
  });

  it('parse(format(ast)) round-trips for generated ASTs', () => {
    fc.assert(
      fc.property(astArb, (root) => {
        const formatted = formatQuery({ root });
        const reparsed = parseQuery(formatted);
        expect(reparsed.ast.root).toEqual(root);
      }),
    );
  });

  it('parses a bare word', () => {
    expect(parseQuery('hello').ast.root).toEqual({ type: 'word', value: 'hello' });
  });

  it('parses multiple bare words as AND', () => {
    expect(parseQuery('hello world').ast.root).toEqual({
      type: 'and',
      nodes: [
        { type: 'word', value: 'hello' },
        { type: 'word', value: 'world' },
      ],
    });
  });

  it('parses a quoted phrase', () => {
    expect(parseQuery('"hello world"').ast.root).toEqual({ type: 'phrase', value: 'hello world' });
  });

  it('parses OR', () => {
    expect(parseQuery('foo OR bar').ast.root).toEqual({
      type: 'or',
      nodes: [
        { type: 'word', value: 'foo' },
        { type: 'word', value: 'bar' },
      ],
    });
  });

  it('parses -negation', () => {
    expect(parseQuery('-foo').ast.root).toEqual({ type: 'not', node: { type: 'word', value: 'foo' } });
  });

  it('parses an operator', () => {
    expect(parseQuery('from:alice@example.com').ast.root).toEqual({ type: 'op', op: 'from', value: 'alice@example.com' });
  });

  it('parses a quoted operator value', () => {
    expect(parseQuery('subject:"hello world"').ast.root).toEqual({ type: 'op', op: 'subject', value: 'hello world' });
  });

  it('parses parenthesised groups', () => {
    expect(parseQuery('foo (bar OR baz)').ast.root).toEqual({
      type: 'and',
      nodes: [
        { type: 'word', value: 'foo' },
        { type: 'or', nodes: [{ type: 'word', value: 'bar' }, { type: 'word', value: 'baz' }] },
      ],
    });
  });

  it('degrades an unknown operator name to a plain word rather than throwing', () => {
    const { ast, warnings } = parseQuery('bogus:value');
    expect(ast.root).toEqual({ type: 'word', value: 'bogus:value' });
    expect(warnings).toEqual([]);
  });

  it('warns on but tolerates an unterminated quote', () => {
    const { ast, warnings } = parseQuery('"unterminated');
    expect(ast.root).toEqual({ type: 'phrase', value: 'unterminated' });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns on but tolerates an unbalanced parenthesis', () => {
    const { ast, warnings } = parseQuery('(foo bar');
    expect(ast.root).toEqual({
      type: 'and',
      nodes: [
        { type: 'word', value: 'foo' },
        { type: 'word', value: 'bar' },
      ],
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns on a dangling OR rather than throwing', () => {
    const { ast, warnings } = parseQuery('foo OR');
    expect(ast.root).toEqual({ type: 'word', value: 'foo' });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('parses an empty query to a null root', () => {
    expect(parseQuery('').ast.root).toBeNull();
    expect(parseQuery('   ').ast.root).toBeNull();
  });

  it('tolerates a stray closing parenthesis', () => {
    expect(() => parseQuery('foo)')).not.toThrow();
  });
});
