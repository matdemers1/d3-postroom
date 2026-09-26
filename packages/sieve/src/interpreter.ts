// The interpreter: runs a compiled script against one message and returns the actions it decided on,
// never performing any of them. Delivery, redirect and vacation replies are the worker's job; this
// only says what the script asked for, what Postroom policy did with it, and why.
//
// Semantics (RFC 5228 §2.10 and the extension RFCs):
//   - The implicit keep is cancelled by keep, fileinto, discard and an *accepted* redirect. It is
//     not cancelled by vacation, flag commands, `bucket`, or a redirect Postroom refused — a refused
//     redirect must never lose the message.
//   - discard only cancels the implicit keep; any explicit keep or fileinto still happens.
//   - keep is fileinto the default mailbox; filing into the same mailbox twice files it once (the
//     flag sets are merged), and redirecting to the same address twice redirects once.
//   - imap4flags: keep/fileinto without :flags, and the implicit keep, use the internal flag set.
//   - A runtime error abandons every action and falls back to the implicit keep (§2.10.6).
//   - Work is bounded: every command, test and match step is charged to a budget.
//
// Postroom policy: redirect is recorded as refused unless `ownsAddress` says the target belongs to
// the account — Postroom never relays (PST-REQ-053).

import { createHash } from 'node:crypto';
import { decodeEncodedWords, parseAddressList } from '@postroom/mime';
import type { AddressPart, BodyTransform, CompiledCommand, CompiledScript, CompiledTest, MatchSpec, SetModifier } from './compile.js';
import { BUCKET_NAME, IDENTIFIER, isAddress } from './compile.js';
import { SieveRuntimeError, type RuntimeErrorCode, type SourcePos } from './errors.js';
import { matchAny, type Budget, type MatchOutcome } from './match.js';
import type { SieveMessage } from './message.js';

export interface KeepAction {
  readonly type: 'keep';
  readonly mailbox: string;
  /** IMAP flags to set, or null when imap4flags is not in use. */
  readonly flags: readonly string[] | null;
  readonly implicit: boolean;
  readonly line: number;
}

export interface FileintoAction {
  readonly type: 'fileinto';
  readonly mailbox: string;
  readonly flags: readonly string[] | null;
  /** RFC 5490 :create — create the mailbox if it does not exist. */
  readonly create: boolean;
  readonly line: number;
}

export interface DiscardAction {
  readonly type: 'discard';
  readonly line: number;
}

export interface RedirectAction {
  readonly type: 'redirect';
  readonly address: string;
  /** False when Postroom policy refused it (the address is not the account's own). */
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly line: number;
}

export interface VacationAction {
  readonly type: 'vacation';
  /** Who the reply would go to: the envelope sender. */
  readonly to: string;
  readonly subject: string;
  readonly from: string | null;
  readonly reason: string;
  /** The reason is a MIME entity (headers + body), not plain text. */
  readonly mime: boolean;
  readonly handle: string;
  readonly days: number;
  /** True when a reply should be sent; false when a rule suppressed it (see `suppressed`). */
  readonly respond: boolean;
  readonly suppressed: string | null;
  readonly line: number;
}

export type SieveAction = KeepAction | FileintoAction | DiscardAction | RedirectAction | VacationAction;

export interface TraceEntry {
  readonly line: number;
  readonly column: number;
  readonly event: string;
}

export interface SieveResult {
  readonly actions: readonly SieveAction[];
  /** True when the implicit keep survived (the last action is then a keep with implicit: true). */
  readonly implicitKeep: boolean;
  /** Set by `bucket "…"` (vnd.postroom.bucket); the last one executed wins. */
  readonly bucket: string | null;
  /** The runtime error that abandoned the script, or null. When set, actions is just the implicit keep. */
  readonly error: SieveRuntimeError | null;
  /** What ran and what each test decided, in order (bounded). Sorting decisions keep their reasons. */
  readonly trace: readonly TraceEntry[];
}

/** Once-per-sender state for vacation (RFC 5230 §4.2). The caller records a sent reply itself. */
export interface VacationStore {
  /** Has a reply with this handle gone to this sender within the last `days` days? */
  recentlyResponded(sender: string, handle: string, days: number): boolean;
}

export interface ExecuteOptions {
  /** The account's own addresses: vacation's "addressed to me" check and the default redirect policy. */
  readonly userAddresses?: readonly string[];
  /** May a redirect go to this address? Default: only to one of `userAddresses`. Postroom never relays. */
  readonly ownsAddress?: (address: string) => boolean;
  /** For `mailboxexists` (RFC 5490). Default: nothing exists. */
  readonly mailboxExists?: (mailbox: string) => boolean;
  readonly vacationStore?: VacationStore;
  /** Mailbox for keep and the implicit keep (default "INBOX"). */
  readonly inbox?: string;
  /** Work units a run may spend (default 5,000,000). */
  readonly maxWork?: number;
  /** Distinct redirects allowed (default 4). */
  readonly maxRedirects?: number;
  /** Actions allowed in total (default 64). */
  readonly maxActions?: number;
  /** Longest variable value or expanded string (default 64 KiB). */
  readonly maxStringLength?: number;
  /** Trace entries kept (default 500). */
  readonly maxTrace?: number;
  /** vacation :days bounds (defaults 1 and 30). */
  readonly minVacationDays?: number;
  readonly maxVacationDays?: number;
}

const ADDRESS_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'sender',
  'reply-to',
  'resent-from',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-sender',
  'resent-reply-to',
  'return-path',
  'delivered-to',
  'envelope-to',
  'x-original-to',
  'errors-to',
  'mail-followup-to',
  'mail-reply-to',
  'disposition-notification-to',
]);

const LIST_HEADERS = ['list-id', 'list-help', 'list-subscribe', 'list-unsubscribe', 'list-post', 'list-owner', 'list-archive'];
const RECIPIENT_HEADERS = ['to', 'cc', 'bcc', 'resent-to', 'resent-cc', 'resent-bcc'];
const AUTOMATED_SENDER = /^(owner-.*|.*-request|mailer-daemon|listserv|majordomo|no-?reply|postmaster)$/i;

/** Thrown by `stop` to unwind; never escapes `execute`. */
class Stop extends Error {}

class Run implements Budget {
  private readonly script: CompiledScript;
  private readonly msg: SieveMessage;
  private readonly opts: ExecuteOptions;
  private readonly useVariables: boolean;
  private readonly useFlags: boolean;
  private readonly inbox: string;
  private readonly maxWork: number;
  private readonly maxString: number;
  private readonly maxTrace: number;

  private work = 0;
  private pos: SourcePos = { line: 1, column: 1 };
  private readonly vars = new Map<string, string>();
  private matchVars: string[] = [];
  private flags: string[] = [];
  private readonly actions: SieveAction[] = [];
  private readonly filed = new Map<string, number>();
  private readonly redirected = new Set<string>();
  private implicitKeep = true;
  private bucket: string | null = null;
  private vacationDone = false;
  readonly trace: TraceEntry[] = [];

  constructor(script: CompiledScript, msg: SieveMessage, opts: ExecuteOptions) {
    this.script = script;
    this.msg = msg;
    this.opts = opts;
    this.useVariables = script.capabilities.includes('variables');
    this.useFlags = script.capabilities.includes('imap4flags');
    this.inbox = opts.inbox ?? 'INBOX';
    this.maxWork = opts.maxWork ?? 5_000_000;
    this.maxString = opts.maxStringLength ?? 64 * 1024;
    this.maxTrace = opts.maxTrace ?? 500;
  }

  charge(n: number): void {
    this.work += n;
    if (this.work > this.maxWork) this.fail('work-limit', `script exceeded its work limit (${this.maxWork})`);
  }

  private fail(code: RuntimeErrorCode, detail: string): never {
    throw new SieveRuntimeError(code, detail, this.pos);
  }

  private note(event: string): void {
    if (this.trace.length < this.maxTrace) this.trace.push({ line: this.pos.line, column: this.pos.column, event });
  }

  // ---------------------------------------------------------------------------------------------
  // Strings and variables (RFC 5229)

  private expand(s: string): string {
    if (!this.useVariables || !s.includes('${')) return s;
    const out: string[] = [];
    let length = 0;
    let i = 0;
    while (i < s.length) {
      const at = s.indexOf('${', i);
      if (at < 0) {
        out.push(s.slice(i));
        break;
      }
      out.push(s.slice(i, at));
      length += at - i;
      const close = s.indexOf('}', at + 2);
      const name = close < 0 ? '' : s.slice(at + 2, close);
      let value: string | null = null;
      if (/^[0-9]+$/.test(name)) value = this.matchVars[Number(name)] ?? '';
      else if (IDENTIFIER.test(name)) value = this.vars.get(name.toLowerCase()) ?? '';
      if (value === null) {
        // Not a reference ("${}", "${doh!}", "${a.b}"): keep the "${" and scan on after it.
        out.push('${');
        length += 2;
        i = at + 2;
      } else {
        out.push(value);
        length += value.length;
        i = close + 1;
      }
      this.charge(1 + (value?.length ?? 0));
      if (length > this.maxString) break;
    }
    const result = out.join('');
    return result.length > this.maxString ? result.slice(0, this.maxString) : result;
  }

  private expandAll(list: readonly string[]): string[] {
    return list.map((s) => this.expand(s));
  }

  private modify(value: string, modifiers: readonly SetModifier[]): string {
    let v = value;
    for (const m of modifiers) {
      switch (m) {
        case 'lower':
          v = v.toLowerCase();
          break;
        case 'upper':
          v = v.toUpperCase();
          break;
        case 'lowerfirst':
          v = v.slice(0, 1).toLowerCase() + v.slice(1);
          break;
        case 'upperfirst':
          v = v.slice(0, 1).toUpperCase() + v.slice(1);
          break;
        case 'quotewildcard':
          v = v.replace(/[*?\\]/g, (c) => `\\${c}`);
          break;
        case 'length':
          v = String(v.length - (v.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0));
          break;
      }
    }
    return v;
  }

  // ---------------------------------------------------------------------------------------------
  // Flags (RFC 5232)

  private splitFlags(list: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of list) {
      for (const f of s.split(/[ \t\r\n]+/)) {
        if (f === '') continue;
        const key = f.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
    }
    return out;
  }

  private getFlags(variable: string | null): string[] {
    return variable === null ? this.flags : this.splitFlags([this.vars.get(variable) ?? '']);
  }

  private putFlags(variable: string | null, flags: string[]): void {
    if (variable === null) this.flags = flags;
    else this.vars.set(variable, flags.join(' ').slice(0, this.maxString));
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  private push(action: SieveAction): void {
    const max = this.opts.maxActions ?? 64;
    if (this.actions.length >= max) this.fail('action-limit', `more than ${max} actions`);
    this.actions.push(action);
  }

  private mailboxKey(mailbox: string): string {
    return mailbox.toUpperCase() === 'INBOX' ? 'INBOX' : mailbox;
  }

  private deliver(type: 'keep' | 'fileinto', mailbox: string, flags: string[] | null, create: boolean): void {
    this.implicitKeep = false;
    const key = this.mailboxKey(mailbox);
    const existing = this.filed.get(key);
    if (existing !== undefined) {
      const prev = this.actions[existing] as KeepAction | FileintoAction;
      const merged = prev.flags === null && flags === null ? null : this.splitFlags([...(prev.flags ?? []), ...(flags ?? [])]);
      this.actions[existing] = prev.type === 'fileinto' ? { ...prev, flags: merged, create: prev.create || create } : { ...prev, flags: merged };
      this.note(`${type} "${mailbox}" merged with an earlier delivery to the same mailbox`);
      return;
    }
    this.filed.set(key, this.actions.length);
    const line = this.pos.line;
    this.push(type === 'keep' ? { type, mailbox, flags, implicit: false, line } : { type, mailbox, flags, create, line });
    this.note(`${type} "${mailbox}"${flags && flags.length > 0 ? ` flags ${flags.join(' ')}` : ''}`);
  }

  private owns(address: string): boolean {
    if (this.opts.ownsAddress) return this.opts.ownsAddress(address);
    const want = address.toLowerCase();
    return (this.opts.userAddresses ?? []).some((a) => a.toLowerCase() === want);
  }

  private redirect(address: string): void {
    if (!isAddress(address)) this.fail('bad-value', `redirect: "${address}" is not a valid address`);
    const key = address.toLowerCase();
    if (this.redirected.has(key)) {
      this.note(`redirect to ${address} already recorded`);
      return;
    }
    const max = this.opts.maxRedirects ?? 4;
    if (this.redirected.size >= max) this.fail('action-limit', `more than ${max} redirects`);
    this.redirected.add(key);
    const allowed = this.owns(address);
    const reason = allowed ? null : 'redirect refused: the address does not belong to this account and Postroom never relays';
    if (allowed) this.implicitKeep = false;
    this.push({ type: 'redirect', address, allowed, reason, line: this.pos.line });
    this.note(allowed ? `redirect to ${address}` : `redirect to ${address} refused (not the account's own address)`);
  }

  private vacation(cmd: Extract<CompiledCommand, { kind: 'vacation' }>): void {
    if (this.vacationDone) this.fail('duplicate-vacation', 'vacation may only run once');
    this.vacationDone = true;
    const reason = this.expand(cmd.reason);
    const from = cmd.from === null ? null : this.expand(cmd.from);
    const explicitSubject = cmd.subject === null ? null : this.expand(cmd.subject);
    const addresses = this.expandAll(cmd.addresses);
    const minDays = this.opts.minVacationDays ?? 1;
    const maxDays = this.opts.maxVacationDays ?? 30;
    const days = Math.min(maxDays, Math.max(minDays, cmd.days ?? 7));
    const handle =
      cmd.handle !== null
        ? this.expand(cmd.handle)
        : createHash('sha256')
            .update(JSON.stringify([reason, explicitSubject, from, cmd.mime]))
            .digest('hex')
            .slice(0, 32);
    const original = this.msg.header('subject')[0];
    const subject = explicitSubject ?? (original === undefined || original.trim() === '' ? 'Automated reply' : `Auto: ${decodeEncodedWords(original)}`);

    const sender = this.msg.envelope.from;
    const mine = new Set([...(this.opts.userAddresses ?? []), ...addresses, this.msg.envelope.to].map((a) => a.toLowerCase()).filter((a) => a !== ''));
    let suppressed: string | null = null;
    const autoSubmitted = this.msg.header('auto-submitted')[0];
    const precedence = (this.msg.header('precedence')[0] ?? '').trim().toLowerCase();
    if (sender === '') suppressed = 'the message has a null envelope sender';
    else if (AUTOMATED_SENDER.test(sender.split('@')[0] ?? '')) suppressed = 'the sender looks like an automated or list address';
    else if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== 'no') suppressed = 'the message is Auto-Submitted';
    else if (LIST_HEADERS.some((h) => this.msg.header(h).length > 0) || ['bulk', 'list', 'junk'].includes(precedence)) suppressed = 'the message came from a mailing list';
    else if (mine.has(sender.toLowerCase())) suppressed = 'the sender is the account itself';
    else if (!this.addressedToMe(mine)) suppressed = "none of the account's addresses is in To, Cc or Bcc";
    else if (this.opts.vacationStore?.recentlyResponded(sender, handle, days) === true) suppressed = `already replied to this sender within ${days} days`;

    this.push({ type: 'vacation', to: sender, subject, from, reason, mime: cmd.mime, handle, days, respond: suppressed === null, suppressed, line: this.pos.line });
    this.note(suppressed === null ? `vacation reply to ${sender}` : `vacation suppressed: ${suppressed}`);
  }

  private addressedToMe(mine: ReadonlySet<string>): boolean {
    for (const h of RECIPIENT_HEADERS) {
      for (const value of this.msg.header(h)) {
        this.charge(1 + value.length);
        for (const a of this.addresses(value)) if (mine.has(a.toLowerCase())) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Tests

  private addresses(value: string): string[] {
    const out: string[] = [];
    for (const entry of parseAddressList(value)) {
      if ('members' in entry) for (const m of entry.members) out.push(m.address);
      else out.push(entry.address);
    }
    return out;
  }

  private part(address: string, part: AddressPart): string {
    if (part === 'all') return address;
    const at = address.lastIndexOf('@');
    if (part === 'localpart') return at < 0 ? address : address.slice(0, at);
    return at < 0 ? '' : address.slice(at + 1);
  }

  private compare(values: readonly string[], keys: readonly string[], match: MatchSpec): boolean {
    const r: MatchOutcome = matchAny(values, this.expandAll(keys), match.type, match.comparator, this);
    if (r.matched && r.captures !== null && this.useVariables) this.matchVars = r.captures;
    return r.matched;
  }

  private headerValues(name: string): readonly string[] {
    const values = this.msg.header(name);
    for (const v of values) this.charge(1 + v.length);
    return values;
  }

  private bodyValues(transform: BodyTransform): string[] {
    if (transform.kind === 'raw') return [this.msg.rawBody()];
    const parts = this.msg.bodyParts();
    const out: string[] = [];
    for (const p of parts) {
      if (transform.kind === 'text') {
        if (!p.contentType.startsWith('text/') || p.disposition === 'attachment') continue;
        out.push(p.contentType === 'text/html' ? stripTags(p.content) : p.content);
        continue;
      }
      const major = p.contentType.split('/')[0] ?? '';
      const types = this.expandAll(transform.types).map((t) => t.toLowerCase());
      if (types.some((t) => t === '' || t === p.contentType || (!t.includes('/') && t === major))) out.push(p.content);
    }
    return out;
  }

  private test(t: CompiledTest): boolean {
    this.pos = t.pos;
    this.charge(1);
    const result = this.evaluate(t);
    this.pos = t.pos;
    if (t.kind !== 'not' && t.kind !== 'anyof' && t.kind !== 'allof' && t.kind !== 'true' && t.kind !== 'false') this.note(`${t.kind} test ${result ? 'matched' : 'did not match'}`);
    return result;
  }

  private evaluate(t: CompiledTest): boolean {
    switch (t.kind) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'not':
        return !this.test(t.test);
      case 'anyof':
        for (const x of t.tests) if (this.test(x)) return true;
        return false;
      case 'allof':
        for (const x of t.tests) if (!this.test(x)) return false;
        return true;
      case 'header': {
        const values: string[] = [];
        for (const name of this.expandAll(t.names)) for (const v of this.headerValues(name)) values.push(decodeEncodedWords(v));
        return this.compare(values, t.keys, t.match);
      }
      case 'address': {
        const values: string[] = [];
        for (const name of this.expandAll(t.names)) {
          if (!ADDRESS_HEADERS.has(name.toLowerCase())) continue;
          for (const v of this.headerValues(name)) for (const a of this.addresses(v)) values.push(this.part(a, t.part));
        }
        return this.compare(values, t.keys, t.match);
      }
      case 'envelope': {
        const values: string[] = [];
        for (const name of this.expandAll(t.names)) {
          const low = name.toLowerCase();
          if (low === 'from') values.push(this.part(this.msg.envelope.from, t.part));
          else if (low === 'to') values.push(this.part(this.msg.envelope.to, t.part));
        }
        return this.compare(values, t.keys, t.match);
      }
      case 'exists':
        return this.expandAll(t.names).every((n) => this.msg.header(n).length > 0);
      case 'size':
        return t.over ? this.msg.size > t.limit : this.msg.size < t.limit;
      case 'body': {
        const values = this.bodyValues(t.transform);
        for (const v of values) this.charge(1 + v.length);
        return this.compare(values, t.keys, t.match);
      }
      case 'hasflag': {
        const values: string[] = [];
        if (t.variables === null) values.push(...this.flags);
        else for (const v of t.variables) values.push(...this.getFlags(v));
        return this.compare(values, t.keys, t.match);
      }
      case 'string':
        return this.compare(this.expandAll(t.sources), t.keys, t.match);
      case 'mailboxexists': {
        const exists = this.opts.mailboxExists;
        return exists !== undefined && this.expandAll(t.names).every((n) => exists(n));
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Commands

  private flagsFor(explicit: readonly string[] | null): string[] | null {
    if (!this.useFlags) return null;
    return explicit === null ? [...this.flags] : this.splitFlags(this.expandAll(explicit));
  }

  private block(commands: readonly CompiledCommand[]): void {
    for (const c of commands) this.command(c);
  }

  private command(c: CompiledCommand): void {
    this.pos = c.pos;
    this.charge(1);
    switch (c.kind) {
      case 'if':
        for (const b of c.branches) {
          if (b.test === null || this.test(b.test)) {
            this.block(b.block);
            return;
          }
        }
        return;
      case 'stop':
        this.note('stop');
        throw new Stop();
      case 'keep':
        this.deliver('keep', this.inbox, this.flagsFor(c.flags), false);
        return;
      case 'discard':
        this.implicitKeep = false;
        this.push({ type: 'discard', line: c.pos.line });
        this.note('discard');
        return;
      case 'fileinto': {
        const mailbox = this.expand(c.mailbox);
        if (mailbox === '') this.fail('bad-value', 'fileinto: the mailbox name expanded to nothing');
        this.deliver('fileinto', mailbox, this.flagsFor(c.flags), c.create);
        return;
      }
      case 'redirect':
        this.redirect(this.expand(c.address));
        return;
      case 'setflag':
      case 'addflag':
      case 'removeflag': {
        const given = this.splitFlags(this.expandAll(c.flags));
        const current = this.getFlags(c.variable);
        let next: string[];
        if (c.kind === 'setflag') next = given;
        else if (c.kind === 'addflag') next = this.splitFlags([...current, ...given]);
        else {
          const drop = new Set(given.map((f) => f.toLowerCase()));
          next = current.filter((f) => !drop.has(f.toLowerCase()));
        }
        this.putFlags(c.variable, next);
        this.note(`${c.kind}${c.variable === null ? '' : ` ${c.variable}`}: ${next.join(' ') || '(none)'}`);
        return;
      }
      case 'set': {
        const value = this.modify(this.expand(c.value), c.modifiers).slice(0, this.maxString);
        this.vars.set(c.name, value);
        this.charge(1 + value.length);
        this.note(`set ${c.name}`);
        return;
      }
      case 'vacation':
        this.vacation(c);
        return;
      case 'bucket': {
        const name = this.expand(c.name);
        if (!BUCKET_NAME.test(name)) this.fail('bad-value', `bucket: "${name}" is not a valid bucket name`);
        this.bucket = name;
        this.note(`bucket "${name}"`);
        return;
      }
    }
  }

  run(): SieveResult {
    try {
      this.block(this.script.commands);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
    }
    if (this.implicitKeep) {
      this.actions.push({ type: 'keep', mailbox: this.inbox, flags: this.useFlags ? [...this.flags] : null, implicit: true, line: 0 });
    }
    return { actions: this.actions, implicitKeep: this.implicitKeep, bucket: this.bucket, error: null, trace: this.trace };
  }
}

/** Crude, linear HTML-to-text for `body :text`: tags are dropped, the common entities decode. */
function stripTags(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    i = gt + 1;
  }
  return out
    .join('')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Run a compiled script against a message. Never throws for anything the script or the message can
 * do: a runtime error comes back as `result.error`, with the implicit keep as the only action.
 */
export function execute(script: CompiledScript, message: SieveMessage, options: ExecuteOptions = {}): SieveResult {
  const run = new Run(script, message, options);
  try {
    return run.run();
  } catch (err) {
    if (!(err instanceof SieveRuntimeError)) throw err;
    const inbox = options.inbox ?? 'INBOX';
    return {
      actions: [{ type: 'keep', mailbox: inbox, flags: null, implicit: true, line: 0 }],
      implicitKeep: true,
      bucket: null,
      error: err,
      trace: [...run.trace, { line: err.line, column: err.column, event: `runtime error: ${err.detail}; falling back to the implicit keep` }],
    };
  }
}
