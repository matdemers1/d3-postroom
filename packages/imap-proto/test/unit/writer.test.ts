// The response writer and the client-side response reader: string/literal choice, ENVELOPE and
// BODYSTRUCTURE, FETCH with a streaming body, response codes, ESEARCH, VANISHED, LIST.
import { Readable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  atom,
  bodyStructureValue,
  capabilityResponse,
  continuationResponse,
  enabledResponse,
  esearchResponse,
  fetchResponse,
  flagsResponse,
  formatResponseCode,
  idResponse,
  listResponse,
  namespaceResponse,
  numberResponse,
  parseResponse,
  responseChunks,
  responseToBuffer,
  ResponseReader,
  searchResponse,
  statusResponse,
  streamLiteral,
  taggedResponse,
  untaggedData,
  untaggedStatus,
  vanishedResponse,
  writeResponse,
  type BodyStructure,
  type Envelope,
  type ParsedResponse,
  type Response,
  type ResponseCode,
  type RespValue,
} from '../../src/index.js';
import { chunked } from './arbitraries.js';

const wire = (r: Response): string => responseToBuffer(r).toString('utf8');

function readResponses(bytes: Buffer, cuts: readonly number[] = []): ParsedResponse[] {
  const reader = new ResponseReader();
  const out: ParsedResponse[] = [];
  for (const c of chunked(bytes, cuts)) {
    reader.push(c);
    for (let r = reader.next(); r; r = reader.next()) out.push(r);
  }
  return out;
}

/** A generic value tree without Buffers, for readable expectations. */
function plain(v: RespValue): unknown {
  switch (v.kind) {
    case 'atom':
      return v.value;
    case 'string':
      return { s: v.value.toString('utf8') };
    case 'nil':
      return null;
    case 'list':
      return v.items.map(plain);
  }
}

describe('string / literal choice', () => {
  it('always parses back to the same octets, at any chunking, and never puts CR/LF in a quoted string', () => {
    const value = fc.oneof(
      fc.uint8Array({ maxLength: 1500 }).map((b) => Buffer.from(b)),
      fc.string({ unit: 'binary', maxLength: 40 }).map((s) => Buffer.from(s, 'utf8')),
      fc.string({ maxLength: 40 }).map((s) => Buffer.from(s, 'utf8')),
    );
    fc.assert(
      fc.property(value, fc.boolean(), fc.array(fc.nat(), { maxLength: 10 }), (bytes, utf8, cuts) => {
        const out = responseToBuffer(untaggedData([atom('X'), bytes, [bytes, null]], { utf8 }));
        const [r] = readResponses(out, cuts);
        expect(r?.kind).toBe('data');
        if (r?.kind !== 'data') return;
        const [s, list] = r.values;
        expect(s?.kind === 'string' && s.value).toEqual(bytes);
        expect(list?.kind === 'list' && list.items[0]?.kind === 'string' && list.items[0].value).toEqual(bytes);
        if (s?.kind === 'string' && !s.literal) {
          expect(bytes.includes(13) || bytes.includes(10) || bytes.includes(0)).toBe(false);
          if (!utf8) expect(bytes.every((b) => b < 0x80)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('quotes safe strings and escapes quote and backslash', () => {
    expect(wire(untaggedData([atom('X'), 'say "hi" \\ bye']))).toBe('* X "say \\"hi\\" \\\\ bye"\r\n');
    expect(wire(untaggedData([atom('X'), 'two\r\nlines']))).toBe('* X {10}\r\ntwo\r\nlines\r\n');
    expect(wire(untaggedData([atom('X'), 'Grüße']))).toBe('* X {7}\r\nGrüße\r\n');
    expect(wire(untaggedData([atom('X'), 'Grüße'], { utf8: true }))).toBe('* X "Grüße"\r\n');
    expect(wire(untaggedData([atom('X'), null, 42, 7n, []]))).toBe('* X NIL 42 7 ()\r\n');
  });

  it('never lets CR or LF into response text, and refuses non-atoms where atoms go', () => {
    expect(wire(taggedResponse('a1', 'NO', 'bad\r\n* OK injected'))).toBe('a1 NO bad  * OK injected\r\n');
    expect(wire(continuationResponse('x\ry'))).toBe('+ x y\r\n');
    expect(() => flagsResponse(['\\Seen', 'evil)\r\n'])).toThrow(TypeError);
    expect(() => capabilityResponse(['IMAP4rev1', 'A B'])).toThrow(TypeError);
  });
});

describe('status responses and response codes', () => {
  const codes: [ResponseCode, string][] = [
    [{ type: 'UIDVALIDITY', value: 3857529045 }, '[UIDVALIDITY 3857529045]'],
    [{ type: 'UIDNEXT', value: 4392 }, '[UIDNEXT 4392]'],
    [{ type: 'HIGHESTMODSEQ', value: 715194045007n }, '[HIGHESTMODSEQ 715194045007]'],
    [{ type: 'PERMANENTFLAGS', flags: ['\\Deleted', '\\Seen', '\\*'] }, '[PERMANENTFLAGS (\\Deleted \\Seen \\*)]'],
    [{ type: 'APPENDUID', uidValidity: 38505, uids: { type: 'set', ranges: [{ from: 3955, to: 3955 }] } }, '[APPENDUID 38505 3955]'],
    [
      {
        type: 'COPYUID',
        uidValidity: 38505,
        source: { type: 'set', ranges: [{ from: 304, to: 304 }, { from: 319, to: 320 }] },
        dest: { type: 'set', ranges: [{ from: 3956, to: 3958 }] },
      },
      '[COPYUID 38505 304,319:320 3956:3958]',
    ],
    [{ type: 'MODIFIED', set: { type: 'set', ranges: [{ from: 7, to: 7 }, { from: 9, to: 9 }] } }, '[MODIFIED 7,9]'],
    [{ type: 'CLOSED' }, '[CLOSED]'],
    [{ type: 'ALERT' }, '[ALERT]'],
    [{ type: 'TRYCREATE' }, '[TRYCREATE]'],
    [{ type: 'BADCHARSET', charsets: ['UTF-8', 'US-ASCII'] }, '[BADCHARSET (UTF-8 US-ASCII)]'],
    [{ type: 'CAPABILITY', capabilities: ['IMAP4rev1', 'IMAP4rev2', 'LITERAL-'] }, '[CAPABILITY IMAP4rev1 IMAP4rev2 LITERAL-]'],
  ];

  it.each(codes)('formats response code #%# and the client parses it back', (code, expected) => {
    expect(formatResponseCode(code)).toBe(expected);
    const [r] = readResponses(responseToBuffer(taggedResponse('A1', 'OK', 'done', code)));
    expect(r?.kind === 'status' && r.code?.name).toBe(expected.slice(1).split(/[ \]]/)[0]);
    expect(r?.kind === 'status' && r.text).toBe('done');
  });

  it('formats untagged status and continuation responses', () => {
    expect(wire(untaggedStatus('OK', 'UIDs valid', { type: 'UIDVALIDITY', value: 3857529045 }))).toBe('* OK [UIDVALIDITY 3857529045] UIDs valid\r\n');
    expect(wire(untaggedStatus('BYE', 'Autologout; idle for too long'))).toBe('* BYE Autologout; idle for too long\r\n');
    expect(wire(continuationResponse())).toBe('+ Ready\r\n');
    expect(wire(capabilityResponse(['IMAP4rev1', 'IMAP4rev2', 'IDLE']))).toBe('* CAPABILITY IMAP4rev1 IMAP4rev2 IDLE\r\n');
    expect(wire(enabledResponse(['IMAP4rev2']))).toBe('* ENABLED IMAP4rev2\r\n');
    expect(wire(enabledResponse([]))).toBe('* ENABLED\r\n');
    expect(wire(numberResponse(172, 'EXISTS'))).toBe('* 172 EXISTS\r\n');
    expect(wire(flagsResponse(['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft']))).toBe('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
  });
});

describe('untagged data responses', () => {
  it('LIST / LSUB with modified UTF-7 under rev1 and UTF-8 under rev2', () => {
    const entry = { attributes: ['\\HasNoChildren', '\\Drafts'], delimiter: '/', name: 'Entwürfe' };
    expect(wire(listResponse(entry))).toBe('* LIST (\\HasNoChildren \\Drafts) "/" "Entw&APw-rfe"\r\n');
    expect(wire(listResponse(entry, { utf8: true }))).toBe('* LIST (\\HasNoChildren \\Drafts) "/" "Entwürfe"\r\n');
    expect(wire(listResponse({ attributes: ['\\Noselect'], delimiter: null, name: '' }, {}, 'LSUB'))).toBe('* LSUB (\\Noselect) NIL ""\r\n');
    expect(wire(listResponse({ ...entry, extended: ['CHILDINFO', ['SUBSCRIBED']] }))).toBe(
      '* LIST (\\HasNoChildren \\Drafts) "/" "Entw&APw-rfe" ("CHILDINFO" ("SUBSCRIBED"))\r\n',
    );
  });

  it('STATUS, SEARCH, ESEARCH, VANISHED, ID, NAMESPACE', () => {
    expect(wire(statusResponse('blurdybloop', [['MESSAGES', 231], ['UIDNEXT', 44292], ['HIGHESTMODSEQ', 7011231777n]]))).toBe(
      '* STATUS "blurdybloop" (MESSAGES 231 UIDNEXT 44292 HIGHESTMODSEQ 7011231777)\r\n',
    );
    expect(wire(searchResponse([2, 84, 882]))).toBe('* SEARCH 2 84 882\r\n');
    expect(wire(searchResponse([]))).toBe('* SEARCH\r\n');
    expect(wire(searchResponse([2, 5, 6], 917162500n))).toBe('* SEARCH 2 5 6 (MODSEQ 917162500)\r\n');
    expect(wire(esearchResponse({ tag: 'A282', uid: false, min: 2, count: 3 }))).toBe('* ESEARCH (TAG "A282") MIN 2 COUNT 3\r\n');
    expect(wire(esearchResponse({ tag: 'A283', uid: true, all: [2, 10, 11] }))).toBe('* ESEARCH (TAG "A283") UID ALL 2,10:11\r\n');
    expect(wire(esearchResponse({ tag: 'A284', uid: false, count: 0, all: [] }))).toBe('* ESEARCH (TAG "A284") COUNT 0\r\n');
    expect(wire(vanishedResponse([41, 43, 44, 45, 118], true))).toBe('* VANISHED (EARLIER) 41,43:45,118\r\n');
    expect(wire(vanishedResponse({ type: 'set', ranges: [{ from: 405, to: 405 }] }, false))).toBe('* VANISHED 405\r\n');
    expect(wire(idResponse([['name', 'Postroom'], ['version', null]]))).toBe('* ID ("name" "Postroom" "version" NIL)\r\n');
    expect(wire(idResponse(null))).toBe('* ID NIL\r\n');
    expect(wire(namespaceResponse([['', '/']], null, [['Public/', '/']]))).toBe('* NAMESPACE (("" "/")) NIL (("Public/" "/"))\r\n');
  });
});

describe('ENVELOPE, BODYSTRUCTURE and FETCH', () => {
  const tg = { name: 'Terry Gray', adl: null, mailbox: 'gray', host: 'cac.washington.edu' };
  const envelope: Envelope = {
    date: 'Wed, 17 Jul 1996 02:23:25 -0700 (PDT)',
    subject: 'IMAP4rev1 WG mtg summary and minutes',
    from: [tg],
    sender: [tg],
    replyTo: [tg],
    to: [{ name: null, adl: null, mailbox: 'imap', host: 'cac.washington.edu' }],
    cc: [
      { name: null, adl: null, mailbox: 'minutes', host: 'CNRI.Reston.VA.US' },
      { name: 'John Klensin', adl: null, mailbox: 'KLENSIN', host: 'MIT.EDU' },
    ],
    bcc: null,
    inReplyTo: null,
    messageId: '<B27397-0100000@cac.washington.edu>',
  };
  const text: BodyStructure = {
    kind: 'single',
    type: 'TEXT',
    subtype: 'PLAIN',
    params: [['CHARSET', 'US-ASCII']],
    id: null,
    description: null,
    encoding: '7BIT',
    size: 3028,
    lines: 92,
  };

  it('reproduces the RFC 3501 §7.4.2 FETCH example exactly', () => {
    const out = fetchResponse(12, [
      { name: 'FLAGS', flags: ['\\Seen'] },
      { name: 'INTERNALDATE', value: { year: 1996, month: 7, day: 17, hour: 2, minute: 44, second: 25, zone: -420 } },
      { name: 'RFC822.SIZE', value: 4286 },
      { name: 'ENVELOPE', envelope },
      { name: 'BODY', body: text },
    ]);
    expect(wire(out)).toBe(
      '* 12 FETCH (FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 4286 ENVELOPE ("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)" ' +
        '"IMAP4rev1 WG mtg summary and minutes" (("Terry Gray" NIL "gray" "cac.washington.edu")) (("Terry Gray" NIL "gray" "cac.washington.edu")) ' +
        '(("Terry Gray" NIL "gray" "cac.washington.edu")) ((NIL NIL "imap" "cac.washington.edu")) ((NIL NIL "minutes" "CNRI.Reston.VA.US")' +
        '("John Klensin" NIL "KLENSIN" "MIT.EDU")) NIL NIL "<B27397-0100000@cac.washington.edu>") BODY ("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 3028 92))\r\n',
    );
    const [r] = readResponses(responseToBuffer(out));
    expect(r?.kind === 'data' && r.number).toBe(12);
    expect(r?.kind === 'data' && r.name).toBe('FETCH');
  });

  it('writes a multipart BODYSTRUCTURE with its parts back to back and extension data', () => {
    const html: BodyStructure = { ...text, subtype: 'HTML', size: 100, lines: 3, md5: null, disposition: null, language: ['en'], location: null };
    const attachment: BodyStructure = {
      kind: 'single',
      type: 'APPLICATION',
      subtype: 'PDF',
      params: [['NAME', 'a.pdf']],
      id: null,
      description: null,
      encoding: 'BASE64',
      size: 4096,
      disposition: { type: 'attachment', params: [['filename', 'a.pdf']] },
    };
    const inner: BodyStructure = { kind: 'single', type: 'MESSAGE', subtype: 'RFC822', params: null, id: null, description: null, encoding: '7BIT', size: 500, envelope, body: text, lines: 20 };
    const mixed: BodyStructure = { kind: 'multipart', subtype: 'MIXED', parts: [html, attachment, inner], params: [['BOUNDARY', 'xyz']] };
    const v = bodyStructureValue(mixed, true);
    const out = wire(untaggedData([atom('X'), v]));
    expect(out).toContain('("TEXT" "HTML" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 100 3 NIL NIL "en" NIL)("APPLICATION"');
    expect(out).toContain('("attachment" ("filename" "a.pdf")) NIL NIL)("MESSAGE" "RFC822"');
    expect(out).toContain(' "MIXED" ("BOUNDARY" "xyz") NIL NIL NIL)');
    const [r] = readResponses(Buffer.from(out));
    const top = r?.kind === 'data' ? r.values[0] : undefined;
    expect(top?.kind === 'list' && top.items.length).toBe(3 + 1 + 4);
    expect(wire(untaggedData([atom('X'), bodyStructureValue(mixed, false)]))).toMatch(/\) "MIXED"\)\r\n$/);
  });

  it('streams a body section from a Readable with its size announced up front', async () => {
    const body = Buffer.alloc(300_000, 0x78);
    const out = fetchResponse(7, [
      { name: 'UID', value: 42 },
      { name: 'MODSEQ', value: 12345n },
      {
        name: 'BODY[]',
        section: { part: [1], text: 'HEADER.FIELDS', fields: ['From', 'Subject'] },
        origin: 0,
        data: streamLiteral(body.length, Readable.from([body.subarray(0, 100_000), body.subarray(100_000)])),
      },
      { name: 'BINARY[]', part: [2], origin: null, data: Buffer.from([0, 1, 2]) },
      { name: 'BINARY.SIZE', part: [2], size: 3 },
    ]);
    expect(() => responseToBuffer(out)).toThrow(TypeError);
    const chunks: Buffer[] = [];
    for await (const c of responseChunks(out)) chunks.push(c);
    const all = Buffer.concat(chunks);
    expect(all.toString('latin1', 0, 100)).toMatch(/^\* 7 FETCH \(UID 42 MODSEQ \(12345\) BODY\[1\.HEADER\.FIELDS \(From Subject\)\]<0> \{300000\}\r\nxxx/);
    const [r] = readResponses(all, [17, 5000, 200_000]);
    expect(r?.kind).toBe('data');
    if (r?.kind !== 'data') return;
    const items = r.values[0];
    expect(items?.kind).toBe('list');
    if (items?.kind !== 'list') return;
    expect(plain(items.items[0] as RespValue)).toBe('UID');
    expect(plain(items.items[4] as RespValue)).toBe('BODY[1.HEADER.FIELDS (From Subject)]<0>');
    const data = items.items[5];
    expect(data?.kind === 'string' && data.value.equals(body)).toBe(true);
    expect(plain(items.items[6] as RespValue)).toBe('BINARY[2]');
    const bin = items.items[7];
    expect(bin?.kind === 'string' && [...bin.value]).toEqual([0, 1, 2]);
  });

  it('refuses a stream that delivers other than it announced, and honours backpressure', async () => {
    const short = fetchResponse(1, [{ name: 'RFC822', data: streamLiteral(10, Readable.from([Buffer.from('12345')])) }]);
    await expect(async () => {
      for await (const c of responseChunks(short)) expect(c).toBeInstanceOf(Buffer);
    }).rejects.toThrow('delivered 5 of 10');
    const long = fetchResponse(1, [{ name: 'RFC822', data: streamLiteral(2, Readable.from([Buffer.from('12345')])) }]);
    await expect(async () => {
      for await (const c of responseChunks(long)) expect(c).toBeInstanceOf(Buffer);
    }).rejects.toThrow('more than the 2');

    const written: Buffer[] = [];
    let drains = 0;
    const sink = {
      write(c: Buffer) {
        written.push(c);
        return written.length % 2 === 0;
      },
      once(_e: 'drain', cb: () => void) {
        drains++;
        setImmediate(cb);
      },
    };
    await writeResponse(fetchResponse(3, [{ name: 'RFC822.TEXT', data: streamLiteral(6, Readable.from([Buffer.from('abc'), Buffer.from('def')])) }]), sink);
    expect(Buffer.concat(written).toString()).toBe('* 3 FETCH (RFC822.TEXT {6}\r\nabcdef)\r\n');
    expect(drains).toBeGreaterThan(0);
  });
});

describe('client-side response parser', () => {
  it.each([
    ['* OK [UNSEEN 12] Message 12 is first unseen', { kind: 'status', tag: null, status: 'OK', code: { name: 'UNSEEN', args: [{ kind: 'atom', value: '12' }] }, text: 'Message 12 is first unseen' }],
    ['A142 OK [READ-WRITE] SELECT completed', { kind: 'status', tag: 'A142', status: 'OK', code: { name: 'READ-WRITE', args: [] }, text: 'SELECT completed' }],
    ['* PREAUTH IMAP4rev2 server logged in as Smith', { kind: 'status', tag: null, status: 'PREAUTH', code: null, text: 'IMAP4rev2 server logged in as Smith' }],
    ['+ Ready for additional command text', { kind: 'continuation', text: 'Ready for additional command text' }],
    ['+', { kind: 'continuation', text: '' }],
    ['* 23 EXISTS', { kind: 'data', number: 23, name: 'EXISTS', values: [] }],
    ['* SEARCH 2 84 882', { kind: 'data', number: null, name: 'SEARCH', values: ['2', '84', '882'].map((value) => ({ kind: 'atom', value })) }],
  ])('%s', (line, expected) => {
    expect(parseResponse(line)).toEqual(expected);
  });

  it('parses FETCH, LIST, STATUS and ESEARCH structures', () => {
    const fetch = parseResponse('* 12 FETCH (FLAGS (\\Seen \\Answered) BODY[HEADER.FIELDS (DATE FROM)] {5}\r\nhello UID 7)');
    expect(fetch.kind === 'data' && fetch.values.map(plain)).toEqual([['FLAGS', ['\\Seen', '\\Answered'], 'BODY[HEADER.FIELDS (DATE FROM)]', { s: 'hello' }, 'UID', '7']]);
    const list = parseResponse('* LIST (\\Noselect) "/" ~/Mail/foo');
    expect(list.kind === 'data' && list.values.map(plain)).toEqual([['\\Noselect'], { s: '/' }, '~/Mail/foo']);
    const esearch = parseResponse('* ESEARCH (TAG "A283") ALL 2,10:11');
    expect(esearch.kind === 'data' && esearch.values.map(plain)).toEqual([['TAG', { s: 'A283' }], 'ALL', '2,10:11']);
    const flags = parseResponse('* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited');
    expect(flags.kind === 'status' && flags.code?.args.map(plain)).toEqual([['\\Deleted', '\\Seen', '\\*']]);
  });

  it('reports malformed responses without throwing', () => {
    expect(parseResponse('A1 FROB x').kind).toBe('error');
    expect(parseResponse('* 12 FETCH (FLAGS').kind).toBe('error');
    expect(parseResponse('').kind).toBe('error');
    expect(readResponses(Buffer.from('* OK hi\n* OK there\r\n')).map((r) => r.kind)).toEqual(['error', 'status']);
  });

  it('never throws on arbitrary bytes and stops at its limits', () => {
    const interesting = fc.oneof(
      fc.constantFrom(...Buffer.from('* 1 FETCH OK NO ([])"{}~+\\\r\n 0123456789')),
      fc.integer({ min: 0, max: 255 }),
    );
    fc.assert(
      fc.property(fc.array(fc.array(interesting, { maxLength: 200 }), { maxLength: 8 }), (chunks) => {
        const reader = new ResponseReader({ maxLineLength: 100, maxLiteralSize: 200, maxResponseSize: 1000, maxNesting: 8 });
        for (const c of chunks) {
          reader.push(Uint8Array.from(c));
          for (let r = reader.next(); r; r = reader.next()) expect(typeof r.kind).toBe('string');
          expect(reader.bufferedBytes).toBeLessThanOrEqual(1000 + 101);
        }
      }),
      { numRuns: 1500 },
    );
  });
});
