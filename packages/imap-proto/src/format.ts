// Command formatter: a typed `Command` to its wire form (client side). The inverse of
// `parseCommand` — the fast-check round trip rests on it — and what the IMAP import client
// (PST-T-10.2) sends. Strings are sent as atoms when they can be, quoted when that is safe, and as
// literals otherwise (non-synchronizing when `literalPlus` and ≤ 4096 octets, RFC 7888 LITERAL-).

import type { Command, FetchAtt, ImapDate, ImapDateTime, ListReturnOpt, PartialRange, SearchKey, Section } from './ast.js';
import { isAstringChar, isAtomChar, isListChar } from './lexer.js';
import { encodeMailboxName } from './mutf7.js';
import { LITERAL_MINUS_MAX } from './reader.js';
import { formatSequenceSet } from './sequence.js';

export interface FormatOptions {
  /** Send mailbox names as UTF-8 (after ENABLE IMAP4rev2 / UTF8=ACCEPT) instead of modified UTF-7. */
  readonly utf8?: boolean;
  /** The server advertises LITERAL+ or LITERAL-: send small literals non-synchronizing. */
  readonly literalPlus?: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Longer strings go as literals even when they could be quoted. */
export const MAX_QUOTED = 1024;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatDate(d: ImapDate): string {
  return `${d.day}-${MONTH_NAMES[d.month - 1] ?? 'Jan'}-${pad(d.year, 4)}`;
}

/** "dd-Mon-yyyy hh:mm:ss +zzzz" with the day space-padded, without the quotes. */
export function formatDateTime(d: ImapDateTime): string {
  const sign = d.zone < 0 ? '-' : '+';
  const z = Math.abs(d.zone);
  const day = d.day < 10 ? ` ${d.day}` : String(d.day);
  return (
    `${day}-${MONTH_NAMES[d.month - 1] ?? 'Jan'}-${pad(d.year, 4)} ` +
    `${pad(d.hour, 2)}:${pad(d.minute, 2)}:${pad(d.second, 2)} ${sign}${pad(Math.floor(z / 60), 2)}${pad(z % 60, 2)}`
  );
}

/** Whether `bytes` can travel as a quoted string. */
export function canQuote(bytes: Uint8Array, utf8: boolean): boolean {
  if (bytes.length > MAX_QUOTED) return false;
  for (const b of bytes) {
    if (b === 0 || b === 0x0a || b === 0x0d) return false;
    if (b >= 0x80 && !utf8) return false;
  }
  if (utf8) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return false;
    }
  }
  return true;
}

export function quote(bytes: Uint8Array): Buffer {
  const out: number[] = [0x22];
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x22);
  return Buffer.from(out);
}

function toBytes(v: string | Uint8Array): Buffer {
  return typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v);
}

class Wire {
  readonly parts: Buffer[] = [];

  constructor(readonly o: FormatOptions) {}

  t(s: string): this {
    this.parts.push(Buffer.from(s, 'latin1'));
    return this;
  }

  literal(bytes: Buffer, binary = false): this {
    const plus = this.o.literalPlus === true && bytes.length <= LITERAL_MINUS_MAX ? '+' : '';
    this.parts.push(Buffer.from(`${binary ? '~' : ''}{${bytes.length}${plus}}\r\n`, 'latin1'), bytes);
    return this;
  }

  string(v: string | Uint8Array): this {
    const bytes = toBytes(v);
    if (canQuote(bytes, true)) this.parts.push(quote(bytes));
    else this.literal(bytes);
    return this;
  }

  /** An atom when every octet allows it (and it is not "NIL" where that matters), else a string. */
  astring(v: string | Uint8Array, pred: (c: number) => boolean = isAstringChar): this {
    const bytes = toBytes(v);
    if (bytes.length > 0 && bytes.every(pred) && bytes.toString('latin1').toUpperCase() !== 'NIL') {
      this.parts.push(bytes);
      return this;
    }
    return this.string(bytes);
  }

  nstring(v: string | null): this {
    return v === null ? this.t('NIL') : this.string(v);
  }

  nameBytes(name: string): Buffer {
    return this.o.utf8 === true ? Buffer.from(name, 'utf8') : Buffer.from(encodeMailboxName(name), 'latin1');
  }

  mailbox(name: string): this {
    return this.astring(this.nameBytes(name));
  }

  pattern(name: string): this {
    return this.astring(this.nameBytes(name), isListChar);
  }

  list<T>(items: readonly T[], each: (item: T) => void): this {
    this.t('(');
    items.forEach((item, i) => {
      if (i > 0) this.t(' ');
      each(item);
    });
    return this.t(')');
  }

  flags(flags: readonly string[]): this {
    return this.list(flags, (f) => this.t(f));
  }
}

function formatSection(w: Wire, s: Section): void {
  w.t(`[${s.part.join('.')}`);
  if (s.text !== null) {
    w.t(`${s.part.length > 0 ? '.' : ''}${s.text}`);
    if (s.text === 'HEADER.FIELDS' || s.text === 'HEADER.FIELDS.NOT') {
      w.t(' ').list(s.fields, (f) => w.astring(Buffer.from(f, 'latin1')));
    }
  }
  w.t(']');
}

function formatPartial(w: Wire, p: PartialRange | null): void {
  if (p) w.t(`<${p.offset}.${p.length}>`);
}

function formatFetchAtt(w: Wire, a: FetchAtt): void {
  switch (a.type) {
    case 'BODY[]':
      w.t(a.peek ? 'BODY.PEEK' : 'BODY');
      formatSection(w, a.section);
      formatPartial(w, a.partial);
      return;
    case 'BINARY[]':
      w.t(`${a.peek ? 'BINARY.PEEK' : 'BINARY'}[${a.part.join('.')}]`);
      formatPartial(w, a.partial);
      return;
    case 'BINARY.SIZE':
      w.t(`BINARY.SIZE[${a.part.join('.')}]`);
      return;
    default:
      w.t(a.type);
  }
}

function formatSearchKey(w: Wire, k: SearchKey): void {
  switch (k.type) {
    case 'BCC':
    case 'BODY':
    case 'CC':
    case 'FROM':
    case 'SUBJECT':
    case 'TEXT':
    case 'TO':
      w.t(`${k.type} `).astring(k.value);
      return;
    case 'BEFORE':
    case 'ON':
    case 'SINCE':
    case 'SENTBEFORE':
    case 'SENTON':
    case 'SENTSINCE':
      w.t(`${k.type} ${formatDate(k.date)}`);
      return;
    case 'KEYWORD':
    case 'UNKEYWORD':
      w.t(`${k.type} ${k.flag}`);
      return;
    case 'LARGER':
    case 'SMALLER':
      w.t(`${k.type} ${k.size}`);
      return;
    case 'HEADER':
      w.t('HEADER ').astring(k.field).t(' ').astring(k.value);
      return;
    case 'UID':
      w.t(`UID ${formatSequenceSet(k.set)}`);
      return;
    case 'SEQ':
      w.t(formatSequenceSet(k.set));
      return;
    case 'NOT':
      w.t('NOT ');
      formatSearchKey(w, k.key);
      return;
    case 'OR':
      w.t('OR ');
      formatSearchKey(w, k.left);
      w.t(' ');
      formatSearchKey(w, k.right);
      return;
    case 'AND':
      w.list(k.keys, (x) => {
        formatSearchKey(w, x);
      });
      return;
    case 'MODSEQ':
      w.t('MODSEQ ');
      if (k.entry) {
        w.parts.push(quote(Buffer.from(k.entry.name, 'latin1')));
        w.t(` ${k.entry.entryType} `);
      }
      w.t(String(k.modseq));
      return;
    default:
      w.t(k.type);
  }
}

function formatListReturn(w: Wire, o: ListReturnOpt): void {
  if (o.type === 'STATUS') w.t('STATUS ').list(o.items, (i) => w.t(i));
  else w.t(o.type);
}

/** Wire bytes for a command, without the final CRLF (append "\r\n" to send it). */
export function formatCommand(cmd: Command, options: FormatOptions = {}): Buffer {
  const w = new Wire(options);
  w.t(`${cmd.tag} `);
  const uid = (u: boolean): string => (u ? 'UID ' : '');
  switch (cmd.name) {
    case 'AUTHENTICATE':
      w.t(`AUTHENTICATE ${cmd.mechanism}`);
      if (cmd.initialResponse !== null) w.t(` ${cmd.initialResponse === '' ? '=' : cmd.initialResponse}`);
      break;
    case 'LOGIN':
      w.t('LOGIN ').astring(cmd.username).t(' ').astring(cmd.password);
      break;
    case 'ENABLE':
      w.t(`ENABLE ${cmd.capabilities.join(' ')}`);
      break;
    case 'SELECT':
    case 'EXAMINE': {
      w.t(`${cmd.name} `).mailbox(cmd.mailbox);
      const params: (() => void)[] = [];
      if (cmd.condstore) params.push(() => w.t('CONDSTORE'));
      const q = cmd.qresync;
      if (q) {
        params.push(() => {
          w.t(`QRESYNC (${q.uidValidity} ${q.modseq}`);
          if (q.knownUids) w.t(` ${formatSequenceSet(q.knownUids)}`);
          if (q.seqMatch) w.t(` (${formatSequenceSet(q.seqMatch.seqs)} ${formatSequenceSet(q.seqMatch.uids)})`);
          w.t(')');
        });
      }
      if (params.length > 0) {
        w.t(' ').list(params, (p) => {
          p();
        });
      }
      break;
    }
    case 'CREATE':
      w.t('CREATE ').mailbox(cmd.mailbox);
      if (cmd.specialUse) w.t(' (USE ').flags(cmd.specialUse).t(')');
      break;
    case 'DELETE':
    case 'SUBSCRIBE':
    case 'UNSUBSCRIBE':
      w.t(`${cmd.name} `).mailbox(cmd.mailbox);
      break;
    case 'RENAME':
      w.t('RENAME ').mailbox(cmd.from).t(' ').mailbox(cmd.to);
      break;
    case 'LIST':
      w.t('LIST ');
      if (cmd.selection) w.list(cmd.selection, (s) => w.t(s)).t(' ');
      w.astring(w.nameBytes(cmd.reference)).t(' ');
      if (cmd.patterns.length === 1 && cmd.patterns[0] !== undefined) w.pattern(cmd.patterns[0]);
      else w.list(cmd.patterns, (p) => w.pattern(p));
      if (cmd.returnOpts) w.t(' RETURN ').list(cmd.returnOpts, (o) => {
        formatListReturn(w, o);
      });
      break;
    case 'LSUB':
      w.t('LSUB ').astring(w.nameBytes(cmd.reference)).t(' ').pattern(cmd.pattern);
      break;
    case 'STATUS':
      w.t('STATUS ').mailbox(cmd.mailbox).t(' ').list(cmd.items, (i) => w.t(i));
      break;
    case 'APPEND':
      w.t('APPEND ').mailbox(cmd.mailbox).t(' ');
      if (cmd.flags) w.flags(cmd.flags).t(' ');
      if (cmd.date) w.t(`"${formatDateTime(cmd.date)}" `);
      w.literal(cmd.message.data ?? Buffer.alloc(0), cmd.message.binary);
      break;
    case 'SEARCH':
      w.t(`${uid(cmd.uid)}SEARCH `);
      if (cmd.returnOpts) w.t('RETURN ').list(cmd.returnOpts, (o) => w.t(o)).t(' ');
      if (cmd.charset !== null) w.t('CHARSET ').astring(Buffer.from(cmd.charset, 'latin1')).t(' ');
      cmd.criteria.forEach((k, i) => {
        if (i > 0) w.t(' ');
        formatSearchKey(w, k);
      });
      break;
    case 'FETCH':
      w.t(`${uid(cmd.uid)}FETCH ${formatSequenceSet(cmd.set)} `);
      if (cmd.macro) w.t(cmd.macro);
      else w.list(cmd.items, (a) => {
        formatFetchAtt(w, a);
      });
      if (cmd.changedSince !== null) w.t(` (CHANGEDSINCE ${cmd.changedSince}${cmd.vanished ? ' VANISHED' : ''})`);
      break;
    case 'STORE': {
      w.t(`${uid(cmd.uid)}STORE ${formatSequenceSet(cmd.set)} `);
      if (cmd.unchangedSince !== null) w.t(`(UNCHANGEDSINCE ${cmd.unchangedSince}) `);
      const op = cmd.operation === 'add' ? '+' : cmd.operation === 'remove' ? '-' : '';
      w.t(`${op}FLAGS${cmd.silent ? '.SILENT' : ''} `).flags(cmd.flags);
      break;
    }
    case 'COPY':
    case 'MOVE':
      w.t(`${uid(cmd.uid)}${cmd.name} ${formatSequenceSet(cmd.set)} `).mailbox(cmd.mailbox);
      break;
    case 'UID EXPUNGE':
      w.t(`UID EXPUNGE ${formatSequenceSet(cmd.set)}`);
      break;
    case 'ID':
      w.t('ID ');
      if (cmd.params === null) w.t('NIL');
      else w.list(cmd.params, ([k, v]) => w.string(k).t(' ').nstring(v));
      break;
    default:
      w.t(cmd.name);
  }
  return Buffer.concat(w.parts);
}

/** Whether a string is safe to send as a bare atom. */
export function isAtomString(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) if (!isAtomChar(s.charCodeAt(i))) return false;
  return true;
}
