// PST-REQ-029: when STARTTLS completes, bytes buffered before the handshake are discarded.
//
// The attack (CVE-2011-0411 and its many descendants): the client sends "STARTTLS\r\n" and a
// plaintext command in the same packet. A server that keeps its plaintext input buffer across the
// upgrade executes the injected command as if it had arrived over TLS. Here it must never run.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ReplyParser,
  Replies,
  createServerSession,
  reply,
  tlsUpgrader,
  type ServerSession,
  type SmtpReply,
} from '../../src/index.js';
import { ReplyCollector, drain, startSession } from './helpers.js';

describe('STARTTLS buffer discard (in-memory upgrade)', () => {
  it('never executes plaintext pipelined after STARTTLS, before or after the upgrade', async () => {
    const mails: string[] = [];
    const h = await startSession({
      hooks: {
        // An identity "upgrade": the same stream carries on, so any byte the engine failed to
        // discard would be read and executed as a command after the upgrade.
        upgradeTls: (s) => Promise.resolve(s),
        onMail: (from) => {
          mails.push(from.kind === 'mailbox' ? from.mailbox.localPart : '<>');
          return undefined;
        },
      },
    });
    h.send('EHLO c\r\n');
    expect((await h.replies.next()).lines).toContain('STARTTLS');
    const injected = 'MAIL FROM:<a@evil.example>\r\nRCPT TO:<x@mx.test>\r\n';
    h.send(`STARTTLS\r\n${injected}`);
    expect(await h.replies.next()).toMatchObject({ code: 220, enhanced: '2.0.0' });
    await sleep(20);
    // Nothing else was answered: the injected MAIL and RCPT were not executed.
    expect(h.replies.all).toHaveLength(3);
    expect(h.session.stats.discardedOnStartTls).toBe(injected.length);
    expect(h.session.context.secure).toBe(true);

    // After the upgrade the session starts over (RFC 3207 §4.2): EHLO forgotten, no transaction.
    h.send('RCPT TO:<x@mx.test>\r\nEHLO c\r\nRCPT TO:<x@mx.test>\r\n');
    const [rcpt1, ehlo, rcpt2] = await h.replies.take(3);
    expect(rcpt1?.code).toBe(503);
    expect(ehlo?.code).toBe(250);
    expect(ehlo?.lines).not.toContain('STARTTLS');
    expect(rcpt2?.code).toBe(503);
    h.send('STARTTLS\r\n');
    expect((await h.replies.next()).code).toBe(503);
    expect(mails).toEqual([]);
  });

  it('forgets AUTH and the transaction across the upgrade', async () => {
    const h = await startSession({ hooks: { upgradeTls: (s) => Promise.resolve(s) } });
    h.send('EHLO c\r\nMAIL FROM:<a@b.example>\r\nSTARTTLS\r\n');
    expect((await h.replies.take(3)).map((r) => r.code)).toEqual([250, 250, 220]);
    expect(h.session.context.transaction).toBeNull();
    expect(h.session.context.hello).toBeNull();
  });

  it('refuses STARTTLS when no upgrade hook is configured', async () => {
    const h = await startSession();
    h.send('EHLO c\r\n');
    expect((await h.replies.next()).lines).not.toContain('STARTTLS');
    h.send('STARTTLS\r\n');
    expect((await h.replies.next()).code).toBe(502);
  });
});

// --- Real TLS over TCP loopback (ephemeral port) --------------------------------------------------

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.warn(`openssl unavailable, skipping real-TLS STARTTLS test: ${String(err)}`);
    return false;
  }
}

const OPENSSL = haveOpenssl();

describe.skipIf(!OPENSSL)('STARTTLS buffer discard (real TLS; skipped when openssl is missing)', () => {
  let dir = '';
  let key = Buffer.alloc(0);
  let cert = Buffer.alloc(0);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smtp-proto-tls-'));
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=mx.test',
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'));
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  async function listen(mails: string[]): Promise<{ port: number; sessions: ServerSession[]; close: () => Promise<void> }> {
    const sessions: ServerSession[] = [];
    const server = createServer((sock) => {
      sessions.push(
        createServerSession(sock, {
          hostname: 'mx.test',
          maxSize: 1_000_000,
          hooks: {
            upgradeTls: tlsUpgrader({ key, cert }),
            onMail: (from) => {
              mails.push(from.kind === 'mailbox' ? from.mailbox.localPart : '<>');
              return undefined;
            },
            onRcpt: () => Replies.rcptOk,
            onData: async (body) => {
              await drain(body);
              return reply(250, '2.0.0', 'Queued');
            },
            onError: () => undefined,
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return {
      port,
      sessions,
      close: () =>
        new Promise<void>((r) => {
          server.close(() => {
            r();
          });
        }),
    };
  }

  /** Read replies from the plaintext socket until `n` have arrived, then stop listening. */
  async function plaintextReplies(sock: Socket, n: number, parser: ReplyParser): Promise<SmtpReply[]> {
    const out: SmtpReply[] = [];
    await new Promise<void>((resolve, reject) => {
      const onData = (c: Buffer): void => {
        try {
          out.push(...parser.push(c));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        if (out.length >= n) {
          sock.off('data', onData);
          sock.pause();
          resolve();
        }
      };
      sock.on('data', onData);
      sock.resume();
    });
    return out;
  }

  it('STARTTLS\\r\\nMAIL FROM:<a@evil> in one packet: MAIL never runs, before or after TLS', async () => {
    const mails: string[] = [];
    const srv = await listen(mails);
    const sock = connect(srv.port, '127.0.0.1');
    const parser = new ReplyParser();
    expect((await plaintextReplies(sock, 1, parser))[0]?.code).toBe(220);
    sock.write('EHLO client.test\r\n');
    const [ehlo] = await plaintextReplies(sock, 1, parser);
    expect(ehlo?.lines).toContain('STARTTLS');

    sock.write('STARTTLS\r\nMAIL FROM:<a@evil.example>\r\n'); // one write, one packet on loopback
    const [ready] = await plaintextReplies(sock, 1, parser);
    expect(ready?.code).toBe(220);
    expect(parser.pending).toBe(false); // no plaintext reply to the injected MAIL

    const secure = tlsConnect({ socket: sock, rejectUnauthorized: false, servername: 'mx.test' });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    const replies = new ReplyCollector(secure);
    // If the injected MAIL had survived the upgrade, this RCPT would be accepted (250).
    secure.write('EHLO client.test\r\nRCPT TO:<x@mx.test>\r\n');
    const [ehlo2, rcpt] = await replies.take(2);
    expect(ehlo2?.code).toBe(250);
    expect(ehlo2?.lines).not.toContain('STARTTLS');
    expect(rcpt?.code).toBe(503);
    secure.write('QUIT\r\n');
    expect((await replies.next()).code).toBe(221);
    await replies.closed();

    expect(mails).toEqual([]);
    expect(srv.sessions[0]?.stats.discardedOnStartTls).toBe('MAIL FROM:<a@evil.example>\r\n'.length);
    expect(srv.sessions[0]?.context.secure).toBe(true);
    await srv.close();
  });

  it('plaintext injected in a later packet is handed to TLS, where it cannot run either', async () => {
    const mails: string[] = [];
    const srv = await listen(mails);
    const sock = connect(srv.port, '127.0.0.1');
    const parser = new ReplyParser();
    await plaintextReplies(sock, 1, parser);
    sock.write('EHLO client.test\r\n');
    await plaintextReplies(sock, 1, parser);
    sock.write('STARTTLS\r\n');
    sock.write('MAIL FROM:<a@evil.example>\r\n');
    await plaintextReplies(sock, 1, parser);
    await sleep(100);
    sock.destroy();
    await srv.sessions[0]?.done;
    expect(mails).toEqual([]);
    await srv.close();
  });
});
