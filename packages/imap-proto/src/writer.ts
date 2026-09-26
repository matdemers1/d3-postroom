// The IMAP response writer (server side, PST-REQ-070).
//
// A response is a list of parts: Buffers of wire text, and `StreamLiteral`s whose octet count is
// known up front and whose bytes come from an async source (a message body read from the blob
// store), so a 100 MB FETCH never sits in memory. `responseToBuffer` joins a response that has no
// streams; `responseChunks` / `writeResponse` stream any response, checking every stream delivers
// exactly the octets it announced (anything else would desynchronise the client).
//
// Strings choose their own form: quoted when every octet is safe inside quotes (no CR, LF or NUL;
// 8-bit only once UTF-8 is enabled, and then only valid UTF-8; at most 1024 octets), a literal
// otherwise. CR and LF never appear inside a quoted string or in response text.

import type { ImapDateTime, Section, SequenceSet } from './ast.js';
import { canQuote, formatDateTime, quote } from './format.js';
import { isAtomChar } from './lexer.js';
import { encodeMailboxName } from './mutf7.js';
import { formatSequenceSet, sequenceSetFromNumbers } from './sequence.js';

export interface StreamLiteral {
  readonly kind: 'stream';
  /** Octets the source will deliver, announced as {size}. */
  readonly size: number;
  /** literal8 (`~{n}`) for BINARY[] data. */
  readonly binary: boolean;
  readonly source: AsyncIterable<Uint8Array>;
}

export type ResponsePart = Buffer | StreamLiteral;
export type Response = readonly ResponsePart[];

export interface Atom {
  readonly kind: 'atom';
  readonly value: string;
}

export interface LiteralValue {
  readonly kind: 'literal';
  readonly data: Uint8Array;
  readonly binary: boolean;
}

/**
 * A response value: `null` is NIL; numbers and bigints are numbers; strings and byte arrays are
 * strings (quoted or literal, chosen per value); arrays are parenthesised lists.
 */
export type Value = null | number | bigint | string | Uint8Array | Atom | LiteralValue | StreamLiteral | Adjacent | readonly Value[];

/**
 * Values written back to back with no separator — the grammar's `1*address` and `1*body`, where
 * RFC 3501/9051 put no SP between the parenthesised items.
 */
export interface Adjacent {
  readonly kind: 'adjacent';
  readonly items: readonly Value[];
}

export interface WriterOptions {
  /** IMAP4rev2 or UTF8=ACCEPT enabled: UTF-8 may be quoted and mailbox names are sent as UTF-8. */
  readonly utf8?: boolean;
}

export function atom(value: string): Atom {
  return { kind: 'atom', value };
}

export function literal(data: Uint8Array, binary = false): LiteralValue {
  return { kind: 'literal', data, binary };
}

export function streamLiteral(size: number, source: AsyncIterable<Uint8Array>, binary = false): StreamLiteral {
  return { kind: 'stream', size, binary, source };
}

/** Atoms written by the daemon (flags, capabilities, labels) may hold no SP, CTL, CR or LF. */
function checkAtom(value: string): void {
  if (value.length === 0) throw new TypeError('empty atom');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x28 || c === 0x29 || c === 0x7b || c === 0x22) {
      throw new TypeError(`not an atom: ${JSON.stringify(value)}`);
    }
  }
}

/** Response text: CR and LF become spaces; never empty (RFC 3501 text = 1*TEXT-CHAR). */
function cleanText(text: string): string {
  const t = text.replace(/[\r\n\0]/g, ' ');
  return t.length === 0 ? 'OK' : t;
}

class Out {
  readonly parts: ResponsePart[] = [];
  private text: Buffer[] = [];

  constructor(readonly utf8: boolean) {}

  raw(s: string | Buffer): this {
    this.text.push(typeof s === 'string' ? Buffer.from(s, 'utf8') : s);
    return this;
  }

  private flush(): void {
    if (this.text.length > 0) {
      this.parts.push(this.text.length === 1 ? (this.text[0] ?? Buffer.alloc(0)) : Buffer.concat(this.text));
      this.text = [];
    }
  }

  stream(s: StreamLiteral): this {
    this.raw(`${s.binary ? '~' : ''}{${s.size}}\r\n`);
    this.flush();
    this.parts.push(s);
    return this;
  }

  bytes(b: Uint8Array): this {
    if (canQuote(b, this.utf8)) return this.raw(quote(b));
    const data = Buffer.from(b.buffer, b.byteOffset, b.length);
    return this.raw(`{${b.length}}\r\n`).raw(data);
  }

  value(v: Value): this {
    if (v === null) return this.raw('NIL');
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) throw new TypeError(`not an IMAP number: ${v}`);
      return this.raw(String(v));
    }
    if (typeof v === 'bigint') return this.raw(String(v));
    if (typeof v === 'string') return this.bytes(Buffer.from(v, 'utf8'));
    if (v instanceof Uint8Array) return this.bytes(v);
    if (Array.isArray(v)) return this.list(v as readonly Value[]);
    const tagged = v as Atom | LiteralValue | StreamLiteral | Adjacent;
    switch (tagged.kind) {
      case 'adjacent':
        for (const item of tagged.items) this.value(item);
        return this;
      case 'atom':
        checkAtom(tagged.value);
        return this.raw(tagged.value);
      case 'literal':
        return this.raw(`${tagged.binary ? '~' : ''}{${tagged.data.length}}\r\n`).raw(Buffer.from(tagged.data));
      case 'stream':
        return this.stream(tagged);
    }
  }

  list(items: readonly Value[]): this {
    this.raw('(');
    items.forEach((item, i) => {
      if (i > 0) this.raw(' ');
      this.value(item);
    });
    return this.raw(')');
  }

  values(items: readonly Value[]): this {
    items.forEach((item, i) => {
      if (i > 0) this.raw(' ');
      this.value(item);
    });
    return this;
  }

  done(): ResponsePart[] {
    this.raw('\r\n');
    this.flush();
    return this.parts;
  }
}

// --- response codes ---------------------------------------------------------------------------

export type ResponseCode =
  | {
      readonly type:
        | 'ALERT'
        | 'PARSE'
        | 'READ-ONLY'
        | 'READ-WRITE'
        | 'TRYCREATE'
        | 'CLOSED'
        | 'NOMODSEQ'
        | 'UIDNOTSTICKY'
        | 'CANNOT'
        | 'LIMIT'
        | 'NONEXISTENT'
        | 'ALREADYEXISTS'
        | 'SERVERBUG'
        | 'CLIENTBUG'
        | 'AUTHENTICATIONFAILED'
        | 'AUTHORIZATIONFAILED'
        | 'UNAVAILABLE'
        | 'PRIVACYREQUIRED'
        | 'CONTACTADMIN'
        | 'NOPERM'
        | 'INUSE'
        | 'EXPUNGEISSUED'
        | 'CORRUPTION'
        | 'EXPIRED'
        | 'OVERQUOTA'
        | 'HASCHILDREN'
        | 'TOOBIG'
        | 'UNKNOWN-CTE'
        | 'NOTSAVED'
        | 'USEATTR';
    }
  | { readonly type: 'UIDVALIDITY' | 'UIDNEXT' | 'UNSEEN'; readonly value: number }
  | { readonly type: 'HIGHESTMODSEQ'; readonly value: bigint }
  | { readonly type: 'PERMANENTFLAGS'; readonly flags: readonly string[] }
  | { readonly type: 'CAPABILITY'; readonly capabilities: readonly string[] }
  | { readonly type: 'BADCHARSET'; readonly charsets: readonly string[] }
  | { readonly type: 'APPENDUID'; readonly uidValidity: number; readonly uids: SequenceSet }
  | { readonly type: 'COPYUID'; readonly uidValidity: number; readonly source: SequenceSet; readonly dest: SequenceSet }
  | { readonly type: 'MODIFIED'; readonly set: SequenceSet };

function atoms(list: readonly string[]): string {
  for (const a of list) checkAtom(a);
  return list.join(' ');
}

export function formatResponseCode(code: ResponseCode): string {
  switch (code.type) {
    case 'UIDVALIDITY':
    case 'UIDNEXT':
    case 'UNSEEN':
      return `[${code.type} ${code.value}]`;
    case 'HIGHESTMODSEQ':
      return `[HIGHESTMODSEQ ${code.value}]`;
    case 'PERMANENTFLAGS':
      return `[PERMANENTFLAGS (${atoms(code.flags)})]`;
    case 'CAPABILITY':
      return `[CAPABILITY ${atoms(code.capabilities)}]`;
    case 'BADCHARSET':
      return code.charsets.length === 0 ? '[BADCHARSET]' : `[BADCHARSET (${atoms(code.charsets)})]`;
    case 'APPENDUID':
      return `[APPENDUID ${code.uidValidity} ${formatSequenceSet(code.uids)}]`;
    case 'COPYUID':
      return `[COPYUID ${code.uidValidity} ${formatSequenceSet(code.source)} ${formatSequenceSet(code.dest)}]`;
    case 'MODIFIED':
      return `[MODIFIED ${formatSequenceSet(code.set)}]`;
    default:
      return `[${code.type}]`;
  }
}

// --- status and continuation responses --------------------------------------------------------

export type Status = 'OK' | 'NO' | 'BAD';
export type UntaggedStatus = Status | 'BYE' | 'PREAUTH';

function statusLine(prefix: string, status: string, text: string, code: ResponseCode | null): Response {
  const c = code ? `${formatResponseCode(code)} ` : '';
  return [Buffer.from(`${prefix} ${status} ${c}${cleanText(text)}\r\n`, 'utf8')];
}

/** "<tag> OK|NO|BAD [code] text". */
export function taggedResponse(tag: string, status: Status, text: string, code: ResponseCode | null = null): Response {
  return statusLine(tag, status, text, code);
}

/** "* OK|NO|BAD|BYE|PREAUTH [code] text". */
export function untaggedStatus(status: UntaggedStatus, text: string, code: ResponseCode | null = null): Response {
  return statusLine('*', status, text, code);
}

/** "+ text" — the answer to a synchronizing literal, IDLE, or a SASL challenge (base64). */
export function continuationResponse(text = 'Ready'): Response {
  return [Buffer.from(`+ ${text.replace(/[\r\n]/g, ' ')}\r\n`, 'utf8')];
}

// --- untagged data responses ------------------------------------------------------------------

/** "* " followed by the values. */
export function untaggedData(values: readonly Value[], options: WriterOptions = {}): Response {
  return new Out(options.utf8 ?? false).raw('* ').values(values).done();
}

export function capabilityResponse(capabilities: readonly string[]): Response {
  return [Buffer.from(`* CAPABILITY ${atoms(capabilities)}\r\n`, 'latin1')];
}

export function enabledResponse(capabilities: readonly string[]): Response {
  return [Buffer.from(`* ENABLED${capabilities.length ? ' ' : ''}${atoms(capabilities)}\r\n`, 'latin1')];
}

/** "* n EXISTS" / "* n RECENT" / "* n EXPUNGE". */
export function numberResponse(n: number, name: 'EXISTS' | 'RECENT' | 'EXPUNGE'): Response {
  return [Buffer.from(`* ${n} ${name}\r\n`, 'latin1')];
}

export function flagsResponse(flags: readonly string[]): Response {
  return [Buffer.from(`* FLAGS (${atoms(flags)})\r\n`, 'latin1')];
}

/** The mailbox name as it travels: modified UTF-7 under rev1, UTF-8 once enabled. */
export function mailboxNameBytes(name: string, options: WriterOptions = {}): Buffer {
  return options.utf8 === true ? Buffer.from(name, 'utf8') : Buffer.from(encodeMailboxName(name), 'latin1');
}

export interface ListEntry {
  readonly attributes: readonly string[];
  /** Hierarchy delimiter, or null for a flat namespace. */
  readonly delimiter: string | null;
  readonly name: string;
  /** LIST-EXTENDED mbox-list-extended items, e.g. ["CHILDINFO", [["SUBSCRIBED"]]]. */
  readonly extended?: readonly Value[];
}

export function listResponse(entry: ListEntry, options: WriterOptions = {}, command: 'LIST' | 'LSUB' = 'LIST'): Response {
  const o = new Out(options.utf8 ?? false);
  o.raw(`* ${command} (${atoms(entry.attributes)}) `);
  o.value(entry.delimiter === null ? null : entry.delimiter);
  o.raw(' ').bytes(mailboxNameBytes(entry.name, options));
  if (entry.extended && entry.extended.length > 0) o.raw(' ').list(entry.extended);
  return o.done();
}

export function statusResponse(
  mailbox: string,
  items: readonly (readonly [string, number | bigint])[],
  options: WriterOptions = {},
): Response {
  const o = new Out(options.utf8 ?? false);
  o.raw('* STATUS ').bytes(mailboxNameBytes(mailbox, options)).raw(' (');
  o.raw(
    items
      .map(([k, v]) => {
        checkAtom(k);
        return `${k} ${v}`;
      })
      .join(' '),
  );
  return o.raw(')').done();
}

/** "* SEARCH n n n [(MODSEQ m)]" (RFC 3501, RFC 7162 §3.1.5). */
export function searchResponse(numbers: readonly number[], modseq: bigint | null = null): Response {
  const nums = numbers.length ? ` ${numbers.join(' ')}` : '';
  return [Buffer.from(`* SEARCH${nums}${modseq === null ? '' : ` (MODSEQ ${modseq})`}\r\n`, 'latin1')];
}

export interface EsearchResult {
  /** The command's tag, for the (TAG "…") correlator. */
  readonly tag: string | null;
  readonly uid: boolean;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly count?: number | null;
  readonly all?: SequenceSet | readonly number[] | null;
  readonly modseq?: bigint | null;
}

/** "* ESEARCH (TAG "x") UID MIN 1 MAX 9 COUNT 3 ALL 1,5,9 MODSEQ n" (RFC 4731). */
export function esearchResponse(r: EsearchResult): Response {
  const o = new Out(false).raw('* ESEARCH');
  if (r.tag !== null) o.raw(' (TAG ').bytes(Buffer.from(r.tag, 'latin1')).raw(')');
  if (r.uid) o.raw(' UID');
  if (r.min !== undefined && r.min !== null) o.raw(` MIN ${r.min}`);
  if (r.max !== undefined && r.max !== null) o.raw(` MAX ${r.max}`);
  if (r.count !== undefined && r.count !== null) o.raw(` COUNT ${r.count}`);
  if (r.all !== undefined && r.all !== null) {
    const set = Array.isArray(r.all) ? sequenceSetFromNumbers(r.all as readonly number[]) : (r.all as SequenceSet);
    if (set.type === 'saved' || set.ranges.length > 0) o.raw(` ALL ${formatSequenceSet(set)}`);
  }
  if (r.modseq !== undefined && r.modseq !== null) o.raw(` MODSEQ ${r.modseq}`);
  return o.done();
}

/** "* VANISHED [(EARLIER)] uid-set" (RFC 7162 §3.2.10). */
export function vanishedResponse(uids: SequenceSet | readonly number[], earlier: boolean): Response {
  const set = Array.isArray(uids) ? sequenceSetFromNumbers(uids as readonly number[]) : (uids as SequenceSet);
  return [Buffer.from(`* VANISHED ${earlier ? '(EARLIER) ' : ''}${formatSequenceSet(set)}\r\n`, 'latin1')];
}

/** "* ID (…)" or "* ID NIL" (RFC 2971). */
export function idResponse(params: readonly (readonly [string, string | null])[] | null): Response {
  const o = new Out(true).raw('* ID ');
  if (params === null) o.raw('NIL');
  else o.list(params.flatMap(([k, v]) => [k, v]));
  return o.done();
}

export type NamespaceList = readonly (readonly [prefix: string, delimiter: string | null])[] | null;

/** "* NAMESPACE personal other shared" (RFC 2342). */
export function namespaceResponse(
  personal: NamespaceList,
  other: NamespaceList,
  shared: NamespaceList,
  options: WriterOptions = {},
): Response {
  const o = new Out(options.utf8 ?? false).raw('* NAMESPACE');
  for (const ns of [personal, other, shared]) {
    o.raw(' ');
    if (ns === null || ns.length === 0) o.raw('NIL');
    else o.list(ns.map(([prefix, delim]) => [mailboxNameBytes(prefix, options), delim]));
  }
  return o.done();
}

// --- ENVELOPE and BODYSTRUCTURE ---------------------------------------------------------------

export type NString = string | Uint8Array | null;

export interface EnvelopeAddress {
  readonly name: NString;
  readonly adl: NString;
  readonly mailbox: NString;
  readonly host: NString;
}

export interface Envelope {
  readonly date: NString;
  readonly subject: NString;
  readonly from: readonly EnvelopeAddress[] | null;
  readonly sender: readonly EnvelopeAddress[] | null;
  readonly replyTo: readonly EnvelopeAddress[] | null;
  readonly to: readonly EnvelopeAddress[] | null;
  readonly cc: readonly EnvelopeAddress[] | null;
  readonly bcc: readonly EnvelopeAddress[] | null;
  readonly inReplyTo: NString;
  readonly messageId: NString;
}

function addresses(list: readonly EnvelopeAddress[] | null): Value {
  if (list === null || list.length === 0) return null;
  return [{ kind: 'adjacent', items: list.map((a) => [a.name, a.adl, a.mailbox, a.host]) }];
}

export function envelopeValue(e: Envelope): Value {
  return [
    e.date,
    e.subject,
    addresses(e.from),
    addresses(e.sender),
    addresses(e.replyTo),
    addresses(e.to),
    addresses(e.cc),
    addresses(e.bcc),
    e.inReplyTo,
    e.messageId,
  ];
}

export type BodyParams = readonly (readonly [string, string | Uint8Array])[] | null;

export interface BodyDisposition {
  readonly type: string;
  readonly params: BodyParams;
}

/** The extension data BODYSTRUCTURE carries and BODY omits. */
export interface BodyExtension {
  readonly disposition?: BodyDisposition | null;
  readonly language?: readonly string[] | null;
  readonly location?: NString;
}

export interface SinglePart extends BodyExtension {
  readonly kind: 'single';
  readonly type: string;
  readonly subtype: string;
  readonly params: BodyParams;
  readonly id: NString;
  readonly description: NString;
  readonly encoding: string;
  readonly size: number;
  /** Lines, for text/* and message/rfc822 (and message/global). */
  readonly lines?: number;
  /** message/rfc822 (and message/global): the enclosed message. */
  readonly envelope?: Envelope;
  readonly body?: BodyStructure;
  readonly md5?: NString;
}

export interface Multipart extends BodyExtension {
  readonly kind: 'multipart';
  readonly subtype: string;
  readonly parts: readonly BodyStructure[];
  readonly params?: BodyParams;
}

export type BodyStructure = SinglePart | Multipart;

function params(p: BodyParams | undefined): Value {
  if (!p || p.length === 0) return null;
  return p.flatMap(([k, v]) => [k, v]);
}

function extension(b: BodyExtension): Value[] {
  const d = b.disposition ?? null;
  const lang = b.language ?? null;
  return [
    d === null ? null : [d.type, params(d.params)],
    lang === null || lang.length === 0 ? null : lang.length === 1 ? (lang[0] ?? null) : [...lang],
    b.location ?? null,
  ];
}

/** BODYSTRUCTURE (`extended`) or BODY as a value, from the daemon's parsed MIME tree. */
export function bodyStructureValue(b: BodyStructure, extended: boolean): Value {
  if (b.kind === 'multipart') {
    if (b.parts.length === 0) throw new TypeError('a multipart needs at least one part');
    const out: Value[] = [{ kind: 'adjacent', items: b.parts.map((p) => bodyStructureValue(p, extended)) }, b.subtype];
    if (extended) out.push(params(b.params), ...extension(b));
    return out;
  }
  const out: Value[] = [b.type, b.subtype, params(b.params), b.id, b.description, b.encoding, b.size];
  const type = b.type.toUpperCase();
  const subtype = b.subtype.toUpperCase();
  if (type === 'MESSAGE' && (subtype === 'RFC822' || subtype === 'GLOBAL') && b.envelope && b.body) {
    out.push(envelopeValue(b.envelope), bodyStructureValue(b.body, extended), b.lines ?? 0);
  } else if (type === 'TEXT') {
    out.push(b.lines ?? 0);
  }
  if (extended) out.push(b.md5 ?? null, ...extension(b));
  return out;
}

// --- FETCH ------------------------------------------------------------------------------------

/** Octet data for a body section: a Buffer, a stream with its size known, or NIL. */
export type SectionData = Uint8Array | StreamLiteral | null;

export type FetchResponseItem =
  | { readonly name: 'UID' | 'RFC822.SIZE'; readonly value: number }
  | { readonly name: 'MODSEQ'; readonly value: bigint }
  | { readonly name: 'FLAGS'; readonly flags: readonly string[] }
  | { readonly name: 'INTERNALDATE'; readonly value: ImapDateTime }
  | { readonly name: 'ENVELOPE'; readonly envelope: Envelope }
  | { readonly name: 'BODYSTRUCTURE' | 'BODY'; readonly body: BodyStructure }
  | { readonly name: 'RFC822' | 'RFC822.HEADER' | 'RFC822.TEXT'; readonly data: SectionData }
  | { readonly name: 'BODY[]'; readonly section: Section; readonly origin: number | null; readonly data: SectionData }
  | { readonly name: 'BINARY[]'; readonly part: readonly number[]; readonly origin: number | null; readonly data: SectionData }
  | { readonly name: 'BINARY.SIZE'; readonly part: readonly number[]; readonly size: number };

function fieldName(f: string): string {
  const clean = f.replace(/[\r\n\0]/g, '');
  let atomOk = clean.length > 0;
  for (let i = 0; i < clean.length && atomOk; i++) atomOk = isAtomChar(clean.charCodeAt(i));
  return atomOk ? clean : quote(Buffer.from(clean, 'latin1')).toString('latin1');
}

/** The section spec as it appears in a FETCH response label, e.g. "1.HEADER.FIELDS (FROM TO)". */
export function formatSectionSpec(s: Section): string {
  let out = s.part.join('.');
  if (s.text !== null) {
    out += `${s.part.length > 0 ? '.' : ''}${s.text}`;
    if (s.text === 'HEADER.FIELDS' || s.text === 'HEADER.FIELDS.NOT') out += ` (${s.fields.map(fieldName).join(' ')})`;
  }
  return out;
}

function sectionData(o: Out, data: SectionData, binary: boolean): void {
  if (data === null) {
    o.raw('NIL');
  } else if (data instanceof Uint8Array) {
    // Section data always goes as a literal: it is message content, and it keeps the size exact.
    o.raw(`${binary ? '~' : ''}{${data.length}}\r\n`).raw(Buffer.from(data.buffer, data.byteOffset, data.length));
  } else {
    o.stream(data);
  }
}

/** "* n FETCH (…)" from typed items; body data may stream. */
export function fetchResponse(seq: number, items: readonly FetchResponseItem[], options: WriterOptions = {}): Response {
  const o = new Out(options.utf8 ?? false).raw(`* ${seq} FETCH (`);
  items.forEach((item, i) => {
    if (i > 0) o.raw(' ');
    switch (item.name) {
      case 'UID':
      case 'RFC822.SIZE':
        o.raw(`${item.name} ${item.value}`);
        break;
      case 'MODSEQ':
        o.raw(`MODSEQ (${item.value})`);
        break;
      case 'FLAGS':
        o.raw(`FLAGS (${atoms(item.flags)})`);
        break;
      case 'INTERNALDATE':
        o.raw(`INTERNALDATE "${formatDateTime(item.value)}"`);
        break;
      case 'ENVELOPE':
        o.raw('ENVELOPE ').value(envelopeValue(item.envelope));
        break;
      case 'BODYSTRUCTURE':
      case 'BODY':
        o.raw(`${item.name} `).value(bodyStructureValue(item.body, item.name === 'BODYSTRUCTURE'));
        break;
      case 'RFC822':
      case 'RFC822.HEADER':
      case 'RFC822.TEXT':
        o.raw(`${item.name} `);
        sectionData(o, item.data, false);
        break;
      case 'BODY[]':
        o.raw(`BODY[${formatSectionSpec(item.section)}]${item.origin === null ? '' : `<${item.origin}>`} `);
        sectionData(o, item.data, false);
        break;
      case 'BINARY[]':
        o.raw(`BINARY[${item.part.join('.')}]${item.origin === null ? '' : `<${item.origin}>`} `);
        sectionData(o, item.data, true);
        break;
      case 'BINARY.SIZE':
        o.raw(`BINARY.SIZE[${item.part.join('.')}] ${item.size}`);
        break;
    }
  });
  return o.raw(')').done();
}

// --- output -----------------------------------------------------------------------------------

/** Join a response with no streaming parts into one Buffer. */
export function responseToBuffer(response: Response): Buffer {
  const bufs: Buffer[] = [];
  for (const p of response) {
    if (!Buffer.isBuffer(p)) throw new TypeError('response contains a streaming literal; use responseChunks');
    bufs.push(p);
  }
  return Buffer.concat(bufs);
}

/**
 * Every octet of a response, streaming literals included. Throws if a stream delivers more or fewer
 * octets than it announced — the connection must then be closed, the client is out of step.
 */
export async function* responseChunks(response: Response): AsyncGenerator<Buffer> {
  for (const p of response) {
    if (Buffer.isBuffer(p)) {
      yield p;
      continue;
    }
    let sent = 0;
    for await (const chunk of p.source) {
      sent += chunk.length;
      if (sent > p.size) throw new Error(`streaming literal delivered more than the ${p.size} octets announced`);
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    }
    if (sent !== p.size) throw new Error(`streaming literal delivered ${sent} of ${p.size} octets announced`);
  }
}

export interface WritableLike {
  write(chunk: Buffer): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

/** Write a response to a socket-like sink, honouring backpressure. */
export async function writeResponse(response: Response, sink: WritableLike): Promise<void> {
  for await (const chunk of responseChunks(response)) {
    if (!sink.write(chunk)) await new Promise<void>((resolve) => sink.once('drain', resolve));
  }
}
