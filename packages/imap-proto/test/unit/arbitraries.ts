// fast-check arbitraries for valid command ASTs, in the canonical form the parser produces.
import fc from 'fast-check';
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
  type ImapDate,
  type ImapDateTime,
  type ListReturnOpt,
  type ListSelectOpt,
  type SearchKey,
  type Section,
  type SeqNumber,
  type SequenceSet,
} from '../../src/index.js';

const TAG_CHARS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_!#&\'/:;<=>?@[]^`|~$,');

export const tag = fc.string({ unit: fc.constantFrom(...TAG_CHARS), minLength: 1, maxLength: 8 });

/** Well-formed Unicode text: anything that survives a UTF-8 round trip. */
export const text = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
  fc.constantFrom('', 'NIL', 'a b', 'quote"back\\slash', 'line\r\nbreak', '\0nul', 'x'.repeat(1100)),
);

/** Mailbox names: arbitrary Unicode, never a case variant of INBOX other than INBOX itself. */
export const mailbox = fc
  .oneof(
    fc.string({ maxLength: 10 }),
    fc.string({ unit: 'binary', maxLength: 8 }),
    fc.constantFrom('INBOX', 'Sent', 'Archive/2026', '日本語', 'a&b', '&-', 'Ünïcödé/Ordner', 'with space', '[Gmail]/All Mail', '*%'),
  )
  .filter((m) => m === 'INBOX' || m.toUpperCase() !== 'INBOX');

export const pattern = fc.oneof(mailbox, fc.constantFrom('*', '%', 'INBOX.*', 'Archive/%', ''));

export const nz = fc.integer({ min: 1, max: 0xffffffff });
const seqNumber: fc.Arbitrary<SeqNumber> = fc.oneof({ weight: 4, arbitrary: nz }, { weight: 1, arbitrary: fc.constant('*' as const) });

export const sequenceSet: fc.Arbitrary<SequenceSet> = fc.oneof(
  { weight: 8, arbitrary: fc.array(fc.record({ from: seqNumber, to: seqNumber }), { minLength: 1, maxLength: 5 }).map((ranges) => ({ type: 'set' as const, ranges })) },
  { weight: 1, arbitrary: fc.constant({ type: 'saved' as const }) },
);
export const plainSet: fc.Arbitrary<SequenceSet> = fc
  .array(fc.record({ from: seqNumber, to: seqNumber }), { minLength: 1, maxLength: 5 })
  .map((ranges) => ({ type: 'set' as const, ranges }));

export const modseq = fc.bigInt({ min: 1n, max: (1n << 63n) - 1n });
const modseqValzer = fc.bigInt({ min: 0n, max: (1n << 63n) - 1n });

export const keyword = fc.stringMatching(/^[A-Za-z$][A-Za-z0-9$_.-]{0,10}$/);
export const flag = fc
  .oneof(
    fc.constantFrom('\\Seen', '\\ANSWERED', '\\flagged', '\\Deleted', '\\Draft', '\\Recent'),
    keyword,
    fc.stringMatching(/^\\[A-Za-z]{1,8}$/),
  )
  .map(canonicalFlag);

export const date: fc.Arbitrary<ImapDate> = fc.record({
  year: fc.integer({ min: 1000, max: 9999 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 31 }),
});

export const dateTime: fc.Arbitrary<ImapDateTime> = fc.record({
  year: fc.integer({ min: 1000, max: 9999 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 31 }),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 60 }),
  zone: fc.integer({ min: -1439, max: 1439 }),
});

const ascii = fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)), maxLength: 12 });
const fieldName = fc.string({ unit: fc.integer({ min: 0x21, max: 0x7e }).map((c) => String.fromCharCode(c)), minLength: 1, maxLength: 12 });
const part = fc.array(nz, { minLength: 1, maxLength: 4 });
const partial = fc.option(fc.record({ offset: fc.integer({ min: 0, max: 0xffffffff }), length: nz }), { nil: null });

export const section: fc.Arbitrary<Section> = fc.oneof(
  fc.record({ part: fc.array(nz, { maxLength: 3 }), text: fc.constantFrom('HEADER' as const, 'TEXT' as const, null), fields: fc.constant([]) }),
  fc.record({ part, text: fc.constant('MIME' as const), fields: fc.constant([]) }),
  fc.record({
    part: fc.array(nz, { maxLength: 3 }),
    text: fc.constantFrom('HEADER.FIELDS' as const, 'HEADER.FIELDS.NOT' as const),
    fields: fc.array(fieldName, { minLength: 1, maxLength: 4 }),
  }),
);

export const fetchAtt: fc.Arbitrary<FetchAtt> = fc.oneof(
  fc.constantFrom('ENVELOPE', 'FLAGS', 'INTERNALDATE', 'RFC822', 'RFC822.HEADER', 'RFC822.SIZE', 'RFC822.TEXT', 'BODY', 'BODYSTRUCTURE', 'UID', 'MODSEQ').map((type): FetchAtt => ({ type })),
  fc.record({ type: fc.constant('BODY[]' as const), peek: fc.boolean(), section, partial }),
  fc.record({ type: fc.constant('BINARY[]' as const), peek: fc.boolean(), part: fc.array(nz, { maxLength: 3 }), partial }),
  fc.record({ type: fc.constant('BINARY.SIZE' as const), part: fc.array(nz, { maxLength: 3 }) }),
);

const { searchKey } = fc.letrec<{ searchKey: SearchKey }>((tie) => ({
  searchKey: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom(...SEARCH_FLAG_KEYS).map((type) => ({ type })),
    fc.record({ type: fc.constantFrom(...SEARCH_STRING_KEYS), value: text }),
    fc.record({ type: fc.constantFrom(...SEARCH_DATE_KEYS), date }),
    fc.record({ type: fc.constantFrom('KEYWORD' as const, 'UNKEYWORD' as const), flag: keyword }),
    fc.record({ type: fc.constantFrom('LARGER' as const, 'SMALLER' as const), size: fc.integer({ min: 0, max: 0xffffffff }) }),
    fc.record({ type: fc.constant('HEADER' as const), field: text, value: text }),
    fc.record({ type: fc.constant('UID' as const), set: sequenceSet }),
    fc.record({ type: fc.constant('SEQ' as const), set: sequenceSet }),
    fc.record({
      type: fc.constant('MODSEQ' as const),
      entry: fc.option(fc.record({ name: ascii, entryType: fc.constantFrom('priv' as const, 'shared' as const, 'all' as const) }), { nil: null }),
      modseq: modseqValzer,
    }),
    fc.record({ type: fc.constant('NOT' as const), key: tie('searchKey') }),
    fc.record({ type: fc.constant('OR' as const), left: tie('searchKey'), right: tie('searchKey') }),
    fc.record({ type: fc.constant('AND' as const), keys: fc.array(tie('searchKey'), { minLength: 1, maxLength: 3 }) }),
  ),
}));
export { searchKey };

const statusItems = fc.subarray([...STATUS_ATTS], { minLength: 1 });

const listSelection: fc.Arbitrary<ListSelectOpt[] | null> = fc.option(
  fc.subarray([...LIST_SELECT_OPTS]).filter((s) => !s.includes('RECURSIVEMATCH') || s.includes('SUBSCRIBED') || s.includes('SPECIAL-USE')),
  { nil: null },
);
const listReturn: fc.Arbitrary<ListReturnOpt[] | null> = fc.option(
  fc.array(
    fc.oneof(
      fc.constantFrom('SUBSCRIBED' as const, 'CHILDREN' as const, 'SPECIAL-USE' as const).map((type) => ({ type })),
      statusItems.map((items) => ({ type: 'STATUS' as const, items })),
    ),
    { maxLength: 3 },
  ),
  { nil: null },
);

const base64 = fc.uint8Array({ minLength: 1, maxLength: 40 }).map((b) => Buffer.from(b).toString('base64'));
const buffer = fc.uint8Array({ maxLength: 300 }).map((b) => Buffer.from(b));
const upperAtom = fc.stringMatching(/^[A-Z0-9][A-Z0-9=-]{0,12}$/);

export const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    tag,
    name: fc.constantFrom('CAPABILITY', 'NOOP', 'LOGOUT', 'STARTTLS', 'IDLE', 'CLOSE', 'UNSELECT', 'NAMESPACE', 'CHECK', 'EXPUNGE' as const),
  }),
  fc.record({ tag, name: fc.constant('UID EXPUNGE' as const), set: sequenceSet }),
  fc.record({
    tag,
    name: fc.constant('AUTHENTICATE' as const),
    mechanism: upperAtom,
    initialResponse: fc.option(fc.oneof(fc.constant(''), base64), { nil: null }),
  }),
  fc.record({ tag, name: fc.constant('LOGIN' as const), username: text, password: text }),
  fc.record({ tag, name: fc.constant('ENABLE' as const), capabilities: fc.array(upperAtom, { minLength: 1, maxLength: 3 }) }),
  fc.record({
    tag,
    name: fc.constantFrom('SELECT' as const, 'EXAMINE' as const),
    mailbox,
    condstore: fc.boolean(),
    qresync: fc.option(
      fc.record({
        uidValidity: nz,
        modseq,
        knownUids: fc.option(plainSet, { nil: null }),
        seqMatch: fc.option(fc.record({ seqs: plainSet, uids: plainSet }), { nil: null }),
      }),
      { nil: null },
    ),
  }),
  fc.record({
    tag,
    name: fc.constant('CREATE' as const),
    mailbox,
    specialUse: fc.option(fc.array(fc.constantFrom('\\All', '\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash'), { maxLength: 2 }), {
      nil: null,
    }),
  }),
  fc.record({ tag, name: fc.constantFrom('DELETE' as const, 'SUBSCRIBE' as const, 'UNSUBSCRIBE' as const), mailbox }),
  fc.record({ tag, name: fc.constant('RENAME' as const), from: mailbox, to: mailbox }),
  fc.record({
    tag,
    name: fc.constant('LIST' as const),
    selection: listSelection,
    reference: pattern,
    patterns: fc.array(pattern, { minLength: 1, maxLength: 3 }),
    returnOpts: listReturn,
  }),
  fc.record({ tag, name: fc.constant('LSUB' as const), reference: pattern, pattern }),
  fc.record({ tag, name: fc.constant('STATUS' as const), mailbox, items: statusItems }),
  fc.record({
    tag,
    name: fc.constant('APPEND' as const),
    mailbox,
    flags: fc.option(fc.array(flag, { maxLength: 3 }), { nil: null }),
    date: fc.option(dateTime, { nil: null }),
    message: fc.tuple(buffer, fc.boolean()).map(([data, binary]) => ({ size: data.length, binary, data })),
  }),
  fc.record({
    tag,
    name: fc.constant('SEARCH' as const),
    uid: fc.boolean(),
    returnOpts: fc.option(fc.subarray([...SEARCH_RETURN_OPTS]), { nil: null }),
    charset: fc.option(fc.constantFrom('UTF-8', 'US-ASCII'), { nil: null }),
    criteria: fc.array(searchKey, { minLength: 1, maxLength: 3 }),
  }),
  fc
    .record({
      tag,
      uid: fc.boolean(),
      set: sequenceSet,
      useMacro: fc.boolean(),
      macro: fc.constantFrom('ALL' as const, 'FAST' as const, 'FULL' as const),
      items: fc.array(fetchAtt, { minLength: 1, maxLength: 4 }),
      changedSince: fc.option(modseq, { nil: null }),
      vanished: fc.boolean(),
    })
    .map(({ tag: t, uid, set, useMacro, macro, items, changedSince, vanished }): Command => ({
      tag: t,
      name: 'FETCH',
      uid,
      set,
      macro: useMacro ? macro : null,
      items: useMacro ? [] : items,
      changedSince,
      vanished: vanished && uid && changedSince !== null,
    })),
  fc.record({
    tag,
    name: fc.constant('STORE' as const),
    uid: fc.boolean(),
    set: sequenceSet,
    unchangedSince: fc.option(modseqValzer, { nil: null }),
    operation: fc.constantFrom('set' as const, 'add' as const, 'remove' as const),
    silent: fc.boolean(),
    flags: fc.array(flag, { maxLength: 4 }),
  }),
  fc.record({ tag, name: fc.constantFrom('COPY' as const, 'MOVE' as const), uid: fc.boolean(), set: sequenceSet, mailbox }),
  fc.record({
    tag,
    name: fc.constant('ID' as const),
    params: fc.option(fc.array(fc.tuple(text, fc.option(text, { nil: null })), { minLength: 1, maxLength: 4 }), { nil: null }),
  }),
);

/** Split bytes into chunks at arbitrary boundaries. */
export function chunked(bytes: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    if (p > prev) out.push(bytes.subarray(prev, p));
    prev = Math.max(prev, p);
  }
  if (prev < bytes.length) out.push(bytes.subarray(prev));
  return out;
}
