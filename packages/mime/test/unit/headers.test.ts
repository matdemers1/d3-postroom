import { describe, expect, it } from 'vitest';
import {
  decodeEncodedWords,
  decodeEncodedWordsDetailed,
  parseAddressList,
  parseContentDisposition,
  parseContentType,
  parseDate,
  parseHeaderBlock,
  parseMailboxes,
  parseMessageId,
  parseMessageIdList,
  resolveCharset,
} from '../../src/index.js';
import { rfc2047Examples, rfc2047Table, rfc2231Charset, rfc2231Combined, rfc2231Continuation } from './fixtures/messages.js';

describe('RFC 2047 encoded-words', () => {
  it('decodes the RFC 2047 §8 header examples', () => {
    const h = parseHeaderBlock(Buffer.from(rfc2047Examples, 'latin1'));
    expect(h.getDecoded('subject')).toBe('If you can read this you understand the example.');
    expect(parseMailboxes(h.get('from') ?? '')).toEqual([{ name: 'Keith Moore', address: 'moore@cs.utk.edu' }]);
    expect(parseMailboxes(h.get('to') ?? '')).toEqual([{ name: 'Keld Jørn Simonsen', address: 'keld@dkuug.dk' }]);
    expect(parseMailboxes(h.get('cc') ?? '')).toEqual([{ name: 'André Pirard', address: 'PIRARD@vm1.ulg.ac.be' }]);
  });

  it.each(rfc2047Table)('RFC 2047 §8 whitespace table: %j', (encoded, shown) => {
    // Unfold first, as the header parser does.
    expect(decodeEncodedWords(encoded.replace(/\r\n/g, ''))).toBe(shown);
  });

  it('leaves malformed words literal', () => {
    expect(decodeEncodedWords('=?utf-8?Q?bad=ZZ?= ok')).toBe('=?utf-8?Q?bad=ZZ?= ok');
    expect(decodeEncodedWords('=?utf-8?B?a?=')).toBe('=?utf-8?B?a?=');
    expect(decodeEncodedWords('=?utf-8?X?abc?=')).toBe('=?utf-8?X?abc?=');
    expect(decodeEncodedWords('no words here')).toBe('no words here');
  });

  it('joins bytes of adjacent words so a split multi-byte character survives', () => {
    // "é" is C3 A9; a sender split it across two words.
    expect(decodeEncodedWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9?=')).toBe('café');
  });

  it('accepts an RFC 2231 language suffix and reports unknown charsets', () => {
    expect(decodeEncodedWords('=?US-ASCII*EN?Q?Keith_Moore?=')).toBe('Keith Moore');
    const r = decodeEncodedWordsDetailed('=?x-klingon?Q?abc?=');
    expect(r.text).toBe('abc');
    expect(r.unknownCharsets).toEqual(['x-klingon']);
  });
});

describe('RFC 2231 parameters', () => {
  it('joins continuations (§3)', () => {
    const ct = parseContentType(parseHeaderBlock(Buffer.from(rfc2231Continuation)).get('content-type'));
    expect(ct.mimeType).toBe('message/external-body');
    expect(ct.params['access-type']).toBe('URL');
    expect(ct.params.url).toBe('ftp://cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar');
  });

  it('decodes charset and language (§4)', () => {
    const ct = parseContentType(parseHeaderBlock(Buffer.from(rfc2231Charset)).get('content-type'));
    expect(ct.params.title).toBe('This is ***fun***');
  });

  it('combines continuations with encoding (§4.1)', () => {
    const ct = parseContentType(parseHeaderBlock(Buffer.from(rfc2231Combined)).get('content-type'));
    expect(ct.params.title).toBe("This is even more ***fun*** isn't it!");
  });

  it('decodes a UTF-8 filename* and prefers it over the plain parameter', () => {
    const d = parseContentDisposition(`attachment; filename="fallback.txt"; filename*=utf-8''%E2%82%AC%20rates.txt`);
    expect(d?.type).toBe('attachment');
    expect(d?.params.filename).toBe('€ rates.txt');
  });

  it('decodes an RFC 2047 encoded-word filename but never a boundary', () => {
    expect(parseContentType('application/pdf; name="=?UTF-8?B?w6nDqS5wZGY=?="').params.name).toBe('éé.pdf');
    expect(parseContentType('multipart/mixed; boundary="=?utf-8?Q?x?="').params.boundary).toBe('=?utf-8?Q?x?=');
  });
});

describe('Content-Type', () => {
  it('parses type, subtype and quoted parameters with comments', () => {
    const ct = parseContentType('Text/HTML (a comment); charset="utf-8" ; format=flowed');
    expect(ct).toMatchObject({ mimeType: 'text/html', type: 'text', subtype: 'html', valid: true });
    expect(ct.params.charset).toBe('utf-8');
    expect(ct.params.format).toBe('flowed');
  });

  it('falls back to text/plain for absent or unparseable values, keeping the charset', () => {
    expect(parseContentType(null)).toMatchObject({ mimeType: 'text/plain', valid: false });
    const bad = parseContentType('text; charset=koi8-r');
    expect(bad).toMatchObject({ mimeType: 'text/plain', valid: false });
    expect(bad.params.charset).toBe('koi8-r');
  });

  it('does not let a parameter named __proto__ reach the prototype', () => {
    const ct = parseContentType('text/plain; __proto__=x; constructor=y');
    expect(ct.params.__proto__).toBe('x');
    expect(Object.getPrototypeOf(ct.params)).toBeNull();
  });
});

describe('address lists (RFC 5322 §3.4)', () => {
  it('parses display names, quoted names, comments and bare addresses', () => {
    expect(parseAddressList('"Doe, Jane" <jane@d3cloud.io>, bob@example.net (Bob B.), <x@y.z>')).toEqual([
      { name: 'Doe, Jane', address: 'jane@d3cloud.io' },
      { name: 'Bob B.', address: 'bob@example.net' },
      { name: '', address: 'x@y.z' },
    ]);
  });

  it('parses groups, including empty ones', () => {
    expect(parseAddressList('Team: a@x.org, "B" <b@x.org>;, Undisclosed recipients:;')).toEqual([
      { group: 'Team', members: [{ name: '', address: 'a@x.org' }, { name: 'B', address: 'b@x.org' }] },
      { group: 'Undisclosed recipients', members: [] },
    ]);
  });

  it('keeps quoted local parts that need quoting and unquotes those that do not', () => {
    expect(parseMailboxes('"john doe"@example.com, "plain"@example.com')).toEqual([
      { name: '', address: '"john doe"@example.com' },
      { name: '', address: 'plain@example.com' },
    ]);
  });

  it('handles obsolete routes, domain literals and UTF-8 (RFC 6532)', () => {
    expect(parseMailboxes('<@relay.example:user@example.com>')).toEqual([{ name: '', address: 'user@example.com' }]);
    expect(parseMailboxes('x@[192.0.2.1]')).toEqual([{ name: '', address: 'x@[192.0.2.1]' }]);
    expect(parseMailboxes('Jörg <jörg@bücher.example>')).toEqual([{ name: 'Jörg', address: 'jörg@bücher.example' }]);
  });

  it('decodes encoded-words in display names and joins adjacent ones', () => {
    expect(parseMailboxes('=?UTF-8?Q?Andr=C3=A9?= =?UTF-8?Q?_Pirard?= <a@b.c>')).toEqual([{ name: 'André Pirard', address: 'a@b.c' }]);
  });

  it('never throws on junk', () => {
    expect(() => parseAddressList('<<<>>>,,;;:: "unterminated (comment')).not.toThrow();
  });
});

describe('dates (RFC 5322 §3.3, §4.3)', () => {
  it('parses the canonical form', () => {
    expect(parseDate('Thu, 24 Sep 2026 09:15:02 -0400')?.toISOString()).toBe('2026-09-24T13:15:02.000Z');
  });

  it('parses obsolete forms', () => {
    expect(parseDate('24 Sep 26 09:15 EDT')?.toISOString()).toBe('2026-09-24T13:15:00.000Z');
    expect(parseDate('Fri, 21 Nov 97 09:55:06 GMT')?.toISOString()).toBe('1997-11-21T09:55:06.000Z');
    expect(parseDate('Thu,\r\n 13 Feb 1969 23:32 -0330 (Newfoundland Time)')?.toISOString()).toBe('1969-02-14T03:02:00.000Z');
    expect(parseDate('1 Jan 2020 00:00:00 Z')?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(parseDate('Mon, 1 Jan 2024 12:00:00 PST')?.toISOString()).toBe('2024-01-01T20:00:00.000Z');
  });

  it('returns null rather than an invalid date', () => {
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate('31 Feb 2024 10:00 +0000')).toBeNull();
    expect(parseDate('1 Jan 2024 25:00 +0000')).toBeNull();
    expect(parseDate('1 Foo 2024 10:00 +0000')).toBeNull();
  });
});

describe('message ids (RFC 5322 §3.6.4)', () => {
  it('parses Message-ID, References and In-Reply-To', () => {
    expect(parseMessageId(' <abc@example.com> ')).toBe('abc@example.com');
    expect(parseMessageIdList('<a@x>\r\n <b@x> (comment <not@this>) <c@x>')).toEqual(['a@x', 'b@x', 'c@x']);
    expect(parseMessageIdList('bare@example.com')).toEqual(['bare@example.com']);
    expect(parseMessageId('no id here')).toBeNull();
  });
});

describe('header blocks', () => {
  it('unfolds values, keeps raw bytes, and reads 8-bit as UTF-8 or Latin-1', () => {
    const block = Buffer.concat([
      Buffer.from('Subject: one\r\n two\r\nX-Utf8: '),
      Buffer.from('größe', 'utf8'),
      Buffer.from('\r\nX-Latin1: '),
      Buffer.from('größe', 'latin1'),
      Buffer.from('\r\nObs-Name : spaced\r\n\r\nignored: body'),
    ]);
    const h = parseHeaderBlock(block);
    expect(h.get('subject')).toBe('one two');
    expect(h.fields[0]?.raw.toString()).toBe('Subject: one\r\n two');
    expect(h.get('x-utf8')).toBe('größe');
    expect(h.fields.find((f) => f.key === 'x-latin1')).toMatchObject({ value: 'größe', latin1: true });
    expect(h.get('obs-name')).toBe('spaced');
    expect(h.get('ignored')).toBeNull();
  });
});

describe('charsets', () => {
  it('resolves WHATWG labels and common non-WHATWG aliases', () => {
    expect(resolveCharset('"ISO-8859-1"')).toBe('windows-1252');
    expect(resolveCharset('cp1252')).toBe('windows-1252');
    expect(resolveCharset('ks_c_5601-1987')).toBe('euc-kr');
    expect(resolveCharset('cp932')).toBe('shift_jis');
    expect(resolveCharset('iso8859_15')).toBe('iso-8859-15');
    expect(resolveCharset('x-gbk')).toBe('gbk');
    expect(resolveCharset('utf-7')).toBeNull();
  });
});
