// The MIME structure scan, BODYSTRUCTURE / ENVELOPE rendering and section addressing, against
// hand-written expectations (PST-T-3.2).
import { Readable } from 'node:stream';
import fc from 'fast-check';
import { fetchResponse, responseToBuffer, type Section } from '@postroom/imap-proto';
import { describe, expect, it } from 'vitest';
import { binarySize, blobRange, decodedBody, sliceStream, type BlobReader } from '../../src/content.js';
import { sectionSpan, type Span } from '../../src/fetch.js';
import { bodyStructureOf, envelopeOf } from '../../src/render.js';
import { resolvePart, scanStructure, StructureScanner, type MessageStructure } from '../../src/structure.js';
import { FORWARD, MULTIPART, MULTIPART_BODYSTRUCTURE, MULTIPART_ENVELOPE, PDF_BYTES, PLAIN, PLAIN_BODYSTRUCTURE } from '../fixtures.js';

function scan(msg: Buffer): MessageStructure {
  const s = new StructureScanner();
  s.write(msg);
  return s.end();
}

function wire(item: Parameters<typeof fetchResponse>[1][number], utf8 = false): string {
  return responseToBuffer(fetchResponse(1, [item], { utf8 })).toString('utf8');
}

function spanText(msg: Buffer, span: Span): string | null {
  if (span === null) return null;
  if (span.kind === 'bytes') return span.data.toString('utf8');
  return msg.subarray(span.start, span.end).toString('utf8');
}

function section(part: number[], text: Section['text'] = null, fields: string[] = []): Section {
  return { part, text, fields };
}

const memoryBlobs = (data: Buffer, chunk = 7): BlobReader => ({
  get: () => {
    const parts: Buffer[] = [];
    for (let i = 0; i < data.length; i += chunk) parts.push(data.subarray(i, i + chunk));
    return Promise.resolve(Readable.from(parts));
  },
});

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of source) out.push(c);
  return Buffer.concat(out);
}

describe('structure scan', () => {
  it('renders the multipart fixture as the hand-written BODYSTRUCTURE', () => {
    const { root } = scan(MULTIPART);
    expect(wire({ name: 'BODYSTRUCTURE', body: bodyStructureOf(root, false) })).toBe(`* 1 FETCH (${MULTIPART_BODYSTRUCTURE})\r\n`);
  });

  it('renders BODY without the extension data', () => {
    const { root } = scan(PLAIN);
    expect(wire({ name: 'BODY', body: bodyStructureOf(root, false) })).toBe('* 1 FETCH (BODY ("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 52 2))\r\n');
    expect(wire({ name: 'BODYSTRUCTURE', body: bodyStructureOf(root, false) })).toBe(`* 1 FETCH (${PLAIN_BODYSTRUCTURE})\r\n`);
  });

  it('renders the ENVELOPE with raw encoded words, the group, and Sender/Reply-To defaulted to From', () => {
    const { root } = scan(MULTIPART);
    expect(wire({ name: 'ENVELOPE', envelope: envelopeOf(root.headers, false) })).toBe(`* 1 FETCH (${MULTIPART_ENVELOPE})\r\n`);
  });

  it('sends a UTF-8 display name as UTF-8 once the session has enabled it', () => {
    const { root } = scan(MULTIPART);
    const text = wire({ name: 'ENVELOPE', envelope: envelopeOf(root.headers, true) }, true);
    expect(text).toContain('(("Jürgen Müller" NIL "juergen" "example.com"))');
  });

  it('does not depend on how the stream is chunked', async () => {
    const expected = wire({ name: 'BODYSTRUCTURE', body: bodyStructureOf(scan(MULTIPART).root, false) });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 64 }), async (chunk) => {
        const s = await scanStructure(await memoryBlobs(MULTIPART, chunk).get(''));
        expect(wire({ name: 'BODYSTRUCTURE', body: bodyStructureOf(s.root, false) })).toBe(expected);
        expect(s.size).toBe(MULTIPART.length);
      }),
      { numRuns: 64 },
    );
  });

  it('addresses parts per RFC 3501 §6.4.5', () => {
    const { root, size } = scan(MULTIPART);
    const at = (s: Section): string | null => spanText(MULTIPART, sectionSpan(root, size, s));
    expect(at(section([1, 2]))).toBe('<p>Hallo <b>Welt</b></p>');
    expect(at(section([1, 1]))).toBe('Hallo Welt =E2=80=94 plain');
    expect(at(section([1, 2], 'MIME'))).toBe('Content-Type: text/html; charset=utf-8\r\n\r\n');
    expect(at(section([2]))).toBe(PDF_BYTES.toString('base64'));
    expect(at(section([3]))).toBeNull();
    expect(at(section([1, 3]))).toBeNull();
    expect(at(section([], 'HEADER.FIELDS', ['SUBJECT', 'FROM']))).toBe(
      'From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@example.com>\r\nSubject: =?UTF-8?B?w5xiZXIgZGVuIFdvbGtlbg==?= report\r\n\r\n',
    );
    const header = at(section([], 'HEADER'));
    expect(header?.endsWith('boundary="outer"\r\n\r\n')).toBe(true);
    expect(at(section([], 'TEXT'))?.startsWith('This is a preamble.\r\n--outer\r\n')).toBe(true);
    expect(at(section([]))).toBe(MULTIPART.toString('utf8'));
    // HEADER.FIELDS.NOT keeps the rest.
    const not = at(section([], 'HEADER.FIELDS.NOT', ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To']));
    expect(not).toBe('MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n');
  });

  it('serves a partial range <0.10>', async () => {
    const { root, size } = scan(MULTIPART);
    const span = sectionSpan(root, size, section([]));
    if (span === null || span.kind !== 'range') throw new Error('expected a range');
    const bytes = await collect(blobRange(memoryBlobs(MULTIPART), 'x', span.start, span.start + 10));
    expect(bytes.toString('latin1')).toBe('From: =?UT');
    const inner = sectionSpan(root, size, section([1, 2]));
    if (inner === null || inner.kind !== 'range') throw new Error('expected a range');
    const sliced = await collect(blobRange(memoryBlobs(MULTIPART, 3), 'x', inner.start + 3, inner.start + 3 + 5));
    expect(sliced.toString('latin1')).toBe('Hallo');
  });

  it('decodes BINARY and knows its size', async () => {
    const { root } = scan(MULTIPART);
    const pdf = resolvePart(root, [2]);
    const text = resolvePart(root, [1, 1]);
    if (pdf === null || text === null) throw new Error('parts missing');
    const blobs = memoryBlobs(MULTIPART, 5);
    expect(await collect(decodedBody(blobs, 'x', pdf))).toEqual(PDF_BYTES);
    expect(await binarySize(blobs, 'x', pdf)).toBe(PDF_BYTES.length);
    expect((await collect(decodedBody(blobs, 'x', text))).toString('utf8')).toBe('Hallo Welt — plain');
    expect((await collect(sliceStream(decodedBody(blobs, 'x', text), 6, 4))).toString('utf8')).toBe('Welt');
  });

  it('reads an enclosed message/rfc822: its HEADER, TEXT, ENVELOPE and structure', () => {
    const { root, size } = scan(FORWARD);
    const at = (s: Section): string | null => spanText(FORWARD, sectionSpan(root, size, s));
    expect(at(section([2], 'HEADER'))).toBe('From: dave@example.org\r\nSubject: minutes\r\nDate: Mon, 21 Sep 2026 09:00:00 +0000\r\n\r\n');
    expect(at(section([2], 'TEXT'))).toBe('Item one.');
    expect(at(section([2, 1]))).toBe('Item one.');
    expect(at(section([1], 'HEADER'))).toBeNull();
    expect(wire({ name: 'BODYSTRUCTURE', body: bodyStructureOf(root, false) })).toBe(
      '* 1 FETCH (BODYSTRUCTURE (' +
        '("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)' +
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 92 ' +
        '("Mon, 21 Sep 2026 09:00:00 +0000" "minutes" ((NIL NIL "dave" "example.org")) ((NIL NIL "dave" "example.org")) ((NIL NIL "dave" "example.org")) NIL NIL NIL NIL NIL) ' +
        '("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 9 1 NIL NIL NIL NIL) 5 NIL NIL NIL NIL)' +
        ' "MIXED" ("BOUNDARY" "b1") NIL NIL NIL))\r\n',
    );
  });

  it('survives a message with no header/body separator and a multipart without a boundary', () => {
    const headersOnly = scan(Buffer.from('Subject: x\r\nFrom: a@b'));
    expect(headersOnly.root.headers.get('subject')).toBe('x');
    expect(headersOnly.root.bodyStart).toBe(headersOnly.size);
    const noBoundary = scan(Buffer.from('Content-Type: multipart/mixed\r\n\r\nhello\r\n'));
    expect(wire({ name: 'BODY', body: bodyStructureOf(noBoundary.root, false) })).toBe(
      '* 1 FETCH (BODY ("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 7 1))\r\n',
    );
    const empty = scan(Buffer.from('Content-Type: multipart/mixed; boundary=zz\r\n\r\nno parts at all\r\n'));
    expect(wire({ name: 'BODY', body: bodyStructureOf(empty.root, false) })).toContain('"MIXED"');
  });

  it('never throws on arbitrary bytes, and every part lies inside the message', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), fc.integer({ min: 1, max: 97 }), (bytes, chunk) => {
        const s = new StructureScanner();
        const buf = Buffer.from(bytes);
        for (let i = 0; i < buf.length; i += chunk) s.write(buf.subarray(i, i + chunk));
        const { root, size } = s.end();
        const check = (n: typeof root): void => {
          expect(n.headerStart).toBeLessThanOrEqual(n.bodyStart);
          expect(n.bodyStart).toBeLessThanOrEqual(n.bodyEnd);
          expect(n.bodyEnd).toBeLessThanOrEqual(size);
          for (const c of n.children) check(c);
          if (n.message !== null) check(n.message);
        };
        check(root);
        bodyStructureOf(root, false);
      }),
      { numRuns: 300 },
    );
  });
});
