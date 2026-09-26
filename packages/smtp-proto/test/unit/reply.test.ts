import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ReplyParser,
  SmtpReplyError,
  buildEhloReply,
  formatReply,
  parseEhloCapabilities,
  reply,
  type SmtpReply,
} from '../../src/index.js';

const parseAll = (s: string): SmtpReply[] => new ReplyParser().push(Buffer.from(s, 'utf8'));

describe('formatReply', () => {
  it('formats single and multiline replies with enhanced codes', () => {
    expect(formatReply(reply(250, '2.1.0', 'Sender OK'))).toBe('250 2.1.0 Sender OK\r\n');
    expect(formatReply(reply(250, '2.0.0', 'one', 'two', 'three'))).toBe(
      '250-2.0.0 one\r\n250-2.0.0 two\r\n250 2.0.0 three\r\n',
    );
    expect(formatReply(reply(250, '2.1.0', 'Sender OK'), { enhanced: false })).toBe('250 Sender OK\r\n');
    expect(formatReply(reply(354, undefined, 'go ahead'))).toBe('354 go ahead\r\n');
  });

  it('never lets CR or LF from interpolated text reach the wire', () => {
    const evil = reply(550, '5.1.1', 'No such user <a@b>\r\n250 2.0.0 OK\nfake');
    const wire = formatReply(evil);
    expect(wire).toBe('550 5.1.1 No such user <a@b>  250 2.0.0 OK fake\r\n');
    expect(parseAll(wire)).toHaveLength(1);
  });

  it('refuses invalid codes (programming errors)', () => {
    expect(() => formatReply(reply(99, undefined, 'x'))).toThrow(TypeError);
    expect(() => formatReply(reply(250, '5.0.0', 'x'))).toThrow(TypeError);
  });

  it('builds an EHLO reply the client side can read back', () => {
    const r = buildEhloReply('mx.test', 'greets you', ['PIPELINING', 'SIZE 1000', 'AUTH PLAIN LOGIN']);
    const [parsed] = parseAll(formatReply(r));
    expect(parsed).toBeDefined();
    const caps = parseEhloCapabilities(parsed as SmtpReply);
    expect(caps.get('SIZE')).toEqual(['1000']);
    expect(caps.get('AUTH')).toEqual(['PLAIN', 'LOGIN']);
    expect(caps.has('PIPELINING')).toBe(true);
  });
});

describe('ReplyParser', () => {
  it('parses multiline replies incrementally', () => {
    const p = new ReplyParser();
    expect(p.push(Buffer.from('250-mx.test hi\r\n250-PIPE'))).toEqual([]);
    expect(p.pending).toBe(true);
    expect(p.push(Buffer.from('LINING\r\n250 SIZE 10\r\n220 x\r\n'))).toEqual([
      { code: 250, lines: ['mx.test hi', 'PIPELINING', 'SIZE 10'] },
      { code: 220, lines: ['x'] },
    ]);
    expect(p.pending).toBe(false);
  });

  it('checks code consistency and framing', () => {
    expect(() => parseAll('250-a\r\n251 b\r\n')).toThrow(SmtpReplyError);
    expect(() => parseAll('250 ok\n')).toThrow(SmtpReplyError);
    expect(() => parseAll('250 ok\rx\r\n')).toThrow(SmtpReplyError);
    expect(() => parseAll('25\r\n')).toThrow(SmtpReplyError);
    expect(() => parseAll('650 no\r\n')).toThrow(SmtpReplyError);
    expect(() => parseAll('250_no\r\n')).toThrow(SmtpReplyError);
    const p = new ReplyParser({ maxLineLength: 10 });
    expect(() => p.push(Buffer.from('250 0123456789abc\r\n'))).toThrow(SmtpReplyError);
    expect(() => p.push(Buffer.from('250 ok\r\n'))).toThrow(SmtpReplyError); // stays failed
  });

  it('accepts a bare code line', () => {
    expect(parseAll('250\r\n')).toEqual([{ code: 250, lines: [''] }]);
  });
});

describe('reply format → parse round-trip', () => {
  const text = fc
    .string({ unit: fc.integer({ min: 32, max: 126 }).map((c) => String.fromCharCode(c)), maxLength: 60 })
    .filter((t) => !/^\d\.\d/.test(t));
  const replyArb = fc
    .tuple(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 9 }))
    .chain(([c1, c2, c3]) => {
      const code = c1 * 100 + c2 * 10 + c3;
      const enhanced = c1 === 3 ? fc.constant(undefined) : fc.option(
        fc.tuple(fc.nat(999), fc.nat(999)).map(([a, b]) => `${String(c1)}.${String(a)}.${String(b)}`),
        { nil: undefined },
      );
      return fc.tuple(fc.constant(code), enhanced, fc.array(text, { minLength: 1, maxLength: 5 }));
    })
    .map(([code, enhanced, lines]) => reply(code, enhanced, ...lines));

  it('parse(format(r)) equals r, across arbitrary chunking', () => {
    fc.assert(
      fc.property(fc.array(replyArb, { minLength: 1, maxLength: 4 }), fc.array(fc.nat(), { maxLength: 10 }), (rs, cuts) => {
        const wire = Buffer.from(rs.map((r) => formatReply(r)).join(''), 'latin1');
        const points = [...new Set(cuts.map((c) => c % (wire.length + 1)))].sort((a, b) => a - b);
        const p = new ReplyParser();
        const got: SmtpReply[] = [];
        let prev = 0;
        for (const pt of [...points, wire.length]) {
          got.push(...p.push(wire.subarray(prev, pt)));
          prev = pt;
        }
        expect(got).toEqual(rs);
      }),
      { numRuns: 1000 },
    );
  });
});
