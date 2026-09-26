// smtp-in over loopback against a real database: every reply code the daemon can give, the relay
// refusal from any source (PST-REQ-053), recipient policy (PST-REQ-052/068), SIZE (PST-REQ-051),
// PROXY v2 from the edge peer only (PST-REQ-016), STARTTLS, and the Received / SPF inputs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DkimResult, EvaluateSpfResult, SpfDns } from '@postroom/auth-checks';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { reply } from '@postroom/smtp-proto';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import { acceptMessage, type AcceptMessage, type InboundContext } from '../../src/data.js';
import { createSmtpInServer, type SmtpInOptions, type SmtpInServer } from '../../src/server.js';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];
const FORWARDED_IP = '203.0.113.7';

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.warn(`openssl unavailable, skipping the STARTTLS tests: ${String(err)}`);
    return false;
  }
}
const OPENSSL = haveOpenssl();

const spfDns: SpfDns = {
  txt: (name) =>
    Promise.resolve(
      name === 'sender.example' ? { records: [`v=spf1 ip4:${FORWARDED_IP} -all`], void: false } : { records: [], void: true },
    ),
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

interface Captured {
  ctx: InboundContext;
  spf: EvaluateSpfResult;
  dkim: DkimResult[];
  bytes: number;
}

describe.skipIf(baseUrl === undefined)('smtp-in', () => {
  let t: TestDatabase;
  const servers: SmtpInServer[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let captured: Captured[] = [];
  let acceptor: AcceptMessage = acceptMessage;
  let direct = 0;
  let proxied = 0;
  let tiny = 0;
  let tlsPort = 0;
  let certDir = '';

  const capture: AcceptMessage = async (ctx, body, verdicts) => {
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    captured.push({ ctx, spf: verdicts.spf, dkim: await verdicts.dkim, bytes });
    return reply(250, '2.0.0', 'captured');
  };

  async function start(overrides: Partial<SmtpInOptions> = {}): Promise<number> {
    const server = createSmtpInServer({
      db: t.db,
      hostname: 'mx.d3cloud.io',
      maxSize: MAX_MESSAGE_SIZE,
      edgePeers: ['10.77.0.1'],
      proxyTimeoutMs: 5_000,
      maxConnectionsPerIp: 50,
      maxRecipientsPerMessage: 100,
      maxRecipientsPerSession: 150,
      maxErrors: 10,
      idleTimeoutMs: 60_000,
      spfDns,
      dkimDns: { txt: () => Promise.resolve([]) },
      reverseLookup: (ip) => Promise.resolve(ip === FORWARDED_IP ? 'out.sender.example' : null),
      acceptMessage: (ctx, body, verdicts) => acceptor(ctx, body, verdicts),
      log: (event, fields = {}) => logs.push({ event, fields }),
      ...overrides,
    });
    servers.push(server);
    return (await server.listen(0, '127.0.0.1')).port;
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t22');
    const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const other = await t.db.account.create({ data: { displayName: 'Other' } });
    await t.db.address.createMany({
      data: [
        { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId },
        { localPart: 'postmaster', domainId, kind: 'service', accountId: operatorId },
        { localPart: 'shop.x7k2', domainId, kind: 'masked', accountId: operatorId, siteTag: 'shop.example' },
        { localPart: 'old.a1b2', domainId, kind: 'masked', accountId: operatorId, siteTag: 'old.example', killedAt: new Date() },
      ],
    });
    const team = await t.db.address.create({ data: { localPart: 'team', domainId, kind: 'alias' } });
    await t.db.addressTarget.createMany({
      data: [
        { addressId: team.id, accountId: operatorId },
        { addressId: team.id, accountId: other.id },
      ],
    });

    direct = await start();
    proxied = await start({ edgePeers: ['127.0.0.1'], proxyTimeoutMs: 300 });
    tiny = await start({ maxConnectionsPerIp: 2, idleTimeoutMs: 300 });
    if (OPENSSL) {
      certDir = mkdtempSync(join(tmpdir(), 'smtp-in-tls-'));
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
          '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=mx.test',
        ],
        { stdio: 'ignore' },
      );
      tlsPort = await start({
        tls: { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    if (certDir !== '') rmSync(certDir, { recursive: true, force: true });
    await t.drop();
  });

  beforeEach(() => {
    captured = [];
    acceptor = acceptMessage;
  });

  async function ready(port: number, helo = 'client.example'): Promise<TestClient> {
    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd(`EHLO ${helo}`)).code).toBe(250);
    return c;
  }

  async function sendMessage(c: TestClient, body = 'Subject: hi\r\n\r\nhello\r\n'): Promise<string> {
    const r = await c.cmd('DATA');
    expect(r.code).toBe(354);
    c.write(`${body}.\r\n`);
    return codeOf(await c.next());
  }

  it('220 greeting, 250 EHLO with SIZE 104857600 and no AUTH or STARTTLS without a cert, 221 QUIT', async () => {
    const c = await TestClient.open(direct);
    const greeting = await c.next();
    expect(greeting.code).toBe(220);
    expect(greeting.lines[0]).toMatch(/^mx\.d3cloud\.io /);
    const ehlo = await c.cmd('EHLO client.example');
    expect(ehlo.code).toBe(250);
    const caps = ehlo.lines.slice(1);
    expect(caps).toEqual(expect.arrayContaining(['SIZE 104857600', 'PIPELINING', '8BITMIME', 'SMTPUTF8', 'ENHANCEDSTATUSCODES']));
    expect(caps.some((l) => l.startsWith('AUTH'))).toBe(false);
    expect(caps).not.toContain('STARTTLS');
    expect(codeOf(await c.cmd('AUTH PLAIN AGFAYg=='))).toBe('502 5.5.1');
    expect(codeOf(await c.cmd('STARTTLS'))).toBe('502 5.5.1');
    expect(codeOf(await c.quit())).toBe('221 2.0.0');
  });

  it('503 for commands out of sequence', async () => {
    const c = await TestClient.open(direct);
    await c.next();
    expect((await c.cmd('MAIL FROM:<a@sender.example>')).code).toBe(503);
    await c.cmd('EHLO client.example');
    expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('503 5.5.1');
    expect(codeOf(await c.cmd('DATA'))).toBe('503 5.5.1');
    expect(codeOf(await c.cmd('MAIL FROM:<a@sender.example>'))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd('MAIL FROM:<a@sender.example>'))).toBe('503 5.5.1');
    await c.quit();
  });

  it('501 for syntax errors', async () => {
    const c = await TestClient.open(direct);
    await c.next();
    expect((await c.cmd('EHLO')).code).toBe(501);
    await c.cmd('EHLO client.example');
    expect((await c.cmd('MAIL FROM:a@sender.example')).code).toBe(501);
    expect((await c.cmd('MAIL FROM:<a@sender.example> BOGUS=1')).code).toBe(555);
    await c.quit();
  });

  it('500 for an unknown command, and 500 then close for a bare LF', async () => {
    const c = await ready(direct);
    expect(codeOf(await c.cmd('FROB'))).toBe('500 5.5.1');
    c.write('NOOP\n');
    expect(codeOf(await c.next())).toBe('500 5.5.2');
    expect(await c.closed()).toBe(true);
  });

  it('550 5.7.1 for a domain we do not serve: no relay, even from loopback', async () => {
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    expect(codeOf(await c.cmd('RCPT TO:<someone@gmail.com>'))).toBe('550 5.7.1');
    expect(codeOf(await c.cmd('RCPT TO:<matt@[127.0.0.1]>'))).toBe('550 5.7.1');
    expect(codeOf(await c.cmd('RCPT TO:<matt@sub.d3cloud.io>'))).toBe('550 5.7.1');
    // And from our own domain in MAIL FROM: still no relay.
    await c.cmd('RSET');
    await c.cmd('MAIL FROM:<matt@d3cloud.io>');
    expect(codeOf(await c.cmd('RCPT TO:<someone@gmail.com>'))).toBe('550 5.7.1');
    await c.quit();
  });

  it('550 5.1.1 for an unknown local part and a killed masked alias; 250 for mailbox, alias, plus and live masked', async () => {
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    expect(codeOf(await c.cmd('RCPT TO:<nobody@d3cloud.io>'))).toBe('550 5.1.1');
    expect(codeOf(await c.cmd('RCPT TO:<old.a1b2@d3cloud.io>'))).toBe('550 5.1.1');
    expect(codeOf(await c.cmd('RCPT TO:<ghost+tag@d3cloud.io>'))).toBe('550 5.1.1');
    expect(codeOf(await c.cmd('RCPT TO:<Matt@D3Cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<team@d3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<matt+receipts@d3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<shop.x7k2@d3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<Postmaster>'))).toBe('250 2.1.5');
    acceptor = capture;
    expect(await sendMessage(c)).toBe('250 2.0.0');
    const got = captured[0];
    expect(got?.ctx.recipients.map((r) => [r.rcpt, r.resolution.kind])).toEqual([
      ['Matt@D3Cloud.io', 'mailbox'],
      ['team@d3cloud.io', 'alias'],
      ['matt+receipts@d3cloud.io', 'plus'],
      ['shop.x7k2@d3cloud.io', 'masked'],
      ['Postmaster', 'service'],
    ]);
    expect(got?.ctx.recipients[1]?.resolution.accountIds).toHaveLength(2);
    expect(got?.ctx.recipients[2]?.resolution.tag).toBe('receipts');
    await c.quit();
  });

  it('452 4.5.3 past 100 recipients in a message, and past the per-session limit', async () => {
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    for (let i = 0; i < 100; i++) c.write(`RCPT TO:<matt+${String(i)}@d3cloud.io>\r\n`);
    for (let i = 0; i < 100; i++) expect((await c.next()).code).toBe(250);
    expect(codeOf(await c.cmd('RCPT TO:<matt+over@d3cloud.io>'))).toBe('452 4.5.3');
    await c.cmd('RSET');
    await c.cmd('MAIL FROM:<a@sender.example>');
    for (let i = 0; i < 50; i++) expect((await c.cmd(`RCPT TO:<matt+s${String(i)}@d3cloud.io>`)).code).toBe(250);
    const over = await c.cmd('RCPT TO:<matt+last@d3cloud.io>');
    expect(codeOf(over)).toBe('452 4.5.3');
    expect(over.lines[0]).toMatch(/session/);
    await c.quit();
  });

  it('552 5.3.4 for SIZE over 104857600 at MAIL FROM; the limit itself is fine', async () => {
    const c = await ready(direct);
    expect(codeOf(await c.cmd('MAIL FROM:<a@sender.example> SIZE=104857601'))).toBe('552 5.3.4');
    expect(codeOf(await c.cmd('MAIL FROM:<a@sender.example> SIZE=104857600'))).toBe('250 2.1.0');
    await c.quit();
  });

  it('554 for DATA with no valid recipients', async () => {
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    await c.cmd('RCPT TO:<someone@gmail.com>');
    expect(codeOf(await c.cmd('DATA'))).toBe('554 5.5.1');
    await c.quit();
  });

  it('451 4.3.0 from the data.ts seam until inbound storage lands (PST-T-2.6)', async () => {
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    await c.cmd('RCPT TO:<matt@d3cloud.io>');
    expect(await sendMessage(c)).toBe('451 4.3.0');
    // The session goes on after a refused message.
    expect(codeOf(await c.cmd('NOOP'))).toBe('250 2.0.0');
    await c.quit();
  });

  it('records SPF at MAIL FROM without rejecting on fail, and writes a Received header with the client IP', async () => {
    acceptor = capture;
    const c = await ready(direct, 'client.example');
    expect(codeOf(await c.cmd('MAIL FROM:<bob@sender.example>'))).toBe('250 2.1.0');
    await c.cmd('RCPT TO:<matt@d3cloud.io>');
    expect(await sendMessage(c)).toBe('250 2.0.0');
    const got = captured[0];
    expect(got?.ctx.clientIp).toBe('127.0.0.1');
    expect(got?.spf).toMatchObject({ result: 'fail', domain: 'sender.example', scope: 'mfrom' });
    expect(got?.dkim).toEqual([]);
    const received = got?.ctx.receivedHeader.replace(/\r\n\t/g, ' ') ?? '';
    expect(received).toMatch(
      /^Received: from client\.example \(unknown \[127\.0\.0\.1\]\) by mx\.d3cloud\.io \(Postroom\) with ESMTP id \w+ for <matt@d3cloud\.io>; \w{3}, /,
    );
    await c.quit();
  });

  it('552 5.3.4 for a body over 104857600 octets during DATA, streamed', async () => {
    acceptor = capture;
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<a@sender.example>');
    await c.cmd('RCPT TO:<matt@d3cloud.io>');
    expect((await c.cmd('DATA')).code).toBe(354);
    const line = Buffer.from(`${'x'.repeat(998)}\r\n`);
    const chunk = Buffer.concat(Array.from({ length: 1024 }, () => line)); // ~1 MB
    await c.writeAsync(Buffer.from('Subject: big\r\n\r\n'));
    let sent = 0;
    while (sent <= MAX_MESSAGE_SIZE) {
      await c.writeAsync(chunk);
      sent += chunk.length;
    }
    c.write('.\r\n');
    expect(codeOf(await c.next())).toBe('552 5.3.4');
    expect(captured).toHaveLength(0);
    expect(codeOf(await c.cmd('NOOP'))).toBe('250 2.0.0');
    await c.quit();
  }, 120_000);

  it('421 after an error flood', async () => {
    const c = await ready(direct);
    for (let i = 0; i < 10; i++) c.write('FROB\r\n');
    const replies = [];
    for (let i = 0; i < 11; i++) replies.push(codeOf(await c.next()));
    expect(replies.slice(0, 10).every((r) => r === '500 5.5.1')).toBe(true);
    expect(replies[10]).toBe('421 4.7.0');
    expect(await c.closed()).toBe(true);
  });

  it('421 4.4.2 on idle timeout', async () => {
    const c = await ready(tiny);
    expect(codeOf(await c.next())).toBe('421 4.4.2');
    expect(await c.closed()).toBe(true);
  });

  it('421 past the per-IP connection limit', async () => {
    const a = await ready(tiny);
    const b = await ready(tiny);
    const third = await TestClient.open(tiny);
    expect(codeOf(await third.next())).toBe('421 4.7.0');
    expect(await third.closed()).toBe(true);
    await a.quit();
    await b.quit();
  });

  describe('PROXY v2 (PST-REQ-016)', () => {
    const header = (source: string): Buffer =>
      encodeProxyV2({
        command: 'PROXY',
        family: 'TCP4',
        source: { address: source, port: 40_000 },
        destination: { address: '10.77.0.2', port: 25 },
      });

    it('from the trusted peer: the session uses the forwarded client IP for SPF and Received', async () => {
      acceptor = capture;
      const c = await TestClient.open(proxied, header(FORWARDED_IP));
      expect((await c.next()).code).toBe(220);
      await c.cmd('EHLO out.sender.example');
      expect(codeOf(await c.cmd('MAIL FROM:<bob@sender.example>'))).toBe('250 2.1.0');
      expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
      expect(await sendMessage(c, 'From: bob@sender.example\r\nSubject: via edge\r\n\r\nhello\r\n')).toBe('250 2.0.0');
      const got = captured[0];
      expect(got?.ctx.clientIp).toBe(FORWARDED_IP);
      expect(got?.ctx.clientPort).toBe(40_000);
      expect(got?.ctx.rdns).toBe('out.sender.example');
      expect(got?.spf).toMatchObject({ result: 'pass', domain: 'sender.example' });
      expect(got?.spf.mechanism).toMatch(/ip4/);
      expect(got?.ctx.receivedHeader.replace(/\r\n\t/g, ' ')).toContain(`from out.sender.example (out.sender.example [${FORWARDED_IP}])`);
      await c.quit();
    });

    it('from the trusted peer: still no relay, for any forwarded address', async () => {
      for (const source of [FORWARDED_IP, '10.77.0.1', '127.0.0.1', '192.168.1.10']) {
        const c = await TestClient.open(proxied, header(source));
        expect((await c.next()).code).toBe(220);
        await c.cmd('EHLO client.example');
        await c.cmd('MAIL FROM:<a@sender.example>');
        expect(codeOf(await c.cmd('RCPT TO:<someone@gmail.com>'))).toBe('550 5.7.1');
        await c.quit();
      }
    });

    it('from the trusted peer without a header: closed without a greeting', async () => {
      const c = await TestClient.open(proxied);
      expect(await c.closed()).toBe(true);
      await expect(c.next()).rejects.toThrow(/closed/);
      expect(logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('timed out'))).toBe(true);
    });

    it('from the trusted peer with a malformed or LOCAL header: closed', async () => {
      const bad = await TestClient.open(proxied, Buffer.from('EHLO client.example\r\n'));
      expect(await bad.closed()).toBe(true);
      const local = await TestClient.open(proxied, encodeProxyV2({ command: 'LOCAL', family: 'UNSPEC' }));
      expect(await local.closed()).toBe(true);
      await expect(local.next()).rejects.toThrow(/closed/);
    });

    it('from anyone else: a PROXY header closes the connection', async () => {
      const c = await TestClient.open(direct, header(FORWARDED_IP));
      expect(await c.closed()).toBe(true);
      // At most the greeting (sent on connect) — the header is never parsed as commands.
      const got: number[] = [];
      for (;;) {
        try {
          got.push((await c.next()).code);
        } catch {
          break;
        }
      }
      expect(got.every((code) => code === 220)).toBe(true);
      expect(logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('not the edge'))).toBe(true);
    });
  });

  describe.skipIf(!OPENSSL)('STARTTLS', () => {
    it('is offered when a certificate is configured, and upgrades to ESMTPS', async () => {
      acceptor = capture;
      const c = await ready(tlsPort);
      const ehlo = await c.cmd('EHLO client.example');
      expect(ehlo.lines).toContain('STARTTLS');
      expect(codeOf(await c.cmd('STARTTLS'))).toBe('220 2.0.0');
      await c.startTls();
      const again = await c.cmd('EHLO client.example');
      expect(again.code).toBe(250);
      expect(again.lines).not.toContain('STARTTLS');
      expect(again.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
      await c.cmd('MAIL FROM:<a@sender.example>');
      expect(codeOf(await c.cmd('RCPT TO:<someone@gmail.com>'))).toBe('550 5.7.1');
      await c.cmd('RCPT TO:<matt@d3cloud.io>');
      expect(await sendMessage(c)).toBe('250 2.0.0');
      expect(captured[0]?.ctx.secure).toBe(true);
      expect(captured[0]?.ctx.receivedHeader).toContain('with ESMTPS');
      await c.quit();
    });
  });

  it('logs one structured line per session with envelopes and outcomes, never bodies', async () => {
    acceptor = capture;
    const c = await ready(direct);
    await c.cmd('MAIL FROM:<logcheck@sender.example>');
    await c.cmd('RCPT TO:<someone@gmail.com>');
    await c.cmd('RCPT TO:<matt@d3cloud.io>');
    expect(await sendMessage(c, 'Subject: secret-subject\r\n\r\nsecret-body\r\n')).toBe('250 2.0.0');
    await c.quit();
    const deadline = Date.now() + 2_000;
    let entry: (typeof logs)[number] | undefined;
    while (entry === undefined && Date.now() < deadline) {
      entry = logs.find((l) => l.event === 'session' && JSON.stringify(l.fields).includes('logcheck@sender.example'));
      if (entry === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(entry).toBeDefined();
    const text = JSON.stringify(entry);
    expect(text).not.toContain('secret');
    expect(entry?.fields['transactions']).toEqual([
      {
        id: expect.any(String) as unknown,
        from: 'logcheck@sender.example',
        spf: 'fail',
        rcpts: [
          { to: 'someone@gmail.com', code: 550, enhanced: '5.7.1', outcome: 'relay-denied' },
          { to: 'matt@d3cloud.io', code: 250, enhanced: '2.1.5', outcome: 'mailbox' },
        ],
        data: { code: 250, enhanced: '2.0.0' },
      },
    ]);
  });
});
