import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BodyHasher,
  canonicalizeBody,
  canonicalizeHeader,
  HeaderTooLargeError,
  parseCanonicalization,
  selectHeaders,
  splitMessage,
  type Canonicalization,
} from '../../src/index.js';

const MODES: readonly Canonicalization[] = ['simple', 'relaxed'];

async function drain(body: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(c);
  return Buffer.concat(parts);
}

async function canonicalHeaders(message: string, mode: Canonicalization): Promise<string> {
  const split = await splitMessage(Buffer.from(message, 'latin1'));
  return split.fields.map((f) => `${canonicalizeHeader(f.raw, mode)}\r\n`).join('');
}

// RFC 6376 §3.4.5, "Canonicalization Examples (INFORMATIVE)".
//   A: <SP> X <CRLF>
//   B <SP> : <SP> Y <HTAB><CRLF>
//                   <HTAB> Z <SP><SP><CRLF>
//   <CRLF>
//   <SP> C <SP><CRLF>
//   D <SP><HTAB><SP> E <CRLF>
//   <CRLF>
//   <CRLF>
const EXAMPLE = 'A: X\r\nB : Y\t\r\n\tZ  \r\n\r\n C \r\nD \t E\r\n\r\n\r\n';

describe('RFC 6376 §3.4.5 canonicalization example', () => {
  it('relaxed headers', async () => {
    expect(await canonicalHeaders(EXAMPLE, 'relaxed')).toBe('a:X\r\nb:Y Z\r\n');
  });

  it('relaxed body', async () => {
    const body = await drain((await splitMessage(Buffer.from(EXAMPLE, 'latin1'))).body);
    expect(canonicalizeBody(body, 'relaxed').toString('latin1')).toBe(' C\r\nD E\r\n');
  });

  it('simple headers', async () => {
    expect(await canonicalHeaders(EXAMPLE, 'simple')).toBe('A: X\r\nB : Y\t\r\n\tZ  \r\n');
  });

  it('simple body', async () => {
    const body = await drain((await splitMessage(Buffer.from(EXAMPLE, 'latin1'))).body);
    expect(canonicalizeBody(body, 'simple').toString('latin1')).toBe(' C \r\nD \t E\r\n');
  });
});

describe('RFC 6376 Appendix A example message', () => {
  // A.1: the body, as the RFC gives it (single space after "game.").
  const body = 'Hi.\r\n\r\nWe lost the game. Are you hungry yet?\r\n\r\nJoe.\r\n';
  // A.2 publishes bh= for c=simple/simple; relaxed gives the same bytes for this body.
  const BH = '2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=';

  it('simple body hash matches the published bh=', () => {
    expect(new BodyHasher('simple').update(Buffer.from(body)).digest().toString('base64')).toBe(BH);
  });

  it('relaxed body hash matches too (the body has nothing to relax)', () => {
    expect(new BodyHasher('relaxed').update(Buffer.from(body)).digest().toString('base64')).toBe(BH);
  });

  it('relaxed headers', async () => {
    const msg =
      'From: Joe SixPack <joe@football.example.com>\r\n' +
      'To: Suzie Q <suzie@shopping.example.net>\r\n' +
      'Subject: Is dinner ready?\r\n' +
      'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)\r\n' +
      'Message-ID: <20030712040037.46341.5F8J@football.example.com>\r\n' +
      '\r\n' +
      body;
    expect(await canonicalHeaders(msg, 'relaxed')).toBe(
      'from:Joe SixPack <joe@football.example.com>\r\n' +
        'to:Suzie Q <suzie@shopping.example.net>\r\n' +
        'subject:Is dinner ready?\r\n' +
        'date:Fri, 11 Jul 2003 21:00:37 -0700 (PDT)\r\n' +
        'message-id:<20030712040037.46341.5F8J@football.example.com>\r\n',
    );
    expect(await canonicalHeaders(msg, 'simple')).toBe(msg.slice(0, msg.indexOf('\r\n\r\n') + 2));
  });
});

describe('body canonicalization edge cases', () => {
  it.each([
    ['', 'simple', '\r\n'],
    ['', 'relaxed', ''],
    ['\r\n\r\n\r\n', 'simple', '\r\n'],
    ['\r\n \t\r\n', 'relaxed', ''],
    ['\r\n \t\r\n', 'simple', '\r\n \t\r\n'],
    ['abc', 'simple', 'abc\r\n'],
    ['abc  ', 'relaxed', 'abc\r\n'],
    ['a\r\n\r\nb\r\n\r\n', 'simple', 'a\r\n\r\nb\r\n'],
    ['  lead\t\ttrail  \r\n', 'relaxed', ' lead trail\r\n'],
    ['x\ry\r\n', 'relaxed', 'x\ry\r\n'],
  ] as const)('%j under %s', (input, mode, expected) => {
    expect(canonicalizeBody(input, mode).toString('latin1')).toBe(expected);
  });

  it('l= hashes only the first l canonical bytes and reports the full length', () => {
    const h = new BodyHasher('relaxed', 5).update(Buffer.from('hello   world\r\n'));
    const digest = h.digest();
    expect(digest.equals(createHash('sha256').update('hello').digest())).toBe(true);
    expect(h.canonicalLength).toBe('hello world\r\n'.length);
  });
});

describe('message splitting', () => {
  it('finds the blank line across chunk boundaries and streams the rest', async () => {
    const msg = 'From: a@b.example\r\nSubject: x\r\n\r\nline1\r\nline2\r\n';
    for (let cut = 1; cut < msg.length; cut++) {
      const stream = Readable.from([Buffer.from(msg.slice(0, cut)), Buffer.from(msg.slice(cut))]);
      const split = await splitMessage(stream);
      expect(split.headerBlock.toString()).toBe('From: a@b.example\r\nSubject: x\r\n');
      expect(split.fields.map((f) => f.key)).toEqual(['from', 'subject']);
      expect((await drain(split.body)).toString()).toBe('line1\r\nline2\r\n');
    }
  });

  it('keeps folded fields whole, with their original bytes', async () => {
    const split = await splitMessage(Buffer.from('Subject: a\r\n  b\r\nTo: c\r\n\r\n'));
    expect(split.fields.map((f) => f.raw.toString())).toEqual(['Subject: a\r\n  b', 'To: c']);
  });

  it('handles a message with no body and one with no headers', async () => {
    const noBody = await splitMessage(Buffer.from('From: a\r\n'));
    expect(noBody.fields).toHaveLength(1);
    expect((await drain(noBody.body)).length).toBe(0);
    const noHead = await splitMessage(Buffer.from('\r\nbody\r\n'));
    expect(noHead.fields).toHaveLength(0);
    expect((await drain(noHead.body)).toString()).toBe('body\r\n');
  });

  it('bounds the header block', async () => {
    const big = `X-Big: ${'a'.repeat(2000)}\r\n\r\nbody`;
    await expect(splitMessage(Buffer.from(big), { maxHeaderBytes: 1000 })).rejects.toThrow(HeaderTooLargeError);
    const chunks = Array.from({ length: 100 }, () => Buffer.from('X-A: aaaaaaaaaaaaaaaaaaaa\r\n'));
    await expect(splitMessage(Readable.from(chunks), { maxHeaderBytes: 1000 })).rejects.toThrow(HeaderTooLargeError);
  });

  it('selects repeated headers bottom-up and nothing for an oversigned name', async () => {
    const split = await splitMessage(Buffer.from('X: 1\r\nY: a\r\nX: 2\r\n\r\n'));
    const sel = selectHeaders(split.fields, ['x', 'X', 'x', 'y']);
    expect(sel.map((f) => f.raw.toString())).toEqual(['X: 2', 'X: 1', 'Y: a']);
  });
});

describe('c= parsing', () => {
  it('defaults and rejects unknown algorithms', () => {
    expect(parseCanonicalization(undefined)).toEqual({ header: 'simple', body: 'simple' });
    expect(parseCanonicalization('relaxed')).toEqual({ header: 'relaxed', body: 'simple' });
    expect(parseCanonicalization('relaxed/relaxed')).toEqual({ header: 'relaxed', body: 'relaxed' });
    expect(parseCanonicalization('nowsp/simple')).toBeUndefined();
  });
});

// ---- properties ----

const bodyText = fc
  .array(fc.constantFrom('a', 'b', ' ', '\t', '\r', '\n', '\r\n', '\r\n\r\n', 'é'), { maxLength: 80 })
  .map((xs) => xs.join(''));

function chunkAt(buf: Buffer, cuts: number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(buf.subarray(prev, p));
    prev = p;
  }
  out.push(buf.subarray(prev));
  return out;
}

describe('properties', () => {
  it('streaming body hash over any chunking equals the one-shot hash', () => {
    fc.assert(
      fc.property(
        bodyText,
        fc.array(fc.nat(), { maxLength: 10 }),
        fc.constantFrom(...MODES),
        fc.option(fc.nat({ max: 100 }), { nil: undefined }),
        (text, cuts, mode, limit) => {
          const buf = Buffer.from(text, 'latin1');
          const oneShot = new BodyHasher(mode, limit).update(buf);
          const streamed = new BodyHasher(mode, limit);
          for (const c of chunkAt(buf, cuts)) streamed.update(c);
          expect(streamed.digest().equals(oneShot.digest())).toBe(true);
          expect(streamed.canonicalLength).toBe(oneShot.canonicalLength);
          expect(oneShot.canonicalLength).toBe(canonicalizeBody(buf, mode).length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('body canonicalization is idempotent (both modes)', () => {
    fc.assert(
      fc.property(bodyText, fc.constantFrom(...MODES), (text, mode) => {
        const once = canonicalizeBody(text, mode);
        expect(canonicalizeBody(once, mode).equals(once)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('relaxed header canonicalization is idempotent', () => {
    const name = fc
      .array(fc.constantFrom('A', 'b', 'X', '-', 'z'), { minLength: 1, maxLength: 10 })
      .map((xs) => xs.join(''));
    const value = fc
      .array(fc.constantFrom('v', 'W', ' ', '\t', '\r\n ', '\r\n\t', ':', 'é'), { maxLength: 40 })
      .map((xs) => xs.join(''));
    fc.assert(
      fc.property(name, fc.constantFrom('', ' ', '\t '), value, (n, ws, v) => {
        const once = canonicalizeHeader(`${n}${ws}:${v}`, 'relaxed');
        expect(canonicalizeHeader(once, 'relaxed')).toBe(once);
        expect(once.startsWith(`${n.toLowerCase()}:`)).toBe(true);
        expect(/[\r\n\t]| {2}| $/.test(once)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
