// The syntax tree the parser produces (RFC 5228 §8.2): commands with arguments, an optional test or
// test-list, and an optional block. It is purely syntactic — `compile` gives it meaning.

import type { SourcePos } from './errors.js';

export type Argument =
  | { readonly type: 'tag'; readonly name: string; readonly pos: SourcePos }
  | { readonly type: 'number'; readonly value: number; readonly pos: SourcePos }
  /** A single string (quoted or `text:`). */
  | { readonly type: 'string'; readonly value: string; readonly multiline: boolean; readonly pos: SourcePos }
  /** A bracketed string list, `["a", "b"]`. */
  | { readonly type: 'list'; readonly values: readonly string[]; readonly pos: SourcePos };

export interface TestNode {
  readonly type: 'test';
  /** Lowercased identifier. */
  readonly name: string;
  readonly args: readonly Argument[];
  /** Nested tests: one for `not`, a parenthesised list for `anyof`/`allof`. */
  readonly tests: readonly TestNode[];
  /** True when the nested tests were written as a parenthesised test-list. */
  readonly testList: boolean;
  readonly pos: SourcePos;
}

export interface CommandNode {
  readonly type: 'command';
  /** Lowercased identifier. */
  readonly name: string;
  readonly args: readonly Argument[];
  readonly tests: readonly TestNode[];
  readonly testList: boolean;
  /** The `{ … }` block, or null when the command ended with `;`. */
  readonly block: readonly CommandNode[] | null;
  readonly pos: SourcePos;
}

export interface ScriptNode {
  readonly type: 'script';
  readonly commands: readonly CommandNode[];
}
