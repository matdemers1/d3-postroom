// Command examples transcribed from the RFCs (RFC 3501 §6, RFC 9051 §6, and the extension RFCs the
// daemon implements), plus the BAD cases the parser must name precisely.
import { describe, expect, it } from 'vitest';
import { parseCommand, type ParseOptions } from '../../src/index.js';

function ok(line: string, options: ParseOptions = {}): unknown {
  const r = parseCommand(Buffer.from(line, 'utf8'), options);
  if (!r.ok) throw new Error(`${line}: ${r.message} @${r.position}`);
  return r.command;
}

function bad(line: string | Buffer, options: ParseOptions = {}): { tag: string | null; message: string } {
  const r = parseCommand(typeof line === 'string' ? Buffer.from(line, 'utf8') : line, options);
  if (r.ok) throw new Error(`expected BAD for ${String(line)}`);
  return { tag: r.tag, message: r.message };
}

const set = (...ranges: [number | '*', number | '*'][]) => ({ type: 'set', ranges: ranges.map(([from, to]) => ({ from, to })) });

// RFC 3501 §6 — every command example in the section.
const RFC3501 = [
  'abcd CAPABILITY',
  'a002 NOOP',
  'a047 NOOP',
  'A023 LOGOUT',
  'a001 STARTTLS',
  'A001 AUTHENTICATE GSSAPI',
  'a001 LOGIN SMITH SESAME',
  'A142 SELECT INBOX',
  'A932 EXAMINE blurdybloop',
  'A003 CREATE owatagusiam/',
  'A004 CREATE owatagusiam/blurdybloop',
  'A682 LIST "" *',
  'A683 DELETE blurdybloop',
  'A684 DELETE foo',
  'A685 DELETE foo/bar',
  'A683 RENAME blurdybloop sarasoop',
  'A684 RENAME foo zowie',
  'Z432 LIST "" *',
  'A002 SUBSCRIBE #news.comp.mail.mime',
  'A002 UNSUBSCRIBE #news.comp.mail.mime',
  'A101 LIST "" ""',
  'A102 LIST #news.comp.mail.misc ""',
  'A103 LIST /usr/staff/jones ""',
  'A202 LIST ~/Mail/ %',
  'A002 LSUB "#news." "comp.mail.*"',
  'A003 LSUB "#news." "comp.%"',
  'A042 STATUS blurdybloop (UIDNEXT MESSAGES)',
  'FXXZ CHECK',
  'A341 CLOSE',
  'A202 EXPUNGE',
  'A282 SEARCH FLAGGED SINCE 1-Feb-1994 NOT FROM "Smith"',
  'A283 SEARCH TEXT "string not in mailbox"',
  'A284 SEARCH CHARSET UTF-8 TEXT {6}\r\nXXXXXX',
  'A654 FETCH 2:4 (FLAGS BODY[HEADER.FIELDS (DATE FROM)])',
  'A003 STORE 2:4 +FLAGS (\\Deleted)',
  'A003 COPY 2:4 MEETING',
  'A999 UID FETCH 4827313:4828442 FLAGS',
];

// RFC 9051 §6 and the extensions: ENABLE, SASL-IR, LIST-EXTENDED/STATUS, SPECIAL-USE, ESEARCH,
// SEARCHRES, NAMESPACE, UIDPLUS, MOVE, UNSELECT, IDLE, ID, CONDSTORE/QRESYNC, BINARY, LITERAL+.
const EXTENSIONS = [
  'a1 ENABLE IMAP4rev2',
  't2 ENABLE CONDSTORE QRESYNC',
  'A01 AUTHENTICATE PLAIN',
  'A01 AUTHENTICATE PLAIN dGVzdAB0ZXN0AHRlc3Q=',
  'A01 AUTHENTICATE EXTERNAL =',
  'A042 STATUS blurdybloop (UIDNEXT MESSAGES SIZE DELETED)',
  'A01 LIST "" % RETURN (STATUS (MESSAGES UNSEEN))',
  'A02 LIST (SUBSCRIBED) "" "*"',
  'A03 LIST () "" "%" RETURN (CHILDREN)',
  'A04 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%"',
  'A05 LIST (REMOTE) "" "*"',
  'A06 LIST "" ("INBOX" "Drafts" "Sent/%")',
  't1 LIST (SPECIAL-USE) "" "*"',
  't2 LIST "" "%" RETURN (SPECIAL-USE)',
  't1 CREATE MySpecial (USE (\\Drafts \\Sent))',
  'A003 NAMESPACE',
  'A282 SEARCH RETURN (MIN COUNT) FLAGGED SINCE 1-Feb-1994 NOT FROM "Smith"',
  'A283 SEARCH RETURN () FLAGGED SINCE 1-Feb-1994 NOT FROM "Smith"',
  'A284 SEARCH RETURN (ALL) OR (FROM "a" SUBJECT "b") (TO c HEADER "X-Foo" "")',
  'A300 SEARCH RETURN (SAVE) SINCE 1-Jan-2004 NOT FROM "Smith"',
  'A301 UID SEARCH UID $ SMALLER 4096',
  'A302 UID FETCH $ (UID FLAGS)',
  'A303 SEARCH BEFORE "1-Feb-1994"',
  'A304 SEARCH SENTSINCE "1-Feb-1994" LARGER 1000 KEYWORD $Forwarded UNKEYWORD Junk',
  'A003 MOVE 2:4 MEETING',
  'a UID MOVE 42:69 foo',
  'A202 UID EXPUNGE 3000:3002',
  'A342 UNSELECT',
  'A002 IDLE',
  'a023 ID ("name" "sodr" "version" "19.34" "vendor" "Pink Floyd Music Limited")',
  'a024 ID NIL',
  'A160 SELECT INBOX (CONDSTORE)',
  'A142 SELECT INBOX (QRESYNC (67890007 20050715194045000 41,43:211,214:541))',
  'B142 SELECT INBOX (QRESYNC (67890007 90060115194045000 1:29997 (5000,7500,9000,9990:9999 15000,22500,27000,29970,29973,29976,29979,29982,29985,29988,29991,29994,29997)))',
  'a103 UID STORE 6,4,8 (UNCHANGEDSINCE 12121230045) +FLAGS.SILENT (\\Deleted)',
  'a104 STORE 7,5,9 (UNCHANGEDSINCE 0) FLAGS.SILENT (\\Seen)',
  's100 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 12345)',
  's101 UID FETCH 300:500 (FLAGS) (CHANGEDSINCE 12345 VANISHED)',
  'a SEARCH MODSEQ "/flags/\\\\draft" all 620162338',
  'a SEARCH OR NOT MODSEQ 720162338 LARGER 50000',
  'a FETCH 1 (BINARY.PEEK[1.2]<0.1024> BINARY.SIZE[1] BINARY[])',
  'a FETCH 1:* ALL',
  'a FETCH 1 FULL',
  'a FETCH 1 FAST',
  'a FETCH 1 (BODY.PEEK[1.2.MIME] BODY[TEXT]<0.100> BODY[] RFC822.SIZE ENVELOPE INTERNALDATE BODYSTRUCTURE MODSEQ)',
  'A003 APPEND Drafts (\\Draft) ~{5}\r\nhe\0lo',
  'A001 LOGIN {11+}\r\nFRED FOOBAR {7+}\r\nfat man',
  'A004 STORE 1 -FLAGS \\Seen \\Flagged',
];

describe('RFC 3501 §6 command examples', () => {
  it.each(RFC3501)('%s', (line) => {
    expect(ok(line)).toBeTruthy();
  });

  it('parses them to the right structures', () => {
    expect(ok('a001 LOGIN SMITH SESAME')).toEqual({ tag: 'a001', name: 'LOGIN', username: 'SMITH', password: 'SESAME' });
    expect(ok('A042 STATUS blurdybloop (UIDNEXT MESSAGES)')).toEqual({ tag: 'A042', name: 'STATUS', mailbox: 'blurdybloop', items: ['UIDNEXT', 'MESSAGES'] });
    expect(ok('A202 LIST ~/Mail/ %')).toEqual({ tag: 'A202', name: 'LIST', selection: null, reference: '~/Mail/', patterns: ['%'], returnOpts: null });
    expect(ok('A282 SEARCH FLAGGED SINCE 1-Feb-1994 NOT FROM "Smith"')).toEqual({
      tag: 'A282',
      name: 'SEARCH',
      uid: false,
      returnOpts: null,
      charset: null,
      criteria: [{ type: 'FLAGGED' }, { type: 'SINCE', date: { year: 1994, month: 2, day: 1 } }, { type: 'NOT', key: { type: 'FROM', value: 'Smith' } }],
    });
    expect(ok('A284 SEARCH CHARSET UTF-8 TEXT {6}\r\nXXXXXX')).toMatchObject({ charset: 'UTF-8', criteria: [{ type: 'TEXT', value: 'XXXXXX' }] });
    expect(ok('A654 FETCH 2:4 (FLAGS BODY[HEADER.FIELDS (DATE FROM)])')).toEqual({
      tag: 'A654',
      name: 'FETCH',
      uid: false,
      set: set([2, 4]),
      macro: null,
      items: [{ type: 'FLAGS' }, { type: 'BODY[]', peek: false, section: { part: [], text: 'HEADER.FIELDS', fields: ['DATE', 'FROM'] }, partial: null }],
      changedSince: null,
      vanished: false,
    });
    expect(ok('A003 STORE 2:4 +FLAGS (\\Deleted)')).toEqual({
      tag: 'A003',
      name: 'STORE',
      uid: false,
      set: set([2, 4]),
      unchangedSince: null,
      operation: 'add',
      silent: false,
      flags: ['\\Deleted'],
    });
    expect(ok('A999 UID FETCH 4827313:4828442 FLAGS')).toMatchObject({ uid: true, set: set([4827313, 4828442]), items: [{ type: 'FLAGS' }] });
    expect(ok('a SELECT inbox')).toMatchObject({ mailbox: 'INBOX' });
  });

  it('parses the APPEND example with its date-time and literal', () => {
    const msg =
      'Date: Mon, 7 Feb 1994 21:52:25 -0800 (PST)\r\nFrom: Fred Foobar <foobar@Blurdybloop.COM>\r\nSubject: afternoon meeting\r\n' +
      'To: mooch@owatagu.siam.edu\r\nMessage-Id: <B27397-0100000@Blurdybloop.COM>\r\nMIME-Version: 1.0\r\n' +
      'Content-Type: TEXT/PLAIN; CHARSET=US-ASCII\r\n\r\nHello Joe, do you think we can meet at 3:30 tomorrow?\r\n';
    const cmd = ok(`A003 APPEND saved-messages (\\Seen) "07-Feb-1994 21:52:25 -0800" {${msg.length}}\r\n${msg}`);
    expect(cmd).toMatchObject({
      name: 'APPEND',
      mailbox: 'saved-messages',
      flags: ['\\Seen'],
      date: { year: 1994, month: 2, day: 7, hour: 21, minute: 52, second: 25, zone: -480 },
      message: { size: msg.length, binary: false },
    });
  });
});

describe('RFC 9051 §6 and extension examples', () => {
  it.each(EXTENSIONS)('%s', (line) => {
    expect(ok(line)).toBeTruthy();
  });

  it('parses them to the right structures', () => {
    expect(ok('A01 AUTHENTICATE PLAIN dGVzdAB0ZXN0AHRlc3Q=')).toEqual({ tag: 'A01', name: 'AUTHENTICATE', mechanism: 'PLAIN', initialResponse: 'dGVzdAB0ZXN0AHRlc3Q=' });
    expect(ok('A01 AUTHENTICATE EXTERNAL =')).toMatchObject({ initialResponse: '' });
    expect(ok('A01 AUTHENTICATE plain')).toMatchObject({ mechanism: 'PLAIN', initialResponse: null });
    expect(ok('A01 LIST "" % RETURN (STATUS (MESSAGES UNSEEN))')).toMatchObject({ returnOpts: [{ type: 'STATUS', items: ['MESSAGES', 'UNSEEN'] }] });
    expect(ok('A04 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%"')).toMatchObject({ selection: ['SUBSCRIBED', 'RECURSIVEMATCH'] });
    expect(ok('A283 SEARCH RETURN () FLAGGED')).toMatchObject({ returnOpts: [] });
    expect(ok('A301 UID SEARCH UID $ SMALLER 4096')).toMatchObject({ uid: true, criteria: [{ type: 'UID', set: { type: 'saved' } }, { type: 'SMALLER', size: 4096 }] });
    expect(ok('a023 ID ("name" "sodr" "version" NIL)')).toEqual({ tag: 'a023', name: 'ID', params: [['name', 'sodr'], ['version', null]] });
    expect(ok('A202 UID EXPUNGE 3000:3002')).toEqual({ tag: 'A202', name: 'UID EXPUNGE', set: set([3000, 3002]) });
    expect(ok('A142 SELECT INBOX (QRESYNC (67890007 20050715194045000 41,43:211,214:541))')).toEqual({
      tag: 'A142',
      name: 'SELECT',
      mailbox: 'INBOX',
      condstore: false,
      qresync: { uidValidity: 67890007, modseq: 20050715194045000n, knownUids: set([41, 41], [43, 211], [214, 541]), seqMatch: null },
    });
    expect(ok('B142 SELECT INBOX (QRESYNC (67890007 90060115194045000 1:29997 (5000,7500 15000,22500)))')).toMatchObject({
      qresync: { knownUids: set([1, 29997]), seqMatch: { seqs: set([5000, 5000], [7500, 7500]), uids: set([15000, 15000], [22500, 22500]) } },
    });
    expect(ok('a103 UID STORE 6,4,8 (UNCHANGEDSINCE 12121230045) +FLAGS.SILENT (\\Deleted)')).toMatchObject({
      uid: true,
      unchangedSince: 12121230045n,
      operation: 'add',
      silent: true,
    });
    expect(ok('s101 UID FETCH 300:500 (FLAGS) (CHANGEDSINCE 12345 VANISHED)')).toMatchObject({ changedSince: 12345n, vanished: true });
    expect(ok('a SEARCH MODSEQ "/flags/\\\\draft" all 620162338')).toMatchObject({
      criteria: [{ type: 'MODSEQ', entry: { name: '/flags/\\draft', entryType: 'all' }, modseq: 620162338n }],
    });
    expect(ok('a FETCH 1 (BINARY.PEEK[1.2]<0.1024> BINARY.SIZE[1])')).toMatchObject({
      items: [
        { type: 'BINARY[]', peek: true, part: [1, 2], partial: { offset: 0, length: 1024 } },
        { type: 'BINARY.SIZE', part: [1] },
      ],
    });
    expect(ok('A003 APPEND Drafts (\\Draft) ~{5}\r\nhe\0lo')).toMatchObject({ message: { size: 5, binary: true, data: Buffer.from('he\0lo') } });
    expect(ok('t1 CREATE MySpecial (USE (\\Drafts \\Sent))')).toEqual({ tag: 't1', name: 'CREATE', mailbox: 'MySpecial', specialUse: ['\\Drafts', '\\Sent'] });
    expect(ok('A004 STORE 1 -FLAGS \\Seen \\Flagged')).toMatchObject({ operation: 'remove', flags: ['\\Seen', '\\Flagged'] });
  });

  it('decodes mailbox names: modified UTF-7 under rev1, UTF-8 under rev2', () => {
    expect(ok('a SELECT ~peter/mail/&U,BTFw-/&ZeVnLIqe-')).toMatchObject({ mailbox: '~peter/mail/台北/日本語' });
    expect(ok('a SELECT "~peter/mail/台北/日本語"', { utf8: true })).toMatchObject({ mailbox: '~peter/mail/台北/日本語' });
    // Under rev2 "&" is just a character.
    expect(ok('a SELECT &U,BTFw-', { utf8: true })).toMatchObject({ mailbox: '&U,BTFw-' });
  });
});

describe('BAD with a precise reason', () => {
  it.each([
    ['a FROB', 'unknown command FROB'],
    ['a LOGIN user', 'missing argument'],
    ['a NOOP extra', 'unexpected characters at end of command'],
    ['a  NOOP', 'expected a command'],
    ['a FETCH 0:3 FLAGS', 'invalid sequence set "0:3"'],
    ['a FETCH 1 (FLAGS) (CHANGEDSINCE 5 VANISHED)', 'VANISHED is only allowed in UID FETCH'],
    ['a UID FETCH 1 (FLAGS) (VANISHED)', 'VANISHED requires CHANGEDSINCE'],
    ['a FETCH 1 BODY[MIME]', 'invalid section MIME'],
    ['a FETCH 1 (FLAGS', 'expected )'],
    ['a SEARCH FROB', 'unknown search key FROB'],
    ['a SEARCH SINCE 1-Foo-2020', 'expected a month (Jan–Dec)'],
    ['a SELECT &Jjo', 'mailbox name is not valid modified UTF-7'],
    ['a SELECT &AGE-', 'mailbox name is not valid modified UTF-7'],
    ['a LIST (RECURSIVEMATCH) "" *', 'RECURSIVEMATCH needs another selection option'],
    ['a STORE 1 FLAGS (\\*)', '\\* is not a flag'],
    ['a LOGIN ~{3}\r\nabc x', 'literal8 is not allowed here'],
    ['a LOGIN {10}\r\nabc', 'literal shorter than announced'],
    ['a LOGIN "a\rb" c', 'CR, LF or NUL inside a quoted string'],
    ['a SELECT INBOX (FOO)', 'unknown select parameter FOO'],
    ['a UID FROB 1', 'unknown UID command FROB'],
    ['a AUTHENTICATE PLAIN not!b64', 'initial response is not base64'],
    ['a STATUS INBOX ()', 'empty list'],
    ['a SEARCH MODSEQ 9223372036854775808', 'mod-sequence value out of range'],
    ['a FETCH 4294967296 FLAGS', 'invalid sequence set "4294967296"'],
  ])('%s → %s', (line, message) => {
    expect(bad(line)).toEqual({ tag: 'a', message });
  });

  it('refuses 8-bit mailbox names before IMAP4rev2 is enabled, and invalid UTF-8 after', () => {
    expect(bad('a SELECT "Ünïcödé"').message).toBe('mailbox name must be modified UTF-7 (8-bit names need ENABLE IMAP4rev2)');
    expect(bad(Buffer.from([...Buffer.from('a SELECT "'), 0xc3, 0x28, 0x22]), { utf8: true }).message).toBe('mailbox name is not valid UTF-8');
  });

  it('refuses depth bombs without recursing out of the stack', () => {
    expect(bad(`a SEARCH ${'('.repeat(17)}ALL${')'.repeat(17)}`).message).toBe('parentheses nested deeper than 16');
    expect(ok(`a SEARCH ${'('.repeat(16)}ALL${')'.repeat(16)}`)).toBeTruthy();
    expect(bad(`a SEARCH ${'NOT '.repeat(100)}ALL`).message).toBe('search keys nested deeper than 64');
    expect(bad(`a SEARCH ${'OR ALL '.repeat(5000)}ALL`).message).toBe('search keys nested deeper than 64');
    expect(bad(`a SEARCH ${'('.repeat(30000)}`).message).toBe('parentheses nested deeper than 16');
  });

  it('reports the tag as unknown when there is none', () => {
    expect(bad(' NOOP')).toEqual({ tag: null, message: 'expected a tag' });
    expect(bad('')).toEqual({ tag: null, message: 'expected a tag' });
  });
});
