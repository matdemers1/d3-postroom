import { describe, expect, it } from 'vitest';
import { collectMessage, parseMailboxes, parseMessageIdList, parseDate, MimeParser, type MimeEvent } from '../../src/index.js';
import { crlf, filenames, forward, gmailStyle, iso2022jp, missingClose, twoParts, windows1252 } from './fixtures/messages.js';
import { parse, part } from './helpers.js';

describe('parseMessage: structure', () => {
  it('walks a Gmail-style mixed/related/alternative tree with an inline image', async () => {
    const p = await parse(gmailStyle);
    expect(p.parts.map((x) => [x.part.id, x.part.contentType, x.part.kind])).toEqual([
      ['1', 'multipart/mixed', 'multipart'],
      ['1.1', 'multipart/related', 'multipart'],
      ['1.1.1', 'multipart/alternative', 'multipart'],
      ['1.1.1.1', 'text/plain', 'leaf'],
      ['1.1.1.2', 'text/html', 'leaf'],
      ['1.1.2', 'image/png', 'leaf'],
      ['1.2', 'application/pdf', 'leaf'],
    ]);
    expect(p.warnings).toEqual([]);
    expect(p.parts.every((x) => x.ended)).toBe(true);
    expect(part(p, '1.1.1.1').body.toString('utf8')).toBe('Here they are — see the one inline.\r\n[image: cafe.png]\r\n');
    expect(part(p, '1.1.1.2').body.toString('utf8')).toBe(
      '<div dir="ltr">Here they are — see the one inline.<img src="cid:ii_cafe01" alt="cafe.png"></div>\r\n',
    );
    const img = part(p, '1.1.2');
    expect(img.part).toMatchObject({ contentId: 'ii_cafe01', disposition: 'inline', filename: 'cafe.png', encoding: 'base64', parent: '1.1', depth: 2 });
    expect(img.body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(part(p, '1.2').part.filename).toBe('menü.pdf');
    expect(part(p, '1.2').body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('exposes threading and address headers on the root', async () => {
    const root = part(await parse(gmailStyle), '1').part.headers;
    expect(parseMessageIdList(root.get('message-id') ?? '')).toEqual(['CAF+abc123@mail.gmail.com']);
    expect(parseMessageIdList(root.get('references') ?? '')).toEqual(['root@example.org', 'parent@example.org']);
    expect(parseMessageIdList(root.get('in-reply-to') ?? '')).toEqual(['parent@example.org']);
    expect(root.getDecoded('subject')).toBe('Photos from the café');
    expect(parseMailboxes(root.get('from') ?? '')).toEqual([{ name: 'André', address: 'andre@example.com' }]);
    expect(parseDate(root.get('date') ?? '')?.toISOString()).toBe('2026-09-24T13:15:02.000Z');
  });

  it('parses a message/rfc822 forward recursively', async () => {
    const p = await parse(forward);
    expect(p.parts.map((x) => [x.part.id, x.part.contentType])).toEqual([
      ['1', 'multipart/mixed'],
      ['1.1', 'text/plain'],
      ['1.2', 'message/rfc822'],
      ['1.2.1', 'multipart/alternative'],
      ['1.2.1.1', 'text/plain'],
      ['1.2.1.2', 'text/html'],
    ]);
    expect(part(p, '1.2.1').part.headers.get('message-id')).toBe('<orig@example.com>');
    expect(part(p, '1.1').body.toString()).toBe('See below.');
    expect(part(p, '1.2.1.1').body.toString()).toBe('Original text.');
    expect(part(p, '1.2.1.2').body.toString()).toBe('<p>Original text.</p>');
    expect(p.warnings).toEqual([]);
  });

  it('tolerates a missing closing delimiter, ignoring the preamble', async () => {
    const p = await parse(missingClose);
    expect(p.parts.map((x) => x.part.id)).toEqual(['1', '1.1', '1.2']);
    expect(part(p, '1.1').body.toString()).toBe('first');
    expect(part(p, '1.2').body.toString()).toBe('second, and then the message just stops\r\n');
    expect(p.warnings.map((w) => w.code)).toEqual(['multipart-missing-close']);
    expect(p.parts.every((x) => x.ended)).toBe(true);
  });

  it('finds a delimiter split across chunks at every byte offset', async () => {
    const whole = Buffer.from(twoParts, 'latin1');
    const reference = await parse(whole);
    expect(part(reference, '1.1').body.toString()).toBe('alpha');
    expect(part(reference, '1.2').body.toString()).toBe('beta');
    for (let cut = 1; cut < whole.length; cut++) {
      const p = await parse(whole, { cuts: [cut] });
      expect(p.parts.map((x) => [x.part.id, x.body.toString()]), `cut at ${String(cut)}`).toEqual(reference.parts.map((x) => [x.part.id, x.body.toString()]));
    }
    // And one byte at a time.
    const bytewise = await parse([...whole].map((b) => Buffer.from([b])));
    expect(bytewise.parts.map((x) => x.body.toString())).toEqual(reference.parts.map((x) => x.body.toString()));
  });

  it('decodes RFC 2231 and encoded-word filenames', async () => {
    const p = await parse(filenames);
    expect(part(p, '1.1').part.filename).toBe('日本語.txt');
    expect(part(p, '1.2').part.filename).toBe('résumé.pdf');
  });

  it('parses a message without a body, and one without headers', async () => {
    const onlyHeaders = await parse('Subject: x\r\n');
    expect(part(onlyHeaders, '1').part.headers.get('subject')).toBe('x');
    expect(part(onlyHeaders, '1').body.length).toBe(0);
    const noHeaders = await parse('\r\njust a body\r\n');
    expect(part(noHeaders, '1').body.toString()).toBe('just a body\r\n');
  });

  it('keeps a single-part body byte-exact, final line break included', async () => {
    const p = await parse('Subject: x\r\n\r\nline one\r\n--not a boundary\r\n-\r\nend\r\n');
    expect(part(p, '1').body.toString()).toBe('line one\r\n--not a boundary\r\n-\r\nend\r\n');
  });

  it('keeps lines that merely start like the boundary as content', async () => {
    const msg = crlf(`Content-Type: multipart/mixed; boundary=abc

--abc

--abcd is not it
--abc x is not it either
--abc
tail
--abc--
`);
    const p = await parse(msg);
    expect(part(p, '1.1').body.toString()).toBe('--abcd is not it\r\n--abc x is not it either');
    expect(part(p, '1.2').body.toString()).toBe('tail');
  });

  it('defaults digest children to message/rfc822', async () => {
    const msg = crlf(`Content-Type: multipart/digest; boundary=d

--d

Subject: one

first
--d--
`);
    const p = await parse(msg);
    expect(part(p, '1.1').part.contentType).toBe('message/rfc822');
    expect(part(p, '1.1.1').part.headers.get('subject')).toBe('one');
    expect(part(p, '1.1.1').body.toString()).toBe('first');
  });

  it('enforces the depth limit', async () => {
    let msg = '';
    for (let i = 0; i < 10; i++) msg += `Content-Type: multipart/mixed; boundary=b${String(i)}\r\n\r\n--b${String(i)}\r\n`;
    msg += 'Content-Type: text/plain\r\n\r\ndeep\r\n';
    const p = await parse(msg, { maxDepth: 4 });
    expect(p.warnings.some((w) => w.code === 'depth-limit')).toBe(true);
    expect(Math.max(...p.parts.map((x) => x.part.depth))).toBe(4);
  });

  it('ends a header block at a non-header line and skips an mbox From line', async () => {
    const p = await parse('From alice@example.com Thu Sep 24 2026\r\nSubject: x\r\nthis is body\r\nmore\r\n');
    expect(part(p, '1').part.headers.get('subject')).toBe('x');
    expect(part(p, '1').body.toString()).toBe('this is body\r\nmore\r\n');
    expect(p.warnings.map((w) => w.code)).toEqual(['mbox-from-line', 'header-missing-separator']);
  });

  it('caps the header block and keeps going', async () => {
    const big = `X-Big: ${'a'.repeat(900)}\r\n`.repeat(40);
    const p = await parse(`Subject: first\r\n${big}\r\nbody\r\n`, { maxHeaderBytes: 8 * 1024, maxFieldBytes: 4096 });
    expect(p.warnings.map((w) => w.code)).toContain('header-block-too-large');
    expect(part(p, '1').part.headers.get('subject')).toBe('first');
    expect(part(p, '1').body.toString()).toBe('body\r\n');
    const long = await parse(`Subject: ${'b'.repeat(5000)}\r\n\r\nbody`, { maxFieldBytes: 1000 });
    expect(long.warnings.map((w) => w.code)).toContain('header-field-too-long');
    expect(part(long, '1').body.toString()).toBe('body');
  });

  it('delivers events in order: headers, body*, end-part, and a final end', async () => {
    const p = await parse(twoParts);
    const kinds = p.events.map((e: MimeEvent) => (e.type === 'headers' || e.type === 'body' || e.type === 'end-part' ? `${e.type}:${e.part.id}` : e.type));
    expect(kinds).toEqual(['headers:1', 'headers:1.1', 'body:1.1', 'end-part:1.1', 'headers:1.2', 'body:1.2', 'end-part:1.2', 'end-part:1', 'end']);
  });

  it('refuses writes after end', () => {
    const parser = new MimeParser(() => undefined);
    parser.end();
    expect(() => {
      parser.write(Buffer.from('x'));
    }).toThrow(/after end/);
  });
});

describe('charsets in bodies and headers', () => {
  it('decodes a windows-1252 quoted-printable body', async () => {
    const s = await collectMessage(Buffer.from(windows1252, 'latin1'));
    expect(s.headers.getDecoded('subject')).toBe('“quoted”');
    expect(s.text?.text).toBe('“Hello” – it costs € 5.\r\n');
    expect(s.text?.encoding).toBe('windows-1252');
  });

  it('decodes an iso-2022-jp body and subject', async () => {
    const s = await collectMessage(Buffer.from(iso2022jp, 'latin1'));
    expect(s.headers.getDecoded('subject')).toBe('こんにちは');
    expect(s.text?.text).toBe('こんにちは\r\n');
  });

  it('decodes an unknown charset as UTF-8 and warns', async () => {
    const s = await collectMessage('Content-Type: text/plain; charset=x-martian\r\n\r\nhello');
    expect(s.text?.text).toBe('hello');
    expect(s.warnings.map((w) => w.code)).toContain('unknown-charset');
  });
});

describe('collectMessage', () => {
  it('summarises text, html and attachments without storing attachments', async () => {
    const s = await collectMessage(Buffer.from(gmailStyle, 'latin1'));
    expect(s.text?.partId).toBe('1.1.1.1');
    expect(s.html?.partId).toBe('1.1.1.2');
    expect(s.html?.text).toContain('cid:ii_cafe01');
    expect(s.attachments.map((a) => [a.partId, a.contentType, a.filename, a.disposition, a.contentId])).toEqual([
      ['1.1.2', 'image/png', 'cafe.png', 'inline', 'ii_cafe01'],
      ['1.2', 'application/pdf', 'menü.pdf', 'attachment', null],
    ]);
    const pdf = s.attachments[1];
    expect(pdf?.size).toBe(Buffer.from('JVBERi0xLjQKJcOkw7zDtsOfCg==', 'base64').length);
    expect(pdf?.firstBytes.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(pdf?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.stats?.parts).toBe(7);
  });

  it('marks parts inside a forwarded message and does not take their text as the body', async () => {
    const s = await collectMessage(Buffer.from(forward, 'latin1'));
    expect(s.text?.text).toBe('See below.');
    expect(s.html).toBeNull();
    expect(s.attachments.map((a) => [a.partId, a.inMessage])).toEqual([
      ['1.2.1.1', '1.2'],
      ['1.2.1.2', '1.2'],
    ]);
  });

  it('truncates text at the cap and flags it', async () => {
    const s = await collectMessage(`Content-Type: text/plain\r\n\r\n${'x'.repeat(10_000)}`, { maxTextBytes: 100 });
    expect(s.text?.text).toBe('x'.repeat(100));
    expect(s.text?.truncated).toBe(true);
  });

  it('keeps at most firstBytes of each attachment', async () => {
    const body = Buffer.alloc(5000, 7).toString('base64');
    const s = await collectMessage(`Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`, { firstBytes: 16 });
    expect(s.attachments[0]?.firstBytes).toEqual(Buffer.alloc(16, 7));
    expect(s.attachments[0]?.size).toBe(5000);
  });
});
