// Canonical printer: turns a syntax tree back into a script that parses to the same tree (the
// property test asserts `parse(print(ast))` equals `ast` apart from positions). Every string is
// printed quoted — a quoted string can carry any content a `text:` string can, line breaks included,
// so the round trip is exact.

import type { Argument, CommandNode, ScriptNode, TestNode } from './ast.js';

export function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function arg(a: Argument): string {
  switch (a.type) {
    case 'tag':
      return `:${a.name}`;
    case 'number':
      return String(a.value);
    case 'string':
      return quote(a.value);
    case 'list':
      return `[${a.values.map(quote).join(', ')}]`;
  }
}

function head(name: string, args: readonly Argument[], tests: readonly TestNode[], testList: boolean): string {
  const parts = [name, ...args.map(arg)];
  if (testList) parts.push(`(${tests.map(test).join(', ')})`);
  else if (tests.length > 0) parts.push(...tests.map(test));
  return parts.join(' ');
}

function test(t: TestNode): string {
  return head(t.name, t.args, t.tests, t.testList);
}

function command(c: CommandNode, indent: string): string {
  const line = indent + head(c.name, c.args, c.tests, c.testList);
  if (c.block === null) return `${line};\n`;
  const inner = c.block.map((b) => command(b, `${indent}  `)).join('');
  return `${line} {\n${inner}${indent}}\n`;
}

export function print(script: ScriptNode): string {
  return script.commands.map((c) => command(c, '')).join('');
}
