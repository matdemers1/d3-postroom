// PST-T-15.10 (PST-REQ-195, PST-ADR-013): the message builder with attachments, byte for byte, and
// the pure pieces of the upload path (filename header, content type, the counting Transform).
//   · multipart/mixed: the body part, then each file in order, then a forward's original last;
//   · each file base64 in 76-column CRLF lines, encoded as it streams however the chunks are cut;
//   · filenames: a quoted ASCII fallback always, RFC 2231 filename* only when the name is not plain
//     printable ASCII, split into sections when long — and the parser reads every one back exactly;
//   · no attachments: byte-identical to buildTextMessage.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseMessage } from '@postroom/mime';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asciiFilename, attachmentHeaders, buildOutgoingStream, buildTextMessage, rfc2231Encode, sanitizeContentType, type OutgoingAttachment, type OutgoingMessage } from '../../src/compose/message.js';
import { AttachmentTooLarge, countingTransform, DEFAULT_MAX_ATTACHMENT_BYTES, limitsFromEnv, MAX_INT_COLUMN, parseUploadFilename, perFileCap, repairFilename, stripBidi } from '../../src/compose/uploads.js';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** `bytes` cut into pieces of the given sizes (cycled), as a blob stream would deliver them. */
function chunked(bytes: Buffer, sizes: readonly number[]): () => AsyncIterable<Uint8Array> {
  const pieces: Buffer[] = [];
  for (let at = 0, i = 0; at < bytes.length; i += 1) {
    const n = Math.max(1, sizes[i % sizes.length] ?? 1);
    pieces.push(bytes.subarray(at, at + n));
    at += n;
  }
  return () => Readable.from(pieces);
}

const attachment = (filename: string, contentType: string, bytes: Buffer, sizes: readonly number[] = [bytes.length || 1]): OutgoingAttachment => ({ filename, contentType, open: chunked(bytes, sizes) });

/** The decoded leaves of a message: part id, content type, filename, disposition, bytes. */
async function leaves(raw: Buffer) {
  const out = new Map<string, { contentType: string; filename: string | null; disposition: string | null; parent: string | null; bytes: Buffer[] }>();
  for await (const e of parseMessage(raw)) {
    if (e.type === 'headers' && e.part.kind === 'leaf') out.set(e.part.id, { contentType: e.part.contentType, filename: e.part.filename, disposition: e.part.disposition, parent: e.part.parent, bytes: [] });
    else if (e.type === 'body') out.get(e.part.id)?.bytes.push(e.chunk);
  }
  return [...out.entries()].map(([id, v]) => ({ id, ...v, data: Buffer.concat(v.bytes) }));
}

const hasBareLf = (b: Buffer): boolean => /(?<!\r)\n/.test(b.toString('latin1'));
const hasBareCr = (b: Buffer): boolean => /\r(?!\n)/.test(b.toString('latin1'));

const base: OutgoingMessage = {
  from: { name: '', address: 'zoe@d3cloud.io' },
  to: [{ name: '', address: 'alice@example.org' }],
  cc: [],
  bcc: [],
  subject: 'Files',
  text: 'See attached.',
  messageId: '<m1@d3cloud.io>',
  inReplyTo: null,
  references: [],
  date: new Date('2026-09-26T10:00:00Z'),
};

const HEAD = ['From: zoe@d3cloud.io', 'To: alice@example.org', 'Subject: Files', 'Date: Sat, 26 Sep 2026 10:00:00 +0000', 'Message-ID: <m1@d3cloud.io>', 'MIME-Version: 1.0'];

describe('the builder with attachments (PST-T-15.10)', () => {
  it('builds multipart/mixed byte for byte: body part, then each file base64 in 76-column CRLF lines', async () => {
    const pdf = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    const note = Buffer.from('naïve\r\n', 'utf8');
    // Cut into 1- and 5-byte pieces: the base64 carry has to cross chunk boundaries.
    const raw = await collect(buildOutgoingStream(base, null, 'BOUND', [attachment('report.pdf', 'application/pdf', pdf, [1, 5]), attachment('résumé "final".txt', 'text/plain', note, [2])]));
    const expected = [
      ...HEAD,
      'Content-Type: multipart/mixed;',
      ' boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      'See attached.',
      '--BOUND',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4',
      'OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiYw==',
      '--BOUND',
      'Content-Type: text/plain; name="r_sum_ _final_.txt"',
      // Over 78 characters on one line, so each parameter is folded onto its own.
      'Content-Disposition: attachment;',
      ' filename="r_sum_ _final_.txt";',
      " filename*=utf-8''r%C3%A9sum%C3%A9%20%22final%22.txt",
      'Content-Transfer-Encoding: base64',
      '',
      'bmHDr3ZlDQo=',
      '--BOUND--',
      '',
    ].join('\r\n');
    expect(raw.toString('latin1')).toBe(expected);
    expect(hasBareLf(raw)).toBe(false);
    expect(hasBareCr(raw)).toBe(false);

    const parts = await leaves(raw);
    expect(parts.map((p) => [p.id, p.contentType, p.filename, p.disposition])).toEqual([
      ['1.1', 'text/plain', null, null],
      ['1.2', 'application/pdf', 'report.pdf', 'attachment'],
      ['1.3', 'text/plain', 'résumé "final".txt', 'attachment'],
    ]);
    expect(parts[1]?.data.equals(pdf)).toBe(true);
    expect(parts[2]?.data.equals(note)).toBe(true);
  });

  it('an empty file is an empty part', async () => {
    const raw = await collect(buildOutgoingStream(base, null, 'B', [attachment('empty.bin', 'application/octet-stream', Buffer.alloc(0))]));
    expect(raw.toString('latin1')).toContain('Content-Transfer-Encoding: base64\r\n\r\n\r\n--B--\r\n');
    const parts = await leaves(raw);
    expect(parts[1]).toMatchObject({ filename: 'empty.bin' });
    expect(parts[1]?.data.length).toBe(0);
  });

  it('with HTML the body part is the multipart/alternative, then the files', async () => {
    const raw = await collect(buildOutgoingStream({ ...base, html: '<p>See attached.</p>' }, null, 'OUTER', [attachment('a.txt', 'text/plain', Buffer.from('x'))]));
    const text = raw.toString('latin1');
    expect(text).toMatch(/Content-Type: multipart\/mixed;\r\n boundary="OUTER"\r\n\r\n--OUTER\r\nContent-Type: multipart\/alternative;\r\n boundary="[^"]+"\r\n\r\n--/);
    const parts = await leaves(raw);
    expect(parts.map((p) => [p.id, p.contentType])).toEqual([
      ['1.1.1', 'text/plain'],
      ['1.1.2', 'text/html'],
      ['1.2', 'text/plain'],
    ]);
    expect(parts[2]?.data.toString()).toBe('x');
  });

  it('a forward with attachments: the body, then the files, then the original as message/rfc822, last', async () => {
    const original = Buffer.from('From: a@example.org\r\nSubject: hi\r\n\r\nbody\r\n');
    const raw = await collect(buildOutgoingStream(base, Readable.from([original.subarray(0, 9), original.subarray(9)]), 'FWD', [attachment('one.txt', 'text/plain', Buffer.from('1')), attachment('two.txt', 'text/plain', Buffer.from('2'))]));
    const text = raw.toString('latin1');
    const at = (s: string): number => text.indexOf(s);
    expect(at('filename="one.txt"')).toBeGreaterThan(at('See attached.'));
    expect(at('filename="two.txt"')).toBeGreaterThan(at('filename="one.txt"'));
    expect(at('Content-Type: message/rfc822')).toBeGreaterThan(at('filename="two.txt"'));
    expect(text.endsWith(`Content-Transfer-Encoding: 8bit\r\n\r\n${original.toString('latin1')}\r\n--FWD--\r\n`)).toBe(true);
    expect(hasBareLf(raw)).toBe(false);
  });

  it('no attachments (and no forward) is exactly buildTextMessage', async () => {
    const raw = await collect(buildOutgoingStream(base, null, 'UNUSED', []));
    expect(raw.equals(buildTextMessage(base))).toBe(true);
  });

  it('opens each file only when its part is written, once per build', async () => {
    let opened = 0;
    const a: OutgoingAttachment = { filename: 'f.txt', contentType: 'text/plain', open: () => ((opened += 1), Readable.from([Buffer.from('abc')])) };
    const stream = buildOutgoingStream(base, null, 'B', [a]);
    expect(opened).toBe(0);
    await collect(stream);
    await collect(buildOutgoingStream(base, null, 'B', [a]));
    expect(opened).toBe(2);
  });

  it('a long non-ASCII name is split into RFC 2231 sections: no line over 78, read back exactly', async () => {
    const name = `${'Ünïcödé-報告書-'.repeat(12)}.pdf`;
    const lines = attachmentHeaders(name, 'application/pdf').join('\r\n').split('\r\n');
    const sectionLines = lines.filter((l) => /filename\*\d+\*=/.test(l));
    expect(sectionLines.length).toBeGreaterThan(1);
    for (const l of sectionLines) expect(l.length).toBeLessThanOrEqual(78);
    expect(lines.some((l) => l.includes("filename*0*=utf-8''"))).toBe(true);
    const raw = await collect(buildOutgoingStream(base, null, 'B', [attachment(name, 'application/pdf', Buffer.from('%PDF'))]));
    expect((await leaves(raw))[1]?.filename).toBe(name);
  });

  it('a plain ASCII name has no filename* form; anything else has one', () => {
    expect(attachmentHeaders('Q3 report (final).pdf', 'application/pdf').join('\r\n')).not.toContain('filename*');
    expect(attachmentHeaders('a\\b.txt', 'text/plain').join('\r\n')).toContain("filename*=utf-8''a%5Cb.txt");
    expect(asciiFilename('日本.txt')).toBe('__.txt');
    expect(asciiFilename('😀.png')).toBe('_.png');
    expect(rfc2231Encode("a b'*%.txt")).toBe('a%20b%27%2A%25.txt');
  });

  it('property: any bytes, cut anywhere, come back identical; base64 lines are at most 76 columns', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2000 }), fc.array(fc.integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 8 }), async (bytes, sizes) => {
        const data = Buffer.from(bytes);
        const raw = await collect(buildOutgoingStream(base, null, 'PROP', [attachment('f.bin', 'application/octet-stream', data, sizes)]));
        expect(hasBareLf(raw) || hasBareCr(raw)).toBe(false);
        const text = raw.toString('latin1');
        const body = text.slice(text.indexOf('base64\r\n\r\n') + 10, text.indexOf('\r\n--PROP--'));
        for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
        expect((await leaves(raw))[1]?.data.equals(data)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('property: any filename the upload accepts is read back exactly by the parser', async () => {
    const nameChar = fc.oneof(fc.constantFrom('a', 'Z', '0', ' ', '"', '\\', "'", '%', '*', ';', '=', '(', ')', ',', '.', '-', '_'), fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }));
    const names = fc
      .array(nameChar, { minLength: 1, maxLength: 40 })
      .map((cs) => cs.join(''))
      .filter((n) => parseUploadFilename(encodeURIComponent(n)) === n && !n.includes('=?'));
    await fc.assert(
      fc.asyncProperty(names, async (name) => {
        const raw = await collect(buildOutgoingStream(base, null, 'N', [attachment(name, 'text/plain', Buffer.from('x'))]));
        for (const line of raw.toString('latin1').split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
        expect((await leaves(raw))[1]?.filename).toBe(name);
      }),
      { numRuns: 100 },
    );
  });
});

describe('the upload path’s pure pieces (PST-T-15.10)', () => {
  it('sanitizes the content type to a lowercase type/subtype', () => {
    expect(sanitizeContentType('Application/PDF; charset=binary')).toBe('application/pdf');
    expect(sanitizeContentType('image/svg+xml')).toBe('image/svg+xml');
    expect(sanitizeContentType('')).toBe('application/octet-stream');
    expect(sanitizeContentType(undefined)).toBe('application/octet-stream');
    expect(sanitizeContentType('text')).toBe('application/octet-stream');
    expect(sanitizeContentType('text/pl ain')).toBe('application/octet-stream');
    expect(sanitizeContentType('text/plain\r\nX-Evil: 1')).toBe('application/octet-stream');
    // Composite types may not be base64-encoded (RFC 2045 §6.4): they travel as opaque files.
    expect(sanitizeContentType('message/rfc822')).toBe('application/octet-stream');
    expect(sanitizeContentType('multipart/mixed; boundary=x')).toBe('application/octet-stream');
  });

  it('reads X-Postroom-Filename: percent-decoded UTF-8, path dropped, bad names refused', () => {
    expect(parseUploadFilename(encodeURIComponent('résumé.pdf'))).toBe('résumé.pdf');
    expect(parseUploadFilename(encodeURIComponent('C:\\Users\\me\\report.pdf'))).toBe('report.pdf');
    expect(parseUploadFilename(encodeURIComponent('../../etc/passwd'))).toBe('passwd');
    expect(parseUploadFilename('plain.txt')).toBe('plain.txt');
    expect(parseUploadFilename(undefined)).toBeNull();
    expect(parseUploadFilename('')).toBeNull();
    expect(parseUploadFilename('%20%20')).toBeNull();
    expect(parseUploadFilename('.')).toBeNull();
    expect(parseUploadFilename('dir%2F..')).toBeNull();
    expect(parseUploadFilename('dir%2F')).toBeNull();
    expect(parseUploadFilename('a%0Ab.txt')).toBeNull();
    expect(parseUploadFilename('a%7Fb.txt')).toBeNull();
    expect(parseUploadFilename('%E0%A4%A')).toBeNull(); // malformed escape
    expect(parseUploadFilename('%FF.txt')).toBeNull(); // not UTF-8
    expect(parseUploadFilename(encodeURIComponent('é'.repeat(255)))).toBe('é'.repeat(255));
    expect(parseUploadFilename('x'.repeat(256))).toBeNull();
  });

  it('strips bidirectional controls, which would spoof an extension', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE: "\u202Efdp.exe" renders as "exe.pdf".
    expect(parseUploadFilename(encodeURIComponent('\u202Efdp.exe'))).toBe('fdp.exe');
    for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F']) {
      expect(parseUploadFilename(encodeURIComponent(`a${c}b.txt`))).toBe('ab.txt');
    }
    expect(parseUploadFilename(encodeURIComponent('\u202E\u2066'))).toBeNull();
    expect(repairFilename('report\u202Etxt.exe', 'x')).toBe('reporttxt.exe');
    expect(stripBidi('שלום.txt')).toBe('שלום.txt'); // right-to-left text itself is kept
  });

  it('defaults: 17 MiB per message (under Gmail’s 25 MB once base64-encoded), quotas of 100 uploads and 5 messages’ worth', () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(17_825_792);
    const encoded = Math.ceil(DEFAULT_MAX_ATTACHMENT_BYTES / 3) * 4;
    expect(encoded + Math.ceil(encoded / 76) * 2).toBeLessThan(25_000_000 - 500_000);
    expect(limitsFromEnv({})).toEqual({ maxAttachmentBytes: 17_825_792, maxAttachments: 20, maxOutstandingUploads: 100, maxOutstandingBytes: 5 * 17_825_792 });
    expect(limitsFromEnv({ COMPOSE_MAX_ATTACHMENT_BYTES: '1000' }).maxOutstandingBytes).toBe(5000);
    // The size column is a PostgreSQL integer: no file past it, whatever the env says.
    expect(perFileCap(limitsFromEnv({ COMPOSE_MAX_ATTACHMENT_BYTES: String(2 ** 33) }))).toBe(MAX_INT_COLUMN);
  });

  it('repairs a filename read back from a draft instead of refusing it', () => {
    expect(repairFilename(null, 'attachment-1')).toBe('attachment-1');
    expect(repairFilename('dir/a\u0007b.txt', 'x')).toBe('ab.txt');
    expect(repairFilename('..', 'x')).toBe('x');
    expect(Array.from(repairFilename('é'.repeat(300), 'x')).length).toBe(255);
  });

  it('the counting Transform passes up to the limit and errors past it, before the extra bytes go on', async () => {
    const ok = countingTransform(10);
    const seen: Buffer[] = [];
    await pipeline(Readable.from([Buffer.alloc(4), Buffer.alloc(6)]), ok, async (source: AsyncIterable<Buffer>) => {
      for await (const c of source) seen.push(c);
    });
    expect(Buffer.concat(seen).length).toBe(10);
    expect(ok.seen()).toBe(10);

    const over = countingTransform(10);
    const passed: Buffer[] = [];
    await expect(
      pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), over, async (source: AsyncIterable<Buffer>) => {
        for await (const c of source) passed.push(c);
      }),
    ).rejects.toBeInstanceOf(AttachmentTooLarge);
    // Whatever reached the far side, the chunk that crossed the limit never did.
    expect(Buffer.concat(passed).length).toBeLessThanOrEqual(6);
    expect(over.seen()).toBe(12);
  });
});
