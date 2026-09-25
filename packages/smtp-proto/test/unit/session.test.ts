import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Replies, reply, type ReversePath, type SmtpReply } from '../../src/index.js';
import { SMUGGLING_CASES, smugglingBody } from './fixtures/smuggling.js';
import { drain, startSession } from './helpers.js';

const codes = (rs: readonly SmtpReply[]): number[] => rs.map((r) => r.code);

describe('session basics', () => {
  it('greets, answers EHLO with capabilities, and says goodbye', async () => {
    const h = await startSession({ capabilities: { dsn: true } });
    h.send('EHLO client.example\r\n');
    const ehlo = await h.replies.next();
    expect(ehlo.code).toBe(250);
    expect(ehlo.lines).toEqual([
      'mx.test greets client.example',
      'PIPELINING',
      'SIZE 10000000',
      '8BITMIME',
      'SMTPUTF8',
      'ENHANCEDSTATUSCODES',
      'DSN',
    ]);
    h.send('NOOP\r\nVRFY someone\r\nHELP\r\nQUIT\r\n');
    expect(codes(await h.replies.take(4))).toEqual([250, 252, 214, 221]);
    await h.replies.closed();
    await h.session.done;
  });

  it('delivers a message through the hooks with the envelope in context', async () => {
    let seen: { from: ReversePath | undefined; rcpts: number; body: string } = { from: undefined, rcpts: 0, body: '' };
    const h = await startSession({
      hooks: {
        onData: async (body, ctx) => {
          const text = (await drain(body)).toString('latin1');
          seen = { from: ctx.transaction?.from, rcpts: ctx.transaction?.recipients.length ?? 0, body: text };
          return reply(250, '2.0.0', 'Queued as X');
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example>\r\nRCPT TO:<x@mx.test>\r\nRCPT TO:<y@mx.test>\r\nDATA\r\n');
    expect(codes(await h.replies.take(5))).toEqual([250, 250, 250, 250, 354]);
    h.send('Subject: t\r\n\r\n..dot\r\nend\r\n.\r\n');
    const final = await h.replies.next();
    expect(final).toMatchObject({ code: 250, enhanced: '2.0.0', lines: ['Queued as X'] });
    expect(seen).toEqual({
      from: { kind: 'mailbox', mailbox: { localPart: 'a', domain: 'b.example' } },
      rcpts: 2,
      body: 'Subject: t\r\n\r\n.dot\r\nend\r\n',
    });
    // The transaction is over: a new MAIL is allowed.
    h.send('MAIL FROM:<>\r\nQUIT\r\n');
    expect(codes(await h.replies.take(2))).toEqual([250, 221]);
  });
});

describe('sequencing (503)', () => {
  it('refuses commands out of order', async () => {
    const h = await startSession();
    h.send('MAIL FROM:<a@b.example>\r\n');
    expect(await h.replies.next()).toMatchObject({ code: 503 });
    h.send('EHLO c\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
    expect(codes(await h.replies.take(3))).toEqual([250, 503, 503]);
    h.send('MAIL FROM:<a@b.example>\r\nMAIL FROM:<c@d.example>\r\nDATA\r\n');
    expect(codes(await h.replies.take(3))).toEqual([250, 503, 554]);
    h.send('RSET\r\nRCPT TO:<x@mx.test>\r\n');
    expect(codes(await h.replies.take(2))).toEqual([250, 503]);
  });

  it('refuses parameters that were not advertised (555) and HELO sessions get none', async () => {
    const h = await startSession({ capabilities: { smtpUtf8: false } });
    h.send('HELO c\r\nMAIL FROM:<a@b.example> SIZE=10\r\nEHLO c\r\nMAIL FROM:<a@b.example> SMTPUTF8\r\n');
    expect(codes(await h.replies.take(4))).toEqual([250, 555, 250, 555]);
    h.send('MAIL FROM:<a@b.example> RET=FULL\r\nRCPT TO:<a@b.example> NOTIFY=NEVER\r\n');
    expect(codes(await h.replies.take(2))).toEqual([555, 503]);
  });

  it('closes after too many errors', async () => {
    const h = await startSession({ maxErrors: 3 });
    h.send('BOGUS\r\nBOGUS\r\nBOGUS\r\nNOOP\r\n');
    expect(codes(await h.replies.take(4))).toEqual([500, 500, 500, 421]);
    await h.replies.closed();
  });

  it('enforces the recipient limit', async () => {
    const h = await startSession({ maxRecipients: 2 });
    h.send('EHLO c\r\nMAIL FROM:<>\r\nRCPT TO:<a@mx.test>\r\nRCPT TO:<b@mx.test>\r\nRCPT TO:<c@mx.test>\r\n');
    expect(codes(await h.replies.take(5))).toEqual([250, 250, 250, 250, 452]);
  });
});

describe('pipelining (RFC 2920)', () => {
  it('runs pipelined commands strictly in order and answers them in one write', async () => {
    const order: string[] = [];
    const h = await startSession({
      hooks: {
        onMail: async () => {
          order.push('mail:start');
          await sleep(20);
          order.push('mail:end');
          return undefined;
        },
        onRcpt: async (to) => {
          const name = to.kind === 'mailbox' ? to.mailbox.localPart : 'postmaster';
          order.push(`rcpt:${name}:start`);
          await sleep(name === 'slow' ? 30 : 1);
          order.push(`rcpt:${name}:end`);
          return name === 'nobody' ? reply(550, '5.1.1', 'No such user') : Replies.rcptOk;
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example>\r\nRCPT TO:<slow@mx.test>\r\nRCPT TO:<nobody@mx.test>\r\nRCPT TO:<fast@mx.test>\r\nDATA\r\n');
    const rs = await h.replies.take(6);
    expect(codes(rs)).toEqual([250, 250, 250, 550, 250, 354]);
    expect(order).toEqual([
      'mail:start',
      'mail:end',
      'rcpt:slow:start',
      'rcpt:slow:end',
      'rcpt:nobody:start',
      'rcpt:nobody:end',
      'rcpt:fast:start',
      'rcpt:fast:end',
    ]);
    // All six replies arrived in a single read: flushed together at the DATA sync point.
    // all[0] is the greeting.
    expect(new Set(h.replies.all.slice(1, 7).map((e) => e.read)).size).toBe(1);
    h.send('x\r\n.\r\nQUIT\r\n');
    expect(codes(await h.replies.take(2))).toEqual([250, 221]);
  });
});

describe('SIZE', () => {
  it('refuses a declared SIZE over the limit at MAIL', async () => {
    const h = await startSession({ maxSize: 1000 });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example> SIZE=1001\r\n');
    expect(codes(await h.replies.take(2))).toEqual([250, 552]);
  });

  it('drains an oversize message to the terminator, then answers 552 and stays in sync', async () => {
    let hookError: unknown = null;
    const h = await startSession({
      maxSize: 1000,
      hooks: {
        onData: async (body) => {
          try {
            await drain(body);
          } catch (err) {
            hookError = err;
            throw err;
          }
          return reply(250, '2.0.0', 'Queued');
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example>\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
    expect(codes(await h.replies.take(4))).toEqual([250, 250, 250, 354]);
    const line = `${'z'.repeat(98)}\r\n`;
    for (let i = 0; i < 100; i++) h.send(line);
    h.send('.\r\nNOOP\r\n');
    const [final, noop] = await h.replies.take(2);
    expect(final).toMatchObject({ code: 552, enhanced: '5.3.4' });
    expect(noop?.code).toBe(250);
    expect(hookError).toMatchObject({ name: 'SmtpDataRejectedError', reason: 'too-large' });
  });
});

describe('strict CRLF (PST-REQ-049)', () => {
  it('answers a bare LF in a command with 500 5.5.2 and closes; the command is never run', async () => {
    let mailCalls = 0;
    const h = await startSession({
      hooks: {
        onMail: () => {
          mailCalls++;
          return undefined;
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example>\nRCPT TO:<x@mx.test>\r\n');
    const [ehlo, err] = await h.replies.take(2);
    expect(ehlo?.code).toBe(250);
    expect(err).toMatchObject({ code: 500, enhanced: '5.5.2' });
    await h.replies.closed();
    expect(mailCalls).toBe(0);
  });

  describe.each(SMUGGLING_CASES.map((c) => [c.name, c] as const))('smuggling through the engine: %s', (_n, c) => {
    it(c.reject ? 'is refused with a 5xx and nothing smuggled runs' : 'stays data and nothing smuggled runs', async () => {
      const froms: string[] = [];
      let delivered: string | null = null;
      const h = await startSession({
        hooks: {
          onMail: (from) => {
            froms.push(from.kind === 'mailbox' ? from.mailbox.localPart : '<>');
            return undefined;
          },
          onData: async (body) => {
            delivered = (await drain(body)).toString('latin1');
            return reply(250, '2.0.0', 'Queued');
          },
        },
      });
      h.send('EHLO attacker.example\r\nMAIL FROM:<attacker@evil.example>\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
      expect(codes(await h.replies.take(4))).toEqual([250, 250, 250, 354]);
      h.send(`${smugglingBody(c.sequence)}\r\n.\r\n`);
      const final = await h.replies.next();
      h.send('QUIT\r\n');
      expect((await h.replies.next()).code).toBe(221);
      expect(froms).toEqual(['attacker']);
      if (c.reject) {
        expect(final.code).toBeGreaterThanOrEqual(500);
        expect(final.code).toBeLessThan(600);
        expect(delivered).toBeNull();
      } else {
        expect(final.code).toBe(250);
        expect(delivered).toContain('MAIL FROM:<ceo@victim.example>');
      }
      await h.session.done;
    });
  });
});

describe('DATA hook contract', () => {
  it('answers 451 when the hook throws', async () => {
    const errors: unknown[] = [];
    const h = await startSession({
      hooks: {
        onData: async (body) => {
          await drain(body);
          throw new Error('disk full');
        },
        onError: (e) => errors.push(e),
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<>\r\nRCPT TO:<x@mx.test>\r\nDATA\r\nhi\r\n.\r\n');
    expect(codes(await h.replies.take(5))).toEqual([250, 250, 250, 354, 451]);
    expect(errors).toHaveLength(1);
  });

  it('never lets a 2xx returned before end-of-data stand', async () => {
    const h = await startSession({ hooks: { onData: () => reply(250, '2.0.0', 'too early') } });
    h.send('EHLO c\r\nMAIL FROM:<>\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
    expect(codes(await h.replies.take(4))).toEqual([250, 250, 250, 354]);
    await sleep(10);
    h.send('hi\r\n.\r\n');
    expect((await h.replies.next()).code).toBe(451);
  });

  it('destroys the body stream when the client disconnects mid-DATA', async () => {
    let failure: unknown = null;
    const h = await startSession({
      hooks: {
        onData: async (body) => {
          try {
            await drain(body);
          } catch (err) {
            failure = err;
            throw err;
          }
          return reply(250, '2.0.0', 'Queued');
        },
      },
    });
    h.send('EHLO c\r\nMAIL FROM:<>\r\nRCPT TO:<x@mx.test>\r\nDATA\r\n');
    await h.replies.take(4);
    h.send('partial message\r\n');
    h.client.end();
    await h.session.done;
    expect(failure).toMatchObject({ name: 'SmtpDataRejectedError', reason: 'connection-closed' });
  });
});

describe('AUTH exchange', () => {
  it('runs a SASL exchange with challenges and records the identity', async () => {
    const h = await startSession({
      secure: true,
      capabilities: { auth: ['PLAIN', 'LOGIN'] },
      hooks: {
        onAuth: async ({ mechanism, initialResponse }, sasl) => {
          expect(mechanism).toBe('LOGIN');
          expect(initialResponse).toBeUndefined();
          const user = Buffer.from(await sasl.challenge(Buffer.from('Username:').toString('base64')), 'base64').toString();
          const pass = Buffer.from(await sasl.challenge(Buffer.from('Password:').toString('base64')), 'base64').toString();
          return pass === 'app-pass' ? { ok: true, identity: user } : { ok: false, reply: reply(535, '5.7.8', 'Bad credentials') };
        },
        onMail: (_from, _params, ctx) => (ctx.auth?.identity === 'alice' ? undefined : reply(530, '5.7.0', 'Auth required')),
      },
    });
    h.send('EHLO c\r\n');
    const ehlo = await h.replies.next();
    expect(ehlo.lines).toContain('AUTH PLAIN LOGIN');
    h.send('AUTH LOGIN\r\n');
    expect(await h.replies.next()).toMatchObject({ code: 334, lines: ['VXNlcm5hbWU6'] });
    h.send(`${Buffer.from('alice').toString('base64')}\r\n`);
    expect((await h.replies.next()).code).toBe(334);
    h.send(`${Buffer.from('app-pass').toString('base64')}\r\n`);
    expect(await h.replies.next()).toMatchObject({ code: 235 });
    h.send('MAIL FROM:<alice@mx.test>\r\nAUTH PLAIN AGFsaWNlAHg=\r\n');
    expect(codes(await h.replies.take(2))).toEqual([250, 503]);
  });

  it('handles cancellation and refuses AUTH over plaintext by default', async () => {
    const h = await startSession({
      capabilities: { auth: ['PLAIN'] },
      hooks: {
        onAuth: async (_r, sasl) => {
          await sasl.challenge('');
          return { ok: true, identity: 'never' };
        },
      },
    });
    h.send('EHLO c\r\n');
    expect((await h.replies.next()).lines.some((l) => l.startsWith('AUTH'))).toBe(false);
    h.send('AUTH PLAIN\r\n');
    expect(await h.replies.next()).toMatchObject({ code: 538 });

    const t = await startSession({
      secure: true,
      capabilities: { auth: ['PLAIN'] },
      hooks: {
        onAuth: async (_r, sasl) => {
          await sasl.challenge('');
          return { ok: true, identity: 'never' };
        },
      },
    });
    t.send('EHLO c\r\nAUTH PLAIN\r\n');
    expect(codes(await t.replies.take(2))).toEqual([250, 334]);
    t.send('*\r\n');
    expect(await t.replies.next()).toMatchObject({ code: 501 });
    expect(t.session.context.auth).toBeNull();
  });
});
