import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatCommand,
  parseCommand,
  type MailParams,
  type Mailbox,
  type ParseResult,
  type SmtpCommand,
} from '../../src/index.js';

const parse = (s: string, smtputf8 = false): ParseResult => parseCommand(Buffer.from(s, 'utf8'), { smtputf8 });
const cmd = (s: string, smtputf8 = false): SmtpCommand => {
  const r = parse(s, smtputf8);
  if (!r.ok) throw new Error(`expected ${s} to parse, got ${String(r.reply.code)} ${r.reply.lines.join(' ')}`);
  return r.command;
};
const code = (s: string, smtputf8 = false): number => {
  const r = parse(s, smtputf8);
  return r.ok ? 0 : r.reply.code;
};

describe('parseCommand', () => {
  it('parses EHLO/HELO with domains and address literals', () => {
    expect(cmd('EHLO mail.example.com')).toEqual({ verb: 'EHLO', domain: 'mail.example.com' });
    expect(cmd('ehlo [192.0.2.1]')).toEqual({ verb: 'EHLO', domain: '[192.0.2.1]' });
    expect(cmd('EHLO [IPv6:2001:db8::1]')).toEqual({ verb: 'EHLO', domain: '[IPv6:2001:db8::1]' });
    expect(cmd('HELO host')).toEqual({ verb: 'HELO', domain: 'host' });
    expect(code('EHLO')).toBe(501);
    expect(code('EHLO a b')).toBe(501);
    expect(code('EHLO [300.1.1.1]')).toBe(501);
    expect(code('EHLO -bad-.example')).toBe(501);
    expect(code('EHLO [tag:whatever]')).toBe(501);
  });

  it('parses MAIL FROM with the null path and parameters', () => {
    expect(cmd('MAIL FROM:<>')).toEqual({ verb: 'MAIL', from: { kind: 'null' }, params: {} });
    expect(cmd('mail from:<a@b.example> SIZE=1000 BODY=8bitmime SMTPUTF8 AUTH=<> RET=HDRS ENVID=QQ+2B1')).toEqual({
      verb: 'MAIL',
      from: { kind: 'mailbox', mailbox: { localPart: 'a', domain: 'b.example' } },
      params: { size: 1000, body: '8BITMIME', smtputf8: true, auth: '<>', ret: 'HDRS', envid: 'QQ+1' },
    });
    // Common practice: a space after the colon.
    expect(cmd('MAIL FROM: <a@b.example>')).toMatchObject({ verb: 'MAIL' });
  });

  it('parses quoted local parts and strips source routes', () => {
    expect(cmd('MAIL FROM:<"john \\"q\\" doe"@example.com>')).toMatchObject({
      from: { kind: 'mailbox', mailbox: { localPart: 'john "q" doe', domain: 'example.com' } },
    });
    expect(cmd('RCPT TO:<@relay1.example,@relay2.example:user@final.example>')).toMatchObject({
      to: { kind: 'mailbox', mailbox: { localPart: 'user', domain: 'final.example' } },
    });
    expect(cmd('RCPT TO:<user@[192.0.2.7]>')).toMatchObject({
      to: { kind: 'mailbox', mailbox: { domain: '[192.0.2.7]' } },
    });
  });

  it('accepts the bare <Postmaster> recipient and refuses a null forward path', () => {
    expect(cmd('RCPT TO:<Postmaster>')).toEqual({ verb: 'RCPT', to: { kind: 'postmaster' }, params: {} });
    expect(code('RCPT TO:<>')).toBe(501);
  });

  it('parses DSN RCPT parameters', () => {
    expect(cmd('RCPT TO:<a@b.example> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;a+40b.example')).toEqual({
      verb: 'RCPT',
      to: { kind: 'mailbox', mailbox: { localPart: 'a', domain: 'b.example' } },
      params: { notify: ['SUCCESS', 'FAILURE'], orcpt: { addrType: 'rfc822', address: 'a@b.example' } },
    });
    expect(code('RCPT TO:<a@b.example> NOTIFY=NEVER,SUCCESS')).toBe(501);
  });

  it('refuses malformed paths with the right codes', () => {
    expect(code('MAIL FROM:a@b.example')).toBe(501);
    expect(code('MAIL FROM:<a@b.example')).toBe(501);
    expect(code('MAIL FROM:<a..b@example.com>')).toBe(501);
    expect(code('MAIL FROM:<.a@example.com>')).toBe(501);
    expect(code('MAIL FROM:<a@>')).toBe(501);
    expect(code('MAIL FROM:<@x.example>')).toBe(501);
    expect(code('RCPT TO:<a b@example.com>')).toBe(501);
    expect(code(`MAIL FROM:<${'a'.repeat(65)}@example.com>`)).toBe(501);
    expect(code('MAIL TO:<a@b.example>')).toBe(501);
    expect(code('MAIL FROM:<a@b.example>SIZE=1')).toBe(501);
  });

  it('distinguishes 555 unknown parameters from 501 bad values', () => {
    expect(code('MAIL FROM:<a@b.example> FOO=bar')).toBe(555);
    expect(code('RCPT TO:<a@b.example> XYZ')).toBe(555);
    expect(code('MAIL FROM:<a@b.example> SIZE=abc')).toBe(501);
    expect(code('MAIL FROM:<a@b.example> BODY=BINARYMIME')).toBe(501);
    expect(code('MAIL FROM:<a@b.example> SIZE=1 SIZE=2')).toBe(501);
    expect(code('MAIL FROM:<a@b.example> SMTPUTF8=yes')).toBe(501);
  });

  it('requires SMTPUTF8 for UTF-8 addresses (RFC 6531)', () => {
    expect(code('MAIL FROM:<jöran@exämple.de>')).toBe(553);
    expect(cmd('MAIL FROM:<jöran@exämple.de> SMTPUTF8')).toMatchObject({
      from: { mailbox: { localPart: 'jöran', domain: 'exämple.de' } },
      params: { smtputf8: true },
    });
    expect(code('RCPT TO:<用户@例子.广告>')).toBe(553);
    expect(cmd('RCPT TO:<用户@例子.广告>', true)).toMatchObject({ to: { mailbox: { localPart: '用户' } } });
    expect(code('EHLO exämple.de')).toBe(500);
  });

  it('refuses control characters and invalid UTF-8', () => {
    expect(parseCommand(Buffer.from('NOOP \x00'))).toMatchObject({ ok: false, reply: { code: 500 } });
    expect(parseCommand(Buffer.from([0x4d, 0x41, 0x49, 0x4c, 0x20, 0xff, 0xfe]))).toMatchObject({
      ok: false,
      reply: { code: 500 },
    });
  });

  it('parses the simple verbs', () => {
    expect(cmd('DATA')).toEqual({ verb: 'DATA' });
    expect(cmd('rset')).toEqual({ verb: 'RSET' });
    expect(cmd('QUIT ')).toEqual({ verb: 'QUIT' });
    expect(cmd('STARTTLS')).toEqual({ verb: 'STARTTLS' });
    expect(cmd('NOOP')).toEqual({ verb: 'NOOP' });
    expect(cmd('NOOP hello')).toEqual({ verb: 'NOOP', argument: 'hello' });
    expect(cmd('HELP')).toEqual({ verb: 'HELP' });
    expect(cmd('VRFY postmaster')).toEqual({ verb: 'VRFY', argument: 'postmaster' });
    expect(code('VRFY')).toBe(501);
    expect(code('DATA now')).toBe(501);
    expect(code('STARTTLS please')).toBe(501);
    expect(code('EXPN list')).toBe(502);
    expect(code('BDAT 100 LAST')).toBe(502);
    expect(code('GET / HTTP/1.1')).toBe(500);
    expect(code('')).toBe(500);
  });

  it('parses AUTH with and without an initial response', () => {
    expect(cmd('AUTH plain')).toEqual({ verb: 'AUTH', mechanism: 'PLAIN' });
    expect(cmd('AUTH PLAIN AGEAYg==')).toEqual({ verb: 'AUTH', mechanism: 'PLAIN', initialResponse: 'AGEAYg==' });
    expect(cmd('AUTH PLAIN =')).toEqual({ verb: 'AUTH', mechanism: 'PLAIN', initialResponse: '=' });
    expect(code('AUTH PLAIN not*base64')).toBe(501);
    expect(code('AUTH')).toBe(501);
    expect(code('AUTH PLAIN a b')).toBe(501);
  });
});

// --- Properties -----------------------------------------------------------------------------------

const atext = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-/=?^_`{|}~".split(''));
const atom = fc.string({ unit: atext, minLength: 1, maxLength: 10 });
const dotString = fc.array(atom, { minLength: 1, maxLength: 3 }).map((a) => a.join('.'));
const qchar = fc.integer({ min: 32, max: 126 }).map((c) => String.fromCharCode(c));
const quoted = fc.string({ unit: qchar, maxLength: 20 });
const localPart = fc.oneof(dotString, quoted).filter((s) => Buffer.byteLength(s) <= 60);
const letDig = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''));
const label = fc
  .tuple(letDig, fc.string({ unit: fc.constantFrom(...'abc-xyz019'.split('')), maxLength: 10 }), letDig)
  .map(([a, mid, z]) => `${a}${mid}${z}`);
const domain = fc.oneof(
  fc.array(label, { minLength: 1, maxLength: 4 }).map((l) => l.join('.')),
  fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => `[${o.join('.')}]`),
);
const mailbox: fc.Arbitrary<Mailbox> = fc.record({ localPart, domain });
const xtextish = fc.string({ unit: fc.integer({ min: 33, max: 126 }).map((c) => String.fromCharCode(c)), minLength: 1, maxLength: 30 });
const mailParams: fc.Arbitrary<MailParams> = fc.record(
  {
    size: fc.nat(),
    body: fc.constantFrom('7BIT' as const, '8BITMIME' as const),
    smtputf8: fc.constant(true),
    auth: xtextish,
    ret: fc.constantFrom('FULL' as const, 'HDRS' as const),
    envid: xtextish,
  },
  { requiredKeys: [] },
);

describe('parseCommand ⇄ formatCommand', () => {
  it('round-trips MAIL paths and parameters', () => {
    fc.assert(
      fc.property(fc.option(mailbox, { nil: undefined }), mailParams, (mb, params) => {
        const c: SmtpCommand = {
          verb: 'MAIL',
          from: mb === undefined ? { kind: 'null' } : { kind: 'mailbox', mailbox: mb },
          params,
        };
        expect(parse(formatCommand(c))).toEqual({ ok: true, command: c });
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips RCPT paths', () => {
    fc.assert(
      fc.property(mailbox, (mb) => {
        const c: SmtpCommand = { verb: 'RCPT', to: { kind: 'mailbox', mailbox: mb }, params: {} };
        expect(parse(formatCommand(c))).toEqual({ ok: true, command: c });
      }),
      { numRuns: 1000 },
    );
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.boolean(), (bytes, utf8) => {
        const r = parseCommand(bytes, { smtputf8: utf8 });
        if (!r.ok) expect(r.reply.code).toBeGreaterThanOrEqual(500);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on arbitrary command-shaped strings', () => {
    const verb = fc.constantFrom('MAIL FROM:', 'RCPT TO:', 'EHLO ', 'AUTH ', 'mail from: ');
    fc.assert(
      fc.property(verb, fc.string({ maxLength: 120 }), (v, rest) => {
        parseCommand(Buffer.from(v + rest, 'utf8'), { smtputf8: true });
      }),
      { numRuns: 2000 },
    );
  });
});
