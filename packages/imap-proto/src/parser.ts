// The IMAP command parser: one complete command (as the reader assembles it — wire bytes without
// the final CRLF, literals inline) to a typed `Command` (PST-REQ-070).
//
// Grammar: RFC 3501 and RFC 9051, plus LITERAL+/- (RFC 7888), CONDSTORE/QRESYNC (RFC 7162), IDLE
// (RFC 2177), SPECIAL-USE (RFC 6154), ESEARCH (RFC 4731), SEARCHRES (RFC 5182), NAMESPACE
// (RFC 2342), UIDPLUS (RFC 4315), MOVE (RFC 6851), ENABLE (RFC 5161), ID (RFC 2971), UNSELECT
// (RFC 3691), SASL-IR (RFC 4959), LIST-EXTENDED (RFC 5258) and LIST-STATUS (RFC 5819), BINARY
// (RFC 3516), STATUS=SIZE (RFC 9051).
//
// Never throws: every failure is `{ ok: false }` with a precise message for the daemon's tagged BAD.
// Parenthesised search groups nest at most `maxNesting` deep and search keys (NOT/OR chains too)
// recurse at most `maxSearchDepth` deep, so a depth bomb is a BAD, never a stack overflow.

import {
  canonicalFlag,
  LIST_SELECT_OPTS,
  SEARCH_DATE_KEYS,
  SEARCH_FLAG_KEYS,
  SEARCH_RETURN_OPTS,
  SEARCH_STRING_KEYS,
  STATUS_ATTS,
  type Command,
  type FetchAtt,
  type FetchMacro,
  type ImapDate,
  type ImapDateTime,
  type ListReturnOpt,
  type ListSelectOpt,
  type PartialRange,
  type QresyncParams,
  type SearchKey,
  type SearchReturnOpt,
  type Section,
  type SectionText,
  type SequenceSet,
  type StatusAtt,
  type StoreOperation,
} from './ast.js';
import { Ch, Cursor, isListChar, isTagChar, SyntaxFail } from './lexer.js';
import { decodeMailboxName } from './mutf7.js';
import { parseSequenceSet } from './sequence.js';

export interface ParseOptions {
  /** IMAP4rev2 enabled, or UTF8=ACCEPT: mailbox names are UTF-8, not modified UTF-7. */
  readonly utf8?: boolean;
  /** Deepest parenthesised search group. */
  readonly maxNesting?: number;
  /** Deepest search-key recursion (parentheses, NOT, OR). */
  readonly maxSearchDepth?: number;
}

export const DEFAULT_MAX_NESTING = 16;
export const DEFAULT_MAX_SEARCH_DEPTH = 64;

export type ParseResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly tag: string | null; readonly message: string; readonly position: number };

export type AppendPrefixResult =
  | {
      readonly ok: true;
      readonly tag: string;
      readonly mailbox: string;
      readonly flags: readonly string[] | null;
      readonly date: ImapDateTime | null;
      readonly size: number;
      readonly binary: boolean;
      readonly synchronizing: boolean;
    }
  | { readonly ok: false; readonly tag: string | null; readonly message: string; readonly position: number };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const utf8Lossy = new TextDecoder('utf-8');
const MAX_ID_PAIRS = 30;

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isSeqChar(c: number): boolean {
  return isDigit(c) || c === Ch.STAR || c === Ch.COLON || c === Ch.COMMA || c === Ch.DOLLAR;
}

class CommandParser {
  readonly c: Cursor;
  readonly utf8: boolean;
  readonly maxNesting: number;
  readonly maxSearchDepth: number;
  private nesting = 0;
  private depth = 0;

  constructor(buf: Buffer, options: ParseOptions) {
    this.c = new Cursor(buf);
    this.utf8 = options.utf8 ?? false;
    this.maxNesting = options.maxNesting ?? DEFAULT_MAX_NESTING;
    this.maxSearchDepth = options.maxSearchDepth ?? DEFAULT_MAX_SEARCH_DEPTH;
  }

  tag(): string {
    return this.c.run(isTagChar, 'a tag').toString('latin1');
  }

  text(bytes: Buffer): string {
    return utf8Lossy.decode(bytes);
  }

  /** A mailbox name (or LIST reference/pattern) from its wire bytes. */
  name(bytes: Buffer, what: string): string {
    if (this.utf8) {
      try {
        return utf8Fatal.decode(bytes);
      } catch {
        return this.c.fail(`${what} is not valid UTF-8`);
      }
    }
    for (const b of bytes) if (b >= 0x80) this.c.fail(`${what} must be modified UTF-7 (8-bit names need ENABLE IMAP4rev2)`);
    const decoded = decodeMailboxName(bytes.toString('latin1'));
    if (decoded === null) this.c.fail(`${what} is not valid modified UTF-7`);
    return decoded;
  }

  mailbox(): string {
    const name = this.name(this.c.astring(), 'mailbox name');
    return name.toUpperCase() === 'INBOX' ? 'INBOX' : name;
  }

  listMailbox(): string {
    const c = this.c.peek();
    const bytes = c === Ch.DQUOTE || c === Ch.LBRACE ? this.c.string() : this.c.run(isListChar, 'a mailbox pattern');
    return this.name(bytes, 'mailbox pattern');
  }

  sequenceSet(): SequenceSet {
    const text = this.c.run(isSeqChar, 'a sequence set').toString('latin1');
    const set = parseSequenceSet(text);
    if (!set) this.c.fail(`invalid sequence set "${text}"`);
    return set;
  }

  flag(): string {
    if (this.c.maybe(Ch.BACKSLASH)) {
      if (this.c.is(Ch.STAR)) this.c.fail('\\* is not a flag');
      return canonicalFlag(`\\${this.c.atom()}`);
    }
    return this.c.atom();
  }

  flagList(): string[] {
    this.c.take(Ch.LPAREN, '(');
    const flags: string[] = [];
    if (!this.c.maybe(Ch.RPAREN)) {
      flags.push(this.flag());
      while (this.c.maybe(Ch.SP)) flags.push(this.flag());
      this.c.take(Ch.RPAREN, ')');
    }
    return flags;
  }

  month(): number {
    const m = MONTHS.indexOf(this.c.buf.toString('latin1', this.c.pos, this.c.pos + 3).toUpperCase());
    if (m < 0) this.c.fail('expected a month (Jan–Dec)');
    this.c.pos += 3;
    return m + 1;
  }

  digits(min: number, max: number, what: string): number {
    const start = this.c.pos;
    while (this.c.pos - start < max && isDigit(this.c.peek())) this.c.pos++;
    if (this.c.pos - start < min) this.c.fail(`expected ${what}`);
    return Number(this.c.buf.toString('latin1', start, this.c.pos));
  }

  dateText(): ImapDate {
    const day = this.digits(1, 2, 'a day');
    this.c.take(Ch.MINUS, '-');
    const month = this.month();
    this.c.take(Ch.MINUS, '-');
    const year = this.digits(4, 4, 'a four-digit year');
    if (day < 1 || day > 31) this.c.fail('day out of range');
    return { year, month, day };
  }

  /** search date: date-text or "date-text". */
  date(): ImapDate {
    if (this.c.maybe(Ch.DQUOTE)) {
      const d = this.dateText();
      this.c.take(Ch.DQUOTE, '"');
      return d;
    }
    return this.dateText();
  }

  dateTime(): ImapDateTime {
    this.c.take(Ch.DQUOTE, '"');
    this.c.maybe(Ch.SP); // date-day-fixed: SP DIGIT
    const { year, month, day } = this.dateText();
    this.c.take(Ch.SP, 'SP');
    const hour = this.digits(2, 2, 'hours');
    this.c.take(Ch.COLON, ':');
    const minute = this.digits(2, 2, 'minutes');
    this.c.take(Ch.COLON, ':');
    const second = this.digits(2, 2, 'seconds');
    this.c.take(Ch.SP, 'SP');
    const sign = this.c.peek();
    if (sign !== Ch.PLUS && sign !== Ch.MINUS) this.c.fail('expected a zone (+hhmm or -hhmm)');
    this.c.pos++;
    const zh = this.digits(2, 2, 'zone hours');
    const zm = this.digits(2, 2, 'zone minutes');
    this.c.take(Ch.DQUOTE, '"');
    if (hour > 23 || minute > 59 || second > 60 || zm > 59) this.c.fail('time out of range');
    // `|| 0`: "-0000" is zone 0, not -0.
    const zone = (zh * 60 + zm) * (sign === Ch.MINUS ? -1 : 1) || 0;
    return { year, month, day, hour, minute, second, zone };
  }

  parenList<T>(item: () => T, allowEmpty: boolean): T[] {
    this.c.take(Ch.LPAREN, '(');
    const out: T[] = [];
    if (this.c.maybe(Ch.RPAREN)) {
      if (!allowEmpty) this.c.fail('empty list');
      return out;
    }
    out.push(item());
    while (this.c.maybe(Ch.SP)) out.push(item());
    this.c.take(Ch.RPAREN, ')');
    return out;
  }

  oneOf<T extends string>(allowed: readonly T[], what: string): T {
    const w = this.c.word(what);
    const found = allowed.find((a) => a === w);
    if (found === undefined) this.c.fail(`unknown ${what} ${w}`);
    return found;
  }

  statusAtt(): StatusAtt {
    return this.oneOf(STATUS_ATTS, 'status item');
  }

  // --- commands ------------------------------------------------------------------------------

  command(): Command {
    const tag = this.tag();
    this.c.sp();
    const name = this.c.word('a command');
    return this.dispatch(tag, name);
  }

  dispatch(tag: string, name: string): Command {
    const c = this.c;
    switch (name) {
      case 'CAPABILITY':
      case 'NOOP':
      case 'LOGOUT':
      case 'STARTTLS':
      case 'IDLE':
      case 'CLOSE':
      case 'UNSELECT':
      case 'NAMESPACE':
      case 'CHECK':
      case 'EXPUNGE':
        c.end();
        return { tag, name };
      case 'AUTHENTICATE': {
        c.sp();
        const mechanism = c.atom().toUpperCase();
        let initialResponse: string | null = null;
        if (c.maybe(Ch.SP)) {
          if (c.maybe(0x3d) && c.eof()) {
            initialResponse = '';
          } else {
            const b64 = c.run((x) => x !== Ch.SP, 'an initial response').toString('latin1');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) c.fail('initial response is not base64');
            initialResponse = b64;
          }
        }
        c.end();
        return { tag, name, mechanism, initialResponse };
      }
      case 'LOGIN': {
        c.sp();
        const username = this.text(c.astring());
        c.sp();
        const password = this.text(c.astring());
        c.end();
        return { tag, name, username, password };
      }
      case 'ENABLE': {
        const capabilities: string[] = [];
        c.sp();
        capabilities.push(c.atom().toUpperCase());
        while (c.maybe(Ch.SP)) capabilities.push(c.atom().toUpperCase());
        c.end();
        return { tag, name, capabilities };
      }
      case 'SELECT':
      case 'EXAMINE':
        return this.select(tag, name);
      case 'CREATE': {
        c.sp();
        const mailbox = this.mailbox();
        let specialUse: string[] | null = null;
        if (c.maybe(Ch.SP)) {
          c.take(Ch.LPAREN, '(');
          if (!c.keywordIs('USE')) c.fail('unknown CREATE parameter');
          c.sp();
          specialUse = this.parenList(() => {
            c.take(Ch.BACKSLASH, 'a special-use attribute');
            return canonicalFlag(`\\${c.atom()}`);
          }, true);
          c.take(Ch.RPAREN, ')');
        }
        c.end();
        return { tag, name, mailbox, specialUse };
      }
      case 'DELETE':
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE': {
        c.sp();
        const mailbox = this.mailbox();
        c.end();
        return { tag, name, mailbox };
      }
      case 'RENAME': {
        c.sp();
        const from = this.mailbox();
        c.sp();
        const to = this.mailbox();
        c.end();
        return { tag, name, from, to };
      }
      case 'LIST':
        return this.list(tag);
      case 'LSUB': {
        c.sp();
        const reference = this.name(c.astring(), 'reference');
        c.sp();
        const pattern = this.listMailbox();
        c.end();
        return { tag, name, reference, pattern };
      }
      case 'STATUS': {
        c.sp();
        const mailbox = this.mailbox();
        c.sp();
        const items = this.parenList(() => this.statusAtt(), false);
        c.end();
        return { tag, name, mailbox, items };
      }
      case 'APPEND': {
        const head = this.appendHead();
        const lit = c.literal(true);
        c.end();
        return {
          tag,
          name,
          ...head,
          message: { size: lit.data.length, binary: lit.binary, data: Buffer.from(lit.data) },
        };
      }
      case 'SEARCH':
        return this.search(tag, false);
      case 'FETCH':
        return this.fetch(tag, false);
      case 'STORE':
        return this.store(tag, false);
      case 'COPY':
      case 'MOVE':
        return this.copy(tag, name, false);
      case 'ID':
        return this.id(tag);
      case 'UID': {
        c.sp();
        const sub = c.word('a UID command');
        switch (sub) {
          case 'SEARCH':
            return this.search(tag, true);
          case 'FETCH':
            return this.fetch(tag, true);
          case 'STORE':
            return this.store(tag, true);
          case 'COPY':
          case 'MOVE':
            return this.copy(tag, sub, true);
          case 'EXPUNGE': {
            c.sp();
            const set = this.sequenceSet();
            c.end();
            return { tag, name: 'UID EXPUNGE', set };
          }
          default:
            return c.fail(`unknown UID command ${sub}`);
        }
      }
      default:
        return c.fail(`unknown command ${name}`);
    }
  }

  select(tag: string, name: 'SELECT' | 'EXAMINE'): Command {
    const c = this.c;
    c.sp();
    const mailbox = this.mailbox();
    let condstore = false;
    let qresync: QresyncParams | null = null;
    if (c.maybe(Ch.SP)) {
      this.parenList(() => {
        const w = c.word('a select parameter');
        if (w === 'CONDSTORE') {
          condstore = true;
        } else if (w === 'QRESYNC') {
          c.sp();
          c.take(Ch.LPAREN, '(');
          const uidValidity = c.nzNumber();
          c.sp();
          const modseq = c.modseq(false);
          let knownUids: SequenceSet | null = null;
          let seqMatch: QresyncParams['seqMatch'] = null;
          if (c.maybe(Ch.SP)) {
            if (!c.is(Ch.LPAREN)) {
              knownUids = this.sequenceSet();
              if (c.maybe(Ch.SP)) seqMatch = this.seqMatch();
            } else {
              seqMatch = this.seqMatch();
            }
          }
          c.take(Ch.RPAREN, ')');
          qresync = { uidValidity, modseq, knownUids, seqMatch };
        } else {
          c.fail(`unknown select parameter ${w}`);
        }
        return w;
      }, false);
    }
    c.end();
    return { tag, name, mailbox, condstore, qresync };
  }

  seqMatch(): { seqs: SequenceSet; uids: SequenceSet } {
    this.c.take(Ch.LPAREN, '(');
    const seqs = this.sequenceSet();
    this.c.sp();
    const uids = this.sequenceSet();
    this.c.take(Ch.RPAREN, ')');
    return { seqs, uids };
  }

  list(tag: string): Command {
    const c = this.c;
    c.sp();
    let selection: ListSelectOpt[] | null = null;
    if (c.is(Ch.LPAREN)) {
      selection = this.parenList(() => this.oneOf(LIST_SELECT_OPTS, 'LIST selection option'), true);
      if (selection.includes('RECURSIVEMATCH') && !selection.some((o) => o === 'SUBSCRIBED' || o === 'SPECIAL-USE')) {
        c.fail('RECURSIVEMATCH needs another selection option');
      }
      c.sp();
    }
    const reference = this.name(c.astring(), 'reference');
    c.sp();
    const patterns = c.is(Ch.LPAREN) ? this.parenList(() => this.listMailbox(), false) : [this.listMailbox()];
    let returnOpts: ListReturnOpt[] | null = null;
    if (c.maybe(Ch.SP)) {
      if (!c.keywordIs('RETURN')) c.fail('expected RETURN');
      c.sp();
      returnOpts = this.parenList((): ListReturnOpt => {
        const w = c.word('a LIST return option');
        if (w === 'SUBSCRIBED' || w === 'CHILDREN' || w === 'SPECIAL-USE') return { type: w };
        if (w === 'STATUS') {
          c.sp();
          return { type: 'STATUS', items: this.parenList(() => this.statusAtt(), false) };
        }
        return c.fail(`unknown LIST return option ${w}`);
      }, true);
    }
    c.end();
    return { tag, name: 'LIST', selection, reference, patterns, returnOpts };
  }

  appendHead(): { mailbox: string; flags: string[] | null; date: ImapDateTime | null } {
    const c = this.c;
    c.sp();
    const mailbox = this.mailbox();
    c.sp();
    let flags: string[] | null = null;
    let date: ImapDateTime | null = null;
    if (c.is(Ch.LPAREN)) {
      flags = this.flagList();
      c.sp();
    }
    if (c.is(Ch.DQUOTE)) {
      date = this.dateTime();
      c.sp();
    }
    return { mailbox, flags, date };
  }

  search(tag: string, uid: boolean): Command {
    const c = this.c;
    c.sp();
    let returnOpts: SearchReturnOpt[] | null = null;
    let charset: string | null = null;
    if (c.keywordIs('RETURN')) {
      c.sp();
      returnOpts = this.parenList(() => this.oneOf(SEARCH_RETURN_OPTS, 'SEARCH return option'), true);
      c.sp();
    }
    if (c.keywordIs('CHARSET')) {
      c.sp();
      charset = c.astring().toString('latin1');
      c.sp();
    }
    const criteria = [this.searchKey()];
    while (c.maybe(Ch.SP)) criteria.push(this.searchKey());
    c.end();
    return { tag, name: 'SEARCH', uid, returnOpts, charset, criteria };
  }

  searchKey(): SearchKey {
    const c = this.c;
    if (++this.depth > this.maxSearchDepth) c.fail(`search keys nested deeper than ${this.maxSearchDepth}`);
    let key: SearchKey;
    const first = c.peek();
    if (first === Ch.LPAREN) {
      if (++this.nesting > this.maxNesting) c.fail(`parentheses nested deeper than ${this.maxNesting}`);
      c.pos++;
      const keys = [this.searchKey()];
      while (c.maybe(Ch.SP)) keys.push(this.searchKey());
      c.take(Ch.RPAREN, ')');
      this.nesting--;
      key = { type: 'AND', keys };
    } else if (isDigit(first) || first === Ch.STAR || first === Ch.DOLLAR) {
      key = { type: 'SEQ', set: this.sequenceSet() };
    } else {
      key = this.namedSearchKey(c.word('a search key'));
    }
    this.depth--;
    return key;
  }

  namedSearchKey(w: string): SearchKey {
    const c = this.c;
    const flagKey = SEARCH_FLAG_KEYS.find((k) => k === w);
    if (flagKey) return { type: flagKey };
    const stringKey = SEARCH_STRING_KEYS.find((k) => k === w);
    if (stringKey) {
      c.sp();
      return { type: stringKey, value: this.text(c.astring()) };
    }
    const dateKey = SEARCH_DATE_KEYS.find((k) => k === w);
    if (dateKey) {
      c.sp();
      return { type: dateKey, date: this.date() };
    }
    switch (w) {
      case 'KEYWORD':
      case 'UNKEYWORD':
        c.sp();
        return { type: w, flag: c.atom() };
      case 'LARGER':
      case 'SMALLER':
        c.sp();
        return { type: w, size: c.number() };
      case 'HEADER': {
        c.sp();
        const field = this.text(c.astring());
        c.sp();
        return { type: 'HEADER', field, value: this.text(c.astring()) };
      }
      case 'UID':
        c.sp();
        return { type: 'UID', set: this.sequenceSet() };
      case 'NOT':
        c.sp();
        return { type: 'NOT', key: this.searchKey() };
      case 'OR': {
        c.sp();
        const left = this.searchKey();
        c.sp();
        return { type: 'OR', left, right: this.searchKey() };
      }
      case 'MODSEQ': {
        c.sp();
        let entry: Extract<SearchKey, { type: 'MODSEQ' }>['entry'] = null;
        if (c.is(Ch.DQUOTE)) {
          const entryName = c.quoted().toString('latin1');
          c.sp();
          const t = c.word('priv, shared or all');
          if (t !== 'PRIV' && t !== 'SHARED' && t !== 'ALL') c.fail('entry type must be priv, shared or all');
          entry = { name: entryName, entryType: t.toLowerCase() as 'priv' | 'shared' | 'all' };
          c.sp();
        }
        return { type: 'MODSEQ', entry, modseq: c.modseq(true) };
      }
      default:
        return c.fail(`unknown search key ${w}`);
    }
  }

  fetch(tag: string, uid: boolean): Command {
    const c = this.c;
    c.sp();
    const set = this.sequenceSet();
    c.sp();
    let macro: FetchMacro | null = null;
    let items: FetchAtt[] = [];
    if (c.is(Ch.LPAREN)) {
      items = this.parenList(() => this.fetchAtt(), false);
    } else {
      const at = c.pos;
      const w = c.word('a fetch item');
      if (w === 'ALL' || w === 'FAST' || w === 'FULL') {
        macro = w;
      } else {
        c.pos = at;
        items = [this.fetchAtt()];
      }
    }
    const mods: { changedSince: bigint | null; vanished: boolean } = { changedSince: null, vanished: false };
    if (c.maybe(Ch.SP)) {
      this.parenList(() => {
        const w = c.word('a fetch modifier');
        if (w === 'CHANGEDSINCE') {
          c.sp();
          mods.changedSince = c.modseq(false);
        } else if (w === 'VANISHED') {
          mods.vanished = true;
        } else {
          c.fail(`unknown fetch modifier ${w}`);
        }
        return w;
      }, false);
    }
    c.end();
    if (mods.vanished && !uid) c.fail('VANISHED is only allowed in UID FETCH');
    if (mods.vanished && mods.changedSince === null) c.fail('VANISHED requires CHANGEDSINCE');
    return { tag, name: 'FETCH', uid, set, macro, items, changedSince: mods.changedSince, vanished: mods.vanished };
  }

  fetchAtt(): FetchAtt {
    const c = this.c;
    const w = c.word('a fetch item');
    switch (w) {
      case 'ENVELOPE':
      case 'FLAGS':
      case 'INTERNALDATE':
      case 'RFC822':
      case 'RFC822.HEADER':
      case 'RFC822.SIZE':
      case 'RFC822.TEXT':
      case 'BODYSTRUCTURE':
      case 'UID':
      case 'MODSEQ':
        return { type: w };
      case 'BODY':
        if (!c.is(Ch.LBRACKET)) return { type: 'BODY' };
        return { type: 'BODY[]', peek: false, section: this.section(), partial: this.partial() };
      case 'BODY.PEEK':
        return { type: 'BODY[]', peek: true, section: this.section(), partial: this.partial() };
      case 'BINARY':
      case 'BINARY.PEEK':
        return { type: 'BINARY[]', peek: w === 'BINARY.PEEK', part: this.sectionBinary(), partial: this.partial() };
      case 'BINARY.SIZE':
        return { type: 'BINARY.SIZE', part: this.sectionBinary() };
      default:
        return c.fail(`unknown fetch item ${w}`);
    }
  }

  sectionPart(): number[] {
    const part = [this.c.nzNumber()];
    while (this.c.is(Ch.DOT) && isDigit(this.c.peek(1))) {
      this.c.pos++;
      part.push(this.c.nzNumber());
    }
    return part;
  }

  section(): Section {
    const c = this.c;
    c.take(Ch.LBRACKET, '[');
    let part: number[] = [];
    let text: SectionText | null = null;
    let fields: string[] = [];
    if (!c.is(Ch.RBRACKET)) {
      if (isDigit(c.peek())) {
        part = this.sectionPart();
        if (c.maybe(Ch.DOT)) text = this.sectionText(true);
      } else {
        text = this.sectionText(false);
      }
      if (text === 'HEADER.FIELDS' || text === 'HEADER.FIELDS.NOT') {
        c.sp();
        fields = this.parenList(() => c.astring().toString('latin1'), false);
      }
    }
    c.take(Ch.RBRACKET, ']');
    return { part, text, fields };
  }

  sectionText(afterPart: boolean): SectionText {
    const w = this.c.word('a section');
    if (w === 'HEADER' || w === 'HEADER.FIELDS' || w === 'HEADER.FIELDS.NOT' || w === 'TEXT') return w;
    if (w === 'MIME' && afterPart) return w;
    return this.c.fail(`invalid section ${w}`);
  }

  sectionBinary(): number[] {
    this.c.take(Ch.LBRACKET, '[');
    const part = this.c.is(Ch.RBRACKET) ? [] : this.sectionPart();
    this.c.take(Ch.RBRACKET, ']');
    return part;
  }

  partial(): PartialRange | null {
    const c = this.c;
    if (!c.maybe(Ch.LT)) return null;
    const offset = c.number();
    c.take(Ch.DOT, '.');
    const length = c.nzNumber();
    c.take(Ch.GT, '>');
    return { offset, length };
  }

  store(tag: string, uid: boolean): Command {
    const c = this.c;
    c.sp();
    const set = this.sequenceSet();
    c.sp();
    let unchangedSince: bigint | null = null;
    if (c.is(Ch.LPAREN)) {
      this.parenList(() => {
        if (!c.keywordIs('UNCHANGEDSINCE')) c.fail('unknown store modifier');
        c.sp();
        unchangedSince = c.modseq(true);
        return true;
      }, false);
      c.sp();
    }
    let operation: StoreOperation = 'set';
    if (c.maybe(Ch.PLUS)) operation = 'add';
    else if (c.maybe(Ch.MINUS)) operation = 'remove';
    const w = c.word('FLAGS or FLAGS.SILENT');
    if (w !== 'FLAGS' && w !== 'FLAGS.SILENT') c.fail(`expected FLAGS or FLAGS.SILENT, got ${w}`);
    c.sp();
    let flags: string[];
    if (c.is(Ch.LPAREN)) {
      flags = this.flagList();
    } else {
      flags = [this.flag()];
      while (c.maybe(Ch.SP)) flags.push(this.flag());
    }
    c.end();
    return { tag, name: 'STORE', uid, set, unchangedSince, operation, silent: w === 'FLAGS.SILENT', flags };
  }

  copy(tag: string, name: 'COPY' | 'MOVE', uid: boolean): Command {
    this.c.sp();
    const set = this.sequenceSet();
    this.c.sp();
    const mailbox = this.mailbox();
    this.c.end();
    return { tag, name, uid, set, mailbox };
  }

  id(tag: string): Command {
    const c = this.c;
    c.sp();
    let params: [string, string | null][] | null = null;
    if (!c.keywordIs('NIL')) {
      params = this.parenList((): [string, string | null] => {
        const key = this.text(c.string());
        c.sp();
        const value = c.nstring();
        return [key, value === null ? null : this.text(value)];
      }, false);
      if (params.length > MAX_ID_PAIRS) c.fail(`more than ${MAX_ID_PAIRS} ID fields`);
    }
    c.end();
    return { tag, name: 'ID', params };
  }
}

function failure(err: unknown, buf: Buffer): { ok: false; tag: string | null; message: string; position: number } {
  if (!(err instanceof SyntaxFail)) throw err;
  const c = new Cursor(buf);
  let tag: string | null = null;
  const start = c.pos;
  while (isTagChar(c.peek())) c.pos++;
  if (c.pos > start && c.is(Ch.SP)) tag = buf.toString('latin1', start, c.pos);
  return { ok: false, tag, message: err.message, position: err.position };
}

function asBuffer(input: Uint8Array | string): Buffer {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.length);
}

/**
 * Parse one command. `input` is what the reader's `command` event carries: the wire bytes without
 * the final CRLF, literals inline after their `{n}` CRLF.
 */
export function parseCommand(input: Uint8Array | string, options: ParseOptions = {}): ParseResult {
  const buf = asBuffer(input);
  const p = new CommandParser(buf, options);
  try {
    return { ok: true, command: p.command() };
  } catch (err) {
    return failure(err, buf);
  }
}

/**
 * Parse the `prefix` of an `append-begin` event: "tag APPEND mailbox [flags] [date-time] {n}" (the
 * literal marker, without CRLF, ends it). The message bytes follow as `append-data` events.
 */
export function parseAppendPrefix(input: Uint8Array | string, options: ParseOptions = {}): AppendPrefixResult {
  const buf = asBuffer(input);
  const p = new CommandParser(buf, options);
  const c = p.c;
  try {
    const tag = p.tag();
    c.sp();
    if (c.word('a command') !== 'APPEND') c.fail('not an APPEND command');
    const head = p.appendHead();
    const binary = c.maybe(Ch.TILDE);
    c.take(Ch.LBRACE, '{');
    const size = c.number();
    const nonSync = c.maybe(Ch.PLUS);
    c.take(Ch.RBRACE, '}');
    c.end();
    return { ok: true, tag, ...head, size, binary, synchronizing: !nonSync };
  } catch (err) {
    return failure(err, buf);
  }
}

/** IDLE ends with a line reading DONE (case-insensitive). */
export function isIdleDone(line: Uint8Array): boolean {
  return line.length === 4 && Buffer.from(line.buffer, line.byteOffset, 4).toString('latin1').toUpperCase() === 'DONE';
}

export type SaslResponse = { readonly type: 'cancel' } | { readonly type: 'data'; readonly data: Buffer } | { readonly type: 'invalid' };

/** A client's AUTHENTICATE continuation line: base64, or "*" to cancel (RFC 3501 §6.2.2). */
export function parseSaslResponse(line: Uint8Array): SaslResponse {
  const text = Buffer.from(line.buffer, line.byteOffset, line.length).toString('latin1');
  if (text === '*') return { type: 'cancel' };
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return { type: 'invalid' };
  return { type: 'data', data: Buffer.from(text, 'base64') };
}
