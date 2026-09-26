import { parseHeaderFields } from '@postroom/auth-checks';
import { describe, expect, it } from 'vitest';
import { allowAllCaps } from '../../src/caps-seam.js';
import { formatRfc5322Date, inspectHeaders, parseAddressList, rewriteHeaders } from '../../src/headers.js';
import { decodeBase64Utf8, parsePlain, readCredentials } from '../../src/sasl.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('SASL', () => {
  it('PLAIN: authcid + password, empty or matching authzid only', () => {
    expect(parsePlain('\0me@d3cloud.io\0secret')).toEqual({ username: 'me@d3cloud.io', password: 'secret' });
    expect(parsePlain('ME@d3cloud.io\0me@d3cloud.io\0secret')).toEqual({ username: 'me@d3cloud.io', password: 'secret' });
    expect(parsePlain('boss@d3cloud.io\0me@d3cloud.io\0secret')).toBeNull();
    expect(parsePlain('\0me@d3cloud.io')).toBeNull();
    expect(parsePlain('\0\0secret')).toBeNull();
  });

  it('strict base64', () => {
    expect(decodeBase64Utf8(b64('héllo'))).toBe('héllo');
    expect(decodeBase64Utf8('not base64!')).toBeNull();
    expect(decodeBase64Utf8('YQ')).toBeNull();
    expect(decodeBase64Utf8(Buffer.from([0xff, 0xfe]).toString('base64'))).toBeNull();
  });

  it('LOGIN asks for username then password', async () => {
    const answers = [b64('me@d3cloud.io'), b64('pw')];
    const asked: string[] = [];
    const creds = await readCredentials(
      { mechanism: 'LOGIN', initialResponse: undefined },
      {
        challenge: (c) => {
          asked.push(Buffer.from(c, 'base64').toString());
          return Promise.resolve(answers.shift() ?? '');
        },
      },
    );
    expect(asked).toEqual(['Username:', 'Password:']);
    expect(creds).toEqual({ username: 'me@d3cloud.io', password: 'pw' });
  });

  it('unknown mechanism → null', async () => {
    expect(await readCredentials({ mechanism: 'CRAM-MD5', initialResponse: 'x' }, { challenge: () => Promise.resolve('') })).toBeNull();
  });
});

describe('From address list', () => {
  it.each([
    ['me@d3cloud.io', ['me@d3cloud.io']],
    ['Me <me@d3cloud.io>', ['me@d3cloud.io']],
    ['"Doe, <Jane>" <jane@d3cloud.io>', ['jane@d3cloud.io']],
    ['me@d3cloud.io (Me, Myself)', ['me@d3cloud.io']],
    ['a@x.test, "B" <b@y.test>', ['a@x.test', 'b@y.test']],
    ['Team: a@x.test, b@y.test;', ['a@x.test', 'b@y.test']],
    ['=?utf-8?q?J=C3=B6rg?= <jorg@d3cloud.io>', ['jorg@d3cloud.io']],
    ['<@relay.test:me@d3cloud.io>', ['me@d3cloud.io']],
  ])('%s', (value, expected) => {
    expect(parseAddressList(value)).toEqual(expected);
  });

  it.each(['"unterminated <a@b.test>', 'Me <a@b.test', 'a@b.test>', 'no-at-sign', 'Me <a@b.test> <c@d.test>', '(open comment a@b.test'])(
    'malformed: %s',
    (value) => {
      expect(parseAddressList(value)).toBeNull();
    },
  );
});

describe('header inspection and rewrite', () => {
  const block = (text: string): Buffer => Buffer.from(text, 'latin1');

  it('requires exactly one From', () => {
    expect(inspectHeaders(block('Subject: x\r\n'))).toEqual({ ok: false, reason: 'no-from' });
    expect(inspectHeaders(block('From: a@b.test\r\nFrom: c@d.test\r\n'))).toEqual({ ok: false, reason: 'multiple-from' });
    expect(inspectHeaders(block('From: nobody\r\n'))).toEqual({ ok: false, reason: 'bad-from' });
  });

  it('reads folded From, Subject, Message-ID', () => {
    const r = inspectHeaders(block('From: Me\r\n <me@d3cloud.io>\r\nSubject: hi\r\n there\r\nMessage-ID: <x@y>\r\n'));
    expect(r).toMatchObject({ ok: true, from: ['me@d3cloud.io'], subject: 'hi there', messageId: '<x@y>' });
  });

  it('strips Bcc (folded too), adds Message-ID and Date, keeps other bytes', () => {
    const fields = parseHeaderFields(block('From: me@d3cloud.io\r\nBcc: secret@x.test,\r\n other@y.test\r\nTo: you@x.test\r\n'));
    const r = rewriteHeaders(fields, { domain: 'd3cloud.io', now: new Date('2026-09-25T08:05:09Z') });
    const text = r.block.toString('latin1');
    expect(text).not.toMatch(/bcc|secret|other/i);
    expect(text.startsWith('From: me@d3cloud.io\r\nTo: you@x.test\r\n')).toBe(true);
    expect(r.messageId).toMatch(/^<[0-9a-f-]{36}@d3cloud\.io>$/);
    expect(text).toContain(`Message-ID: ${r.messageId}\r\n`);
    expect(text).toContain('Date: Fri, 25 Sep 2026 08:05:09 +0000\r\n');
    expect(r).toMatchObject({ addedMessageId: true, addedDate: true, strippedBcc: 1 });
  });

  it('keeps an existing Message-ID and Date', () => {
    const fields = parseHeaderFields(block('From: me@d3cloud.io\r\nMessage-ID: <keep@me>\r\nDate: Thu, 1 Jan 2026 00:00:00 +0000\r\n'));
    const r = rewriteHeaders(fields, { domain: 'd3cloud.io', now: new Date() });
    expect(r).toMatchObject({ messageId: '<keep@me>', addedMessageId: false, addedDate: false, strippedBcc: 0 });
  });

  it('formats RFC 5322 dates', () => {
    expect(formatRfc5322Date(new Date('2026-01-04T23:59:00Z'))).toBe('Sun, 4 Jan 2026 23:59:00 +0000');
  });
});

describe('caps seam', () => {
  it('allows everything until PST-T-1.10', async () => {
    expect(await allowAllCaps({ accountId: 'a', appPasswordId: 'p' }, ['x@y.test'])).toEqual({ action: 'allow' });
  });
});
