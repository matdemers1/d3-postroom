// The typed command AST the parser produces and the formatter consumes (PST-REQ-070).
//
// Absent optional parts are `null`, never missing, so a parsed command compares equal to the one it
// was formatted from. Mailbox names are decoded (modified UTF-7 under IMAP4rev1, UTF-8 once rev2 or
// UTF8=ACCEPT is enabled) and INBOX is canonicalised to upper case. Keywords and capability names
// are upper-cased; system flags are given their canonical spelling (`\Seen`); keywords keep theirs.

/** A message sequence number or UID; `'*'` is the largest one in use. */
export type SeqNumber = number | '*';

/** One element of a sequence set. A single number has `from === to`. Either order is legal. */
export interface SeqRange {
  readonly from: SeqNumber;
  readonly to: SeqNumber;
}

/** RFC 3501 sequence-set, or RFC 5182 `$` (the result saved by SEARCH RETURN (SAVE)). */
export type SequenceSet =
  | { readonly type: 'set'; readonly ranges: readonly SeqRange[] }
  | { readonly type: 'saved' };

export interface ImapDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

export interface ImapDateTime extends ImapDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Offset from UTC in minutes, e.g. -300 for "-0500". */
  readonly zone: number;
}

export type SectionText = 'HEADER' | 'HEADER.FIELDS' | 'HEADER.FIELDS.NOT' | 'TEXT' | 'MIME';

/** A BODY[...] section: `part` is the dotted part path (empty for the whole message). */
export interface Section {
  readonly part: readonly number[];
  readonly text: SectionText | null;
  /** Header field names for HEADER.FIELDS / HEADER.FIELDS.NOT (as given), otherwise empty. */
  readonly fields: readonly string[];
}

/** `<offset.length>` on BODY[] / BINARY[]. */
export interface PartialRange {
  readonly offset: number;
  readonly length: number;
}

export type SimpleFetchAtt =
  | 'ENVELOPE'
  | 'FLAGS'
  | 'INTERNALDATE'
  | 'RFC822'
  | 'RFC822.HEADER'
  | 'RFC822.SIZE'
  | 'RFC822.TEXT'
  | 'BODY'
  | 'BODYSTRUCTURE'
  | 'UID'
  | 'MODSEQ';

export type FetchAtt =
  | { readonly type: SimpleFetchAtt }
  | { readonly type: 'BODY[]'; readonly peek: boolean; readonly section: Section; readonly partial: PartialRange | null }
  | { readonly type: 'BINARY[]'; readonly peek: boolean; readonly part: readonly number[]; readonly partial: PartialRange | null }
  | { readonly type: 'BINARY.SIZE'; readonly part: readonly number[] };

export type FetchMacro = 'ALL' | 'FAST' | 'FULL';

export type StatusAtt =
  | 'MESSAGES'
  | 'RECENT'
  | 'UIDNEXT'
  | 'UIDVALIDITY'
  | 'UNSEEN'
  | 'DELETED'
  | 'SIZE'
  | 'HIGHESTMODSEQ'
  | 'APPENDLIMIT';

export const STATUS_ATTS: readonly StatusAtt[] = [
  'MESSAGES',
  'RECENT',
  'UIDNEXT',
  'UIDVALIDITY',
  'UNSEEN',
  'DELETED',
  'SIZE',
  'HIGHESTMODSEQ',
  'APPENDLIMIT',
];

export type SearchFlagKey =
  | 'ALL'
  | 'ANSWERED'
  | 'DELETED'
  | 'DRAFT'
  | 'FLAGGED'
  | 'NEW'
  | 'OLD'
  | 'RECENT'
  | 'SEEN'
  | 'UNANSWERED'
  | 'UNDELETED'
  | 'UNDRAFT'
  | 'UNFLAGGED'
  | 'UNSEEN';
export type SearchStringKey = 'BCC' | 'BODY' | 'CC' | 'FROM' | 'SUBJECT' | 'TEXT' | 'TO';
export type SearchDateKey = 'BEFORE' | 'ON' | 'SINCE' | 'SENTBEFORE' | 'SENTON' | 'SENTSINCE';

export const SEARCH_FLAG_KEYS: readonly SearchFlagKey[] = [
  'ALL',
  'ANSWERED',
  'DELETED',
  'DRAFT',
  'FLAGGED',
  'NEW',
  'OLD',
  'RECENT',
  'SEEN',
  'UNANSWERED',
  'UNDELETED',
  'UNDRAFT',
  'UNFLAGGED',
  'UNSEEN',
];
export const SEARCH_STRING_KEYS: readonly SearchStringKey[] = ['BCC', 'BODY', 'CC', 'FROM', 'SUBJECT', 'TEXT', 'TO'];
export const SEARCH_DATE_KEYS: readonly SearchDateKey[] = ['BEFORE', 'ON', 'SINCE', 'SENTBEFORE', 'SENTON', 'SENTSINCE'];

export type SearchKey =
  | { readonly type: SearchFlagKey }
  | { readonly type: SearchStringKey; readonly value: string }
  | { readonly type: SearchDateKey; readonly date: ImapDate }
  | { readonly type: 'KEYWORD' | 'UNKEYWORD'; readonly flag: string }
  | { readonly type: 'LARGER' | 'SMALLER'; readonly size: number }
  | { readonly type: 'HEADER'; readonly field: string; readonly value: string }
  | { readonly type: 'UID'; readonly set: SequenceSet }
  | { readonly type: 'SEQ'; readonly set: SequenceSet }
  | { readonly type: 'NOT'; readonly key: SearchKey }
  | { readonly type: 'OR'; readonly left: SearchKey; readonly right: SearchKey }
  /** A parenthesised group: every key must match. */
  | { readonly type: 'AND'; readonly keys: readonly SearchKey[] }
  | {
      readonly type: 'MODSEQ';
      /** RFC 7162 entry name ("/flags/\\Seen") and type, when given. */
      readonly entry: { readonly name: string; readonly entryType: 'priv' | 'shared' | 'all' } | null;
      readonly modseq: bigint;
    };

export type SearchReturnOpt = 'MIN' | 'MAX' | 'ALL' | 'COUNT' | 'SAVE';
export const SEARCH_RETURN_OPTS: readonly SearchReturnOpt[] = ['MIN', 'MAX', 'ALL', 'COUNT', 'SAVE'];

export type ListSelectOpt = 'SUBSCRIBED' | 'REMOTE' | 'RECURSIVEMATCH' | 'SPECIAL-USE';
export const LIST_SELECT_OPTS: readonly ListSelectOpt[] = ['SUBSCRIBED', 'REMOTE', 'RECURSIVEMATCH', 'SPECIAL-USE'];

export type ListReturnOpt =
  | { readonly type: 'SUBSCRIBED' | 'CHILDREN' | 'SPECIAL-USE' }
  | { readonly type: 'STATUS'; readonly items: readonly StatusAtt[] };

export interface QresyncParams {
  readonly uidValidity: number;
  readonly modseq: bigint;
  readonly knownUids: SequenceSet | null;
  readonly seqMatch: { readonly seqs: SequenceSet; readonly uids: SequenceSet } | null;
}

export interface AppendMessage {
  /** Octets announced in the literal. */
  readonly size: number;
  /** literal8 (`~{n}`, RFC 3516) — the message may contain NUL and bare 8-bit. */
  readonly binary: boolean;
  /**
   * The message bytes when the whole command was parsed in one piece; `null` from
   * `parseAppendPrefix`, where the reader streams the bytes separately.
   */
  readonly data: Buffer | null;
}

export type StoreOperation = 'set' | 'add' | 'remove';

type Tagged<T> = T & { readonly tag: string };

export type Command = Tagged<
  | {
      readonly name:
        | 'CAPABILITY'
        | 'NOOP'
        | 'LOGOUT'
        | 'STARTTLS'
        | 'IDLE'
        | 'CLOSE'
        | 'UNSELECT'
        | 'NAMESPACE'
        | 'CHECK'
        | 'EXPUNGE';
    }
  | { readonly name: 'UID EXPUNGE'; readonly set: SequenceSet }
  | {
      readonly name: 'AUTHENTICATE';
      readonly mechanism: string;
      /** Base64 text as sent (`''` for the "=" empty response), or null when absent (SASL-IR). */
      readonly initialResponse: string | null;
    }
  | { readonly name: 'LOGIN'; readonly username: string; readonly password: string }
  | { readonly name: 'ENABLE'; readonly capabilities: readonly string[] }
  | {
      readonly name: 'SELECT' | 'EXAMINE';
      readonly mailbox: string;
      readonly condstore: boolean;
      readonly qresync: QresyncParams | null;
    }
  | { readonly name: 'CREATE'; readonly mailbox: string; readonly specialUse: readonly string[] | null }
  | { readonly name: 'DELETE' | 'SUBSCRIBE' | 'UNSUBSCRIBE'; readonly mailbox: string }
  | { readonly name: 'RENAME'; readonly from: string; readonly to: string }
  | {
      readonly name: 'LIST';
      /** `null` when no selection options were given; `[]` for "()". */
      readonly selection: readonly ListSelectOpt[] | null;
      readonly reference: string;
      readonly patterns: readonly string[];
      /** `null` when there was no RETURN clause. */
      readonly returnOpts: readonly ListReturnOpt[] | null;
    }
  | { readonly name: 'LSUB'; readonly reference: string; readonly pattern: string }
  | { readonly name: 'STATUS'; readonly mailbox: string; readonly items: readonly StatusAtt[] }
  | {
      readonly name: 'APPEND';
      readonly mailbox: string;
      readonly flags: readonly string[] | null;
      readonly date: ImapDateTime | null;
      readonly message: AppendMessage;
    }
  | {
      readonly name: 'SEARCH';
      readonly uid: boolean;
      /** `null` without RETURN (a plain SEARCH response); `[]` for "RETURN ()" (means ALL). */
      readonly returnOpts: readonly SearchReturnOpt[] | null;
      readonly charset: string | null;
      readonly criteria: readonly SearchKey[];
    }
  | {
      readonly name: 'FETCH';
      readonly uid: boolean;
      readonly set: SequenceSet;
      /** A macro stands in for `items` (which is then empty); see `expandFetchMacro`. */
      readonly macro: FetchMacro | null;
      readonly items: readonly FetchAtt[];
      readonly changedSince: bigint | null;
      readonly vanished: boolean;
    }
  | {
      readonly name: 'STORE';
      readonly uid: boolean;
      readonly set: SequenceSet;
      readonly unchangedSince: bigint | null;
      readonly operation: StoreOperation;
      readonly silent: boolean;
      readonly flags: readonly string[];
    }
  | { readonly name: 'COPY' | 'MOVE'; readonly uid: boolean; readonly set: SequenceSet; readonly mailbox: string }
  | { readonly name: 'ID'; readonly params: readonly (readonly [string, string | null])[] | null }
>;

export type CommandName = Command['name'];

/** RFC 3501 §6.4.5 macro expansion. */
export function expandFetchMacro(macro: FetchMacro): FetchAtt[] {
  const base: FetchAtt[] = [{ type: 'FLAGS' }, { type: 'INTERNALDATE' }, { type: 'RFC822.SIZE' }];
  if (macro === 'FAST') return base;
  if (macro === 'ALL') return [...base, { type: 'ENVELOPE' }];
  return [...base, { type: 'ENVELOPE' }, { type: 'BODY' }];
}

/** The items a FETCH asks for, with any macro expanded. */
export function fetchItems(cmd: Extract<Command, { name: 'FETCH' }>): FetchAtt[] {
  return cmd.macro === null ? [...cmd.items] : expandFetchMacro(cmd.macro);
}

export const SYSTEM_FLAGS: readonly string[] = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft', '\\Recent'];

const systemFlagIndex = new Map(SYSTEM_FLAGS.map((f) => [f.toUpperCase(), f]));

/** Canonical spelling for system flags; keywords and unknown `\` flags are returned unchanged. */
export function canonicalFlag(flag: string): string {
  return systemFlagIndex.get(flag.toUpperCase()) ?? flag;
}

/** The ImapDateTime as a JS Date (an instant; the zone only moves it). */
export function dateTimeToDate(d: ImapDateTime): Date {
  return new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second) - d.zone * 60_000);
}

/** A JS Date expressed in the given zone (minutes east of UTC). */
export function dateToDateTime(date: Date, zone = 0): ImapDateTime {
  const shifted = new Date(date.getTime() + zone * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    zone,
  };
}
