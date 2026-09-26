// Validation: turns the syntax tree into a typed program, rejecting at compile time everything RFC
// 5228 says is an error before a single message is seen — unknown commands and tests, extensions
// used without `require`, `require` of something unsupported, `require` after other commands,
// `elsif`/`else` without an `if`, wrong argument shapes, unknown or duplicated tags, unknown
// comparators, and literal values that can never be valid (a header name with a colon in it, an
// envelope part other than "from"/"to", a variable name that is not an identifier).
//
// Strings stay raw here: when "variables" is required, `${…}` expansion happens at run time, and
// literal checks are skipped for any string that contains a reference.

import type { Argument, CommandNode, ScriptNode, TestNode } from './ast.js';
import { SieveSyntaxError, type SourcePos } from './errors.js';
import type { Comparator, MatchType } from './match.js';

/** Capabilities `require` accepts. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  'fileinto',
  'envelope',
  'imap4flags',
  'variables',
  'body',
  'vacation',
  'mailbox',
  'vnd.postroom.bucket',
  'comparator-i;octet',
  'comparator-i;ascii-casemap',
];

const COMPARATORS: ReadonlySet<string> = new Set(['i;octet', 'i;ascii-casemap']);
const ENVELOPE_PARTS: ReadonlySet<string> = new Set(['from', 'to']);

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_NAME = /^[!-9;-~]+$/;
export const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export interface MatchSpec {
  readonly type: MatchType;
  readonly comparator: Comparator;
}

export type AddressPart = 'all' | 'localpart' | 'domain';
export type BodyTransform = { readonly kind: 'raw' } | { readonly kind: 'text' } | { readonly kind: 'content'; readonly types: readonly string[] };
export type SetModifier = 'lower' | 'upper' | 'lowerfirst' | 'upperfirst' | 'quotewildcard' | 'length';

export type CompiledTest =
  | { readonly kind: 'true' | 'false'; readonly pos: SourcePos }
  | { readonly kind: 'not'; readonly test: CompiledTest; readonly pos: SourcePos }
  | { readonly kind: 'anyof' | 'allof'; readonly tests: readonly CompiledTest[]; readonly pos: SourcePos }
  | { readonly kind: 'header'; readonly names: readonly string[]; readonly keys: readonly string[]; readonly match: MatchSpec; readonly pos: SourcePos }
  | {
      readonly kind: 'address' | 'envelope';
      readonly names: readonly string[];
      readonly keys: readonly string[];
      readonly match: MatchSpec;
      readonly part: AddressPart;
      readonly pos: SourcePos;
    }
  | { readonly kind: 'exists'; readonly names: readonly string[]; readonly pos: SourcePos }
  | { readonly kind: 'size'; readonly over: boolean; readonly limit: number; readonly pos: SourcePos }
  | { readonly kind: 'body'; readonly transform: BodyTransform; readonly keys: readonly string[]; readonly match: MatchSpec; readonly pos: SourcePos }
  | { readonly kind: 'hasflag'; readonly variables: readonly string[] | null; readonly keys: readonly string[]; readonly match: MatchSpec; readonly pos: SourcePos }
  | { readonly kind: 'string'; readonly sources: readonly string[]; readonly keys: readonly string[]; readonly match: MatchSpec; readonly pos: SourcePos }
  | { readonly kind: 'mailboxexists'; readonly names: readonly string[]; readonly pos: SourcePos };

export type CompiledCommand =
  | { readonly kind: 'if'; readonly branches: readonly { readonly test: CompiledTest | null; readonly block: readonly CompiledCommand[] }[]; readonly pos: SourcePos }
  | { readonly kind: 'stop' | 'discard'; readonly pos: SourcePos }
  | { readonly kind: 'keep'; readonly flags: readonly string[] | null; readonly pos: SourcePos }
  | { readonly kind: 'fileinto'; readonly mailbox: string; readonly flags: readonly string[] | null; readonly create: boolean; readonly pos: SourcePos }
  | { readonly kind: 'redirect'; readonly address: string; readonly pos: SourcePos }
  | { readonly kind: 'setflag' | 'addflag' | 'removeflag'; readonly variable: string | null; readonly flags: readonly string[]; readonly pos: SourcePos }
  | { readonly kind: 'set'; readonly name: string; readonly value: string; readonly modifiers: readonly SetModifier[]; readonly pos: SourcePos }
  | {
      readonly kind: 'vacation';
      readonly reason: string;
      readonly days: number | null;
      readonly subject: string | null;
      readonly from: string | null;
      readonly addresses: readonly string[];
      readonly mime: boolean;
      readonly handle: string | null;
      readonly pos: SourcePos;
    }
  | { readonly kind: 'bucket'; readonly name: string; readonly pos: SourcePos };

export interface CompiledScript {
  /** Every capability the script required, lowercased. */
  readonly capabilities: readonly string[];
  readonly commands: readonly CompiledCommand[];
}

// ---------------------------------------------------------------------------------------------
// Argument binding

type ValueKind = 'string' | 'string-list' | 'number';

interface TagDef {
  readonly value?: ValueKind;
  /** Tags in one group are mutually exclusive. */
  readonly group?: string;
  /** Capability the tag needs. */
  readonly ext?: string;
}

interface Bound {
  readonly tags: Map<string, { readonly pos: SourcePos; readonly value: Argument | null }>;
  readonly groups: Map<string, string>;
  readonly positional: Argument[];
}

const COMPARATOR_TAG: Record<string, TagDef> = { comparator: { value: 'string', group: 'comparator' } };
const MATCH_TAGS: Record<string, TagDef> = { is: { group: 'match' }, contains: { group: 'match' }, matches: { group: 'match' } };
const ADDRESS_PART_TAGS: Record<string, TagDef> = { all: { group: 'part' }, localpart: { group: 'part' }, domain: { group: 'part' } };

function kindOf(a: Argument): string {
  switch (a.type) {
    case 'tag':
      return `tag ":${a.name}"`;
    case 'number':
      return 'a number';
    case 'string':
      return 'a string';
    case 'list':
      return 'a string list';
  }
}

function fits(a: Argument, kind: ValueKind): boolean {
  if (kind === 'number') return a.type === 'number';
  if (kind === 'string') return a.type === 'string';
  return a.type === 'string' || a.type === 'list';
}

const KIND_NAME: Record<ValueKind, string> = { string: 'a string', 'string-list': 'a string list', number: 'a number' };

class Compiler {
  private readonly caps = new Set<string>();

  compile(script: ScriptNode): CompiledScript {
    let requiresDone = false;
    for (const c of script.commands) {
      if (c.name !== 'require') {
        requiresDone = true;
        continue;
      }
      if (requiresDone) throw new SieveSyntaxError('require-position', '"require" must come before any other command', c.pos);
    }
    const commands = this.block(script.commands, true);
    return { capabilities: [...this.caps], commands };
  }

  private need(ext: string, what: string, pos: SourcePos): void {
    if (!this.caps.has(ext)) throw new SieveSyntaxError('not-required', `${what} needs require "${ext}"`, pos);
  }

  private get variables(): boolean {
    return this.caps.has('variables');
  }

  /** A literal check applies only when the string cannot change at run time. */
  private literal(s: string): boolean {
    return !this.variables || !s.includes('${');
  }

  private bind(name: string, args: readonly Argument[], tags: Record<string, TagDef>): Bound {
    const bound: Bound = { tags: new Map(), groups: new Map(), positional: [] };
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i] as Argument;
      if (a.type !== 'tag') break;
      const def = Object.hasOwn(tags, a.name) ? tags[a.name] : undefined;
      if (def === undefined) throw new SieveSyntaxError('bad-arguments', `${name} does not take ":${a.name}"`, a.pos);
      if (def.ext !== undefined) this.need(def.ext, `":${a.name}"`, a.pos);
      if (bound.tags.has(a.name)) throw new SieveSyntaxError('bad-arguments', `":${a.name}" given twice`, a.pos);
      if (def.group !== undefined) {
        const prev = bound.groups.get(def.group);
        if (prev !== undefined) throw new SieveSyntaxError('bad-arguments', `":${a.name}" cannot be combined with ":${prev}"`, a.pos);
        bound.groups.set(def.group, a.name);
      }
      let value: Argument | null = null;
      if (def.value !== undefined) {
        const v = args[i + 1];
        if (v === undefined || !fits(v, def.value)) {
          throw new SieveSyntaxError('bad-arguments', `":${a.name}" must be followed by ${KIND_NAME[def.value]}`, v?.pos ?? a.pos);
        }
        value = v;
        i++;
      }
      bound.tags.set(a.name, { pos: a.pos, value });
    }
    for (; i < args.length; i++) {
      const a = args[i] as Argument;
      if (a.type === 'tag') throw new SieveSyntaxError('bad-arguments', `tagged argument ":${a.name}" must come before positional arguments`, a.pos);
      bound.positional.push(a);
    }
    return bound;
  }

  private positional(name: string, bound: Bound, kinds: readonly ValueKind[], pos: SourcePos): Argument[] {
    const p = bound.positional;
    if (p.length !== kinds.length) {
      throw new SieveSyntaxError('bad-arguments', `${name} takes ${kinds.length} positional argument${kinds.length === 1 ? '' : 's'}, found ${p.length}`, p[kinds.length]?.pos ?? pos);
    }
    kinds.forEach((k, i) => {
      const a = p[i] as Argument;
      if (!fits(a, k)) throw new SieveSyntaxError('bad-arguments', `${name}: expected ${KIND_NAME[k]}, found ${kindOf(a)}`, a.pos);
    });
    return p;
  }

  private str(a: Argument): string {
    return a.type === 'string' ? a.value : '';
  }

  private list(a: Argument): string[] {
    if (a.type === 'string') return [a.value];
    if (a.type === 'list') return [...a.values];
    return [];
  }

  private num(a: Argument): number {
    return a.type === 'number' ? a.value : 0;
  }

  private tagString(bound: Bound, tag: string): string | null {
    const t = bound.tags.get(tag);
    return t?.value ? this.str(t.value) : null;
  }

  private match(bound: Bound, defaultComparator: Comparator = 'i;ascii-casemap'): MatchSpec {
    const type = (bound.groups.get('match') ?? 'is') as MatchType;
    let comparator = defaultComparator;
    const c = bound.tags.get('comparator');
    if (c?.value) {
      const name = this.str(c.value).toLowerCase();
      if (!COMPARATORS.has(name)) throw new SieveSyntaxError('bad-value', `unsupported comparator "${this.str(c.value)}"`, c.value.pos);
      comparator = name as Comparator;
    }
    return { type, comparator };
  }

  private headerNames(names: string[], pos: SourcePos): string[] {
    for (const n of names) {
      if (this.literal(n) && !FIELD_NAME.test(n)) throw new SieveSyntaxError('bad-value', `"${n}" is not a valid header field name`, pos);
    }
    return names;
  }

  private noTests(node: CommandNode | TestNode): void {
    const first = node.tests[0];
    if (first !== undefined) throw new SieveSyntaxError('bad-arguments', `${node.name} does not take a test`, first.pos);
  }

  private flagVariable(name: string, pos: SourcePos): string {
    if (!IDENTIFIER.test(name)) throw new SieveSyntaxError('bad-value', `"${name}" is not a valid variable name`, pos);
    return name.toLowerCase();
  }

  // -------------------------------------------------------------------------------------------
  // Tests

  private test(t: TestNode): CompiledTest {
    const pos = t.pos;
    switch (t.name) {
      case 'true':
      case 'false':
        this.positional(t.name, this.bind(t.name, t.args, {}), [], pos);
        this.noTests(t);
        return { kind: t.name, pos };
      case 'not': {
        this.positional('not', this.bind('not', t.args, {}), [], pos);
        const inner = t.tests[0];
        if (t.testList || t.tests.length !== 1 || inner === undefined) throw new SieveSyntaxError('bad-arguments', '"not" takes exactly one test', pos);
        return { kind: 'not', test: this.test(inner), pos };
      }
      case 'anyof':
      case 'allof': {
        this.positional(t.name, this.bind(t.name, t.args, {}), [], pos);
        if (!t.testList) throw new SieveSyntaxError('bad-arguments', `"${t.name}" takes a parenthesised list of tests`, pos);
        return { kind: t.name, tests: t.tests.map((x) => this.test(x)), pos };
      }
      case 'header': {
        const b = this.bind('header', t.args, { ...COMPARATOR_TAG, ...MATCH_TAGS });
        const [names, keys] = this.positional('header', b, ['string-list', 'string-list'], pos) as [Argument, Argument];
        this.noTests(t);
        return { kind: 'header', names: this.headerNames(this.list(names), names.pos), keys: this.list(keys), match: this.match(b), pos };
      }
      case 'address':
      case 'envelope': {
        if (t.name === 'envelope') this.need('envelope', '"envelope"', pos);
        const b = this.bind(t.name, t.args, { ...COMPARATOR_TAG, ...MATCH_TAGS, ...ADDRESS_PART_TAGS });
        const [names, keys] = this.positional(t.name, b, ['string-list', 'string-list'], pos) as [Argument, Argument];
        this.noTests(t);
        let list = this.list(names);
        if (t.name === 'envelope') {
          list = list.map((n) => {
            if (!this.literal(n)) return n;
            const low = n.toLowerCase();
            if (!ENVELOPE_PARTS.has(low)) throw new SieveSyntaxError('bad-value', `unsupported envelope part "${n}" (from and to are)`, names.pos);
            return low;
          });
        } else {
          this.headerNames(list, names.pos);
        }
        const part = (b.groups.get('part') ?? 'all') as AddressPart;
        return { kind: t.name, names: list, keys: this.list(keys), match: this.match(b), part, pos };
      }
      case 'exists': {
        const b = this.bind('exists', t.args, {});
        const [names] = this.positional('exists', b, ['string-list'], pos) as [Argument];
        this.noTests(t);
        return { kind: 'exists', names: this.headerNames(this.list(names), names.pos), pos };
      }
      case 'size': {
        const b = this.bind('size', t.args, { over: { group: 'size' }, under: { group: 'size' } });
        const [limit] = this.positional('size', b, ['number'], pos) as [Argument];
        this.noTests(t);
        const which = b.groups.get('size');
        if (which === undefined) throw new SieveSyntaxError('bad-arguments', '"size" needs :over or :under', pos);
        return { kind: 'size', over: which === 'over', limit: this.num(limit), pos };
      }
      case 'body': {
        this.need('body', '"body"', pos);
        const b = this.bind(
          'body',
          t.args,
          { ...COMPARATOR_TAG, ...MATCH_TAGS, raw: { group: 'transform' }, text: { group: 'transform' }, content: { group: 'transform', value: 'string-list' } },
        );
        const [keys] = this.positional('body', b, ['string-list'], pos) as [Argument];
        this.noTests(t);
        const which = b.groups.get('transform') ?? 'text';
        let transform: BodyTransform;
        if (which === 'content') {
          const v = b.tags.get('content')?.value;
          transform = { kind: 'content', types: v ? this.list(v).map((x) => x.toLowerCase()) : [] };
        } else {
          transform = { kind: which === 'raw' ? 'raw' : 'text' };
        }
        return { kind: 'body', transform, keys: this.list(keys), match: this.match(b), pos };
      }
      case 'hasflag': {
        this.need('imap4flags', '"hasflag"', pos);
        const b = this.bind('hasflag', t.args, { ...COMPARATOR_TAG, ...MATCH_TAGS });
        this.noTests(t);
        const p = b.positional;
        if (p.length === 2) {
          this.need('variables', 'a variable list on "hasflag"', (p[0] as Argument).pos);
          const [vars, keys] = this.positional('hasflag', b, ['string-list', 'string-list'], pos) as [Argument, Argument];
          const names = this.list(vars).map((v) => this.flagVariable(v, vars.pos));
          return { kind: 'hasflag', variables: names, keys: this.list(keys), match: this.match(b), pos };
        }
        const [keys] = this.positional('hasflag', b, ['string-list'], pos) as [Argument];
        return { kind: 'hasflag', variables: null, keys: this.list(keys), match: this.match(b), pos };
      }
      case 'string': {
        this.need('variables', '"string"', pos);
        const b = this.bind('string', t.args, { ...COMPARATOR_TAG, ...MATCH_TAGS });
        const [sources, keys] = this.positional('string', b, ['string-list', 'string-list'], pos) as [Argument, Argument];
        this.noTests(t);
        return { kind: 'string', sources: this.list(sources), keys: this.list(keys), match: this.match(b), pos };
      }
      case 'mailboxexists': {
        this.need('mailbox', '"mailboxexists"', pos);
        const b = this.bind('mailboxexists', t.args, {});
        const [names] = this.positional('mailboxexists', b, ['string-list'], pos) as [Argument];
        this.noTests(t);
        return { kind: 'mailboxexists', names: this.list(names), pos };
      }
      default:
        throw new SieveSyntaxError('unknown-test', `unknown test "${t.name}"`, pos);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  private block(nodes: readonly CommandNode[], topLevel: boolean): CompiledCommand[] {
    const out: CompiledCommand[] = [];
    let chain: { test: CompiledTest | null; block: CompiledCommand[] }[] | null = null;
    for (const node of nodes) {
      if (node.name === 'elsif' || node.name === 'else') {
        if (chain === null) throw new SieveSyntaxError('orphan-else', `"${node.name}" without a preceding "if"`, node.pos);
        chain.push(this.branch(node));
        if (node.name === 'else') chain = null;
        continue;
      }
      chain = null;
      if (node.name === 'if') {
        chain = [this.branch(node)];
        out.push({ kind: 'if', branches: chain, pos: node.pos });
        continue;
      }
      if (node.name === 'require') {
        if (!topLevel) throw new SieveSyntaxError('require-position', '"require" is only allowed at the top of the script', node.pos);
        this.require(node);
        continue;
      }
      out.push(this.command(node));
    }
    return out;
  }

  private branch(node: CommandNode): { test: CompiledTest | null; block: CompiledCommand[] } {
    if (node.block === null) throw new SieveSyntaxError('bad-arguments', `"${node.name}" needs a { block }`, node.pos);
    this.positional(node.name, this.bind(node.name, node.args, {}), [], node.pos);
    let test: CompiledTest | null = null;
    if (node.name === 'else') {
      this.noTests(node);
    } else {
      const inner = node.tests[0];
      if (node.testList || node.tests.length !== 1 || inner === undefined) throw new SieveSyntaxError('bad-arguments', `"${node.name}" takes exactly one test`, node.pos);
      test = this.test(inner);
    }
    return { test, block: this.block(node.block, false) };
  }

  private require(node: CommandNode): void {
    const b = this.bind('require', node.args, {});
    const [caps] = this.positional('require', b, ['string-list'], node.pos) as [Argument];
    this.noTests(node);
    if (node.block !== null) throw new SieveSyntaxError('bad-arguments', '"require" does not take a block', node.pos);
    for (const cap of this.list(caps)) {
      const low = cap.toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(low)) throw new SieveSyntaxError('unknown-extension', `unsupported extension "${cap}"`, caps.pos);
      this.caps.add(low);
    }
  }

  private flagsTag(b: Bound): string[] | null {
    const t = b.tags.get('flags');
    return t?.value ? this.list(t.value) : null;
  }

  private command(node: CommandNode): CompiledCommand {
    const pos = node.pos;
    const name = node.name;
    if (node.block !== null) throw new SieveSyntaxError('bad-arguments', `"${name}" does not take a block`, pos);
    this.noTests(node);
    switch (name) {
      case 'stop':
      case 'discard':
        this.positional(name, this.bind(name, node.args, {}), [], pos);
        return { kind: name, pos };
      case 'keep': {
        const b = this.bind('keep', node.args, { flags: { value: 'string-list', ext: 'imap4flags' } });
        this.positional('keep', b, [], pos);
        return { kind: 'keep', flags: this.flagsTag(b), pos };
      }
      case 'fileinto': {
        this.need('fileinto', '"fileinto"', pos);
        const b = this.bind('fileinto', node.args, { flags: { value: 'string-list', ext: 'imap4flags' }, create: { ext: 'mailbox' } });
        const [mailbox] = this.positional('fileinto', b, ['string'], pos) as [Argument];
        const m = this.str(mailbox);
        if (m === '') throw new SieveSyntaxError('bad-value', 'fileinto needs a mailbox name', mailbox.pos);
        return { kind: 'fileinto', mailbox: m, flags: this.flagsTag(b), create: b.tags.has('create'), pos };
      }
      case 'redirect': {
        const b = this.bind('redirect', node.args, {});
        const [address] = this.positional('redirect', b, ['string'], pos) as [Argument];
        const a = this.str(address);
        if (this.literal(a) && !isAddress(a)) throw new SieveSyntaxError('bad-value', `"${a}" is not a valid address`, address.pos);
        return { kind: 'redirect', address: a, pos };
      }
      case 'setflag':
      case 'addflag':
      case 'removeflag': {
        this.need('imap4flags', `"${name}"`, pos);
        const b = this.bind(name, node.args, {});
        if (b.positional.length === 2) {
          this.need('variables', `a variable name on "${name}"`, (b.positional[0] as Argument).pos);
          const [variable, flags] = this.positional(name, b, ['string', 'string-list'], pos) as [Argument, Argument];
          return { kind: name, variable: this.flagVariable(this.str(variable), variable.pos), flags: this.list(flags), pos };
        }
        const [flags] = this.positional(name, b, ['string-list'], pos) as [Argument];
        return { kind: name, variable: null, flags: this.list(flags), pos };
      }
      case 'set': {
        this.need('variables', '"set"', pos);
        const b = this.bind(
          'set',
          node.args,
          {
            lower: { group: 'case' },
            upper: { group: 'case' },
            lowerfirst: { group: 'first' },
            upperfirst: { group: 'first' },
            quotewildcard: {},
            length: {},
          },
        );
        const [n, value] = this.positional('set', b, ['string', 'string'], pos) as [Argument, Argument];
        const varName = this.str(n);
        if (!IDENTIFIER.test(varName)) throw new SieveSyntaxError('bad-value', `"${varName}" is not a valid variable name`, n.pos);
        const order: SetModifier[] = ['lower', 'upper', 'lowerfirst', 'upperfirst', 'quotewildcard', 'length'];
        return { kind: 'set', name: varName.toLowerCase(), value: this.str(value), modifiers: order.filter((m) => b.tags.has(m)), pos };
      }
      case 'vacation': {
        this.need('vacation', '"vacation"', pos);
        const b = this.bind(
          'vacation',
          node.args,
          {
            days: { value: 'number' },
            subject: { value: 'string' },
            from: { value: 'string' },
            addresses: { value: 'string-list' },
            mime: {},
            handle: { value: 'string' },
          },
        );
        const [reason] = this.positional('vacation', b, ['string'], pos) as [Argument];
        const days = b.tags.get('days')?.value;
        const from = this.tagString(b, 'from');
        if (from !== null && this.literal(from) && !isAddress(from) && !/<[^<>@\s]+@[^<>@\s]+>/.test(from)) {
          throw new SieveSyntaxError('bad-value', `":from" "${from}" is not a valid address`, b.tags.get('from')?.value?.pos ?? pos);
        }
        const addrs = b.tags.get('addresses')?.value;
        return {
          kind: 'vacation',
          reason: this.str(reason),
          days: days ? this.num(days) : null,
          subject: this.tagString(b, 'subject'),
          from,
          addresses: addrs ? this.list(addrs) : [],
          mime: b.tags.has('mime'),
          handle: this.tagString(b, 'handle'),
          pos,
        };
      }
      case 'bucket': {
        this.need('vnd.postroom.bucket', '"bucket"', pos);
        const b = this.bind('bucket', node.args, {});
        const [bucket] = this.positional('bucket', b, ['string'], pos) as [Argument];
        const v = this.str(bucket);
        if (this.literal(v) && !BUCKET_NAME.test(v)) {
          throw new SieveSyntaxError('bad-value', `"${v}" is not a valid bucket name (1-64 of letters, digits, space, "_", "." and "-", starting with a letter or digit)`, bucket.pos);
        }
        return { kind: 'bucket', name: v, pos };
      }
      default:
        throw new SieveSyntaxError('unknown-command', `unknown command "${name}"`, pos);
    }
  }
}

/** A bare `local@domain` with no spaces or angle brackets. */
export function isAddress(s: string): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:[\]]+$/.test(s) || /^"[^"\r\n]*"@[^\s@<>()",;:[\]]+$/.test(s);
}

/** Validate a syntax tree. Throws only SieveSyntaxError. */
export function compile(script: ScriptNode): CompiledScript {
  return new Compiler().compile(script);
}
