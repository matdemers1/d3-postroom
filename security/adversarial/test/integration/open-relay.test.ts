// Adversarial class 1 — open relay (PST-REQ-087, PST-REQ-053 "no relay, ever, from any source").
//
// Expected safe behaviour:
//   smtp-in    accepts a RCPT only for an address at a domain Postroom serves, whoever connects —
//              loopback, a private address forwarded by the edge, a client that tried AUTH — and
//              whatever the path looks like: source routes, the %-hack, bang paths, quoted local
//              parts, postmaster variants, address literals, IDN / uppercase / trailing-dot
//              domains. Nothing it accepts is ever queued for outbound delivery.
//   submission refuses every transaction without AUTH; with AUTH (an app password) it relays, but
//              only for envelope and header senders the account owns.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { b64, codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, DOMAIN, World, type Account } from './support/world.js';

describe.skipIf(DATABASE_URL === undefined)('adversarial: open relay (PST-REQ-087 / PST-REQ-053)', () => {
  let w: World;
  let alice: Account;
  let bob: Account;
  let mx = 0;
  let mxViaEdge = 0;
  let sub587 = 0;
  let sub465 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_relay');
    alice = await w.account();
    bob = await w.account();
    mx = (await w.smtpIn()).port;
    // A second smtp-in that treats loopback as the edge's WireGuard peer, so a test can forward
    // any client address through a real PROXY v2 header.
    mxViaEdge = (await w.smtpIn({ edgePeers: ['127.0.0.1'] })).port;
    const s = await w.submission();
    sub587 = s.port587;
    sub465 = s.port465;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const proxyFrom = (source: string): Buffer =>
    encodeProxyV2({ command: 'PROXY', family: 'TCP4', source: { address: source, port: 40_000 }, destination: { address: '10.77.0.2', port: 25 } });

  async function mxSession(port = mx, prefix?: Buffer): Promise<SmtpClient> {
    const c = await SmtpClient.plain(port, prefix);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO attacker.example')).code).toBe(250);
    return c;
  }

  /** Every way we know of to name a mailbox somewhere else. None may come back 2xx. */
  const RELAY_PATHS: readonly (readonly [string, string])[] = [
    ['plain foreign domain', '<victim@gmail.com>'],
    ['uppercase foreign domain', '<VICTIM@GMAIL.COM>'],
    ['our domain as a suffix label', '<victim@d3cloud.io.evil.example>'],
    ['our domain as a prefix label', '<victim@evil-d3cloud.io>'],
    ['a subdomain of ours', '<victim@mx.d3cloud.io>'],
    ['trailing dot on a foreign domain', '<victim@gmail.com.>'],
    ['trailing dot on our domain', '<matt@d3cloud.io.>'],
    ['source route via our domain', '<@d3cloud.io:victim@gmail.com>'],
    ['source route via two of our hops', '<@d3cloud.io,@mx.d3cloud.io:victim@gmail.com>'],
    ['percent hack', '<victim%gmail.com@d3cloud.io>'],
    ['double percent hack', '<victim%gmail.com%d3cloud.io@d3cloud.io>'],
    ['bang path', '<gmail.com!victim@d3cloud.io>'],
    ['double @', '<victim@gmail.com@d3cloud.io>'],
    ['quoted local part hiding an @', '<"victim@gmail.com"@d3cloud.io>'],
    ['quoted local part hiding a %', '<"victim%gmail.com"@d3cloud.io>'],
    ['quoted local part hiding a route', '<"@gmail.com:victim"@d3cloud.io>'],
    ['postmaster at a foreign domain', '<postmaster@gmail.com>'],
    ['Postmaster at a foreign domain, mixed case', '<PostMaster@Gmail.Com>'],
    ['IPv4 address literal', '<victim@[127.0.0.1]>'],
    ['IPv4 address literal of a public host', '<victim@[203.0.113.9]>'],
    ['IPv6 address literal', '<victim@[IPv6:::1]>'],
    ['general address literal', '<victim@[tag:gmail.com]>'],
    ['punycode look-alike of our domain', '<victim@xn--d3clud-hya.io>'],
    ['no angle brackets', 'victim@gmail.com'],
    ['no domain at all', '<victim>'],
    ['empty local part', '<@gmail.com>'],
    ['NUL inside the address', '<victim@gmail.com\u0000@d3cloud.io>'],
  ];

  it('smtp-in: refuses every foreign or disguised recipient from loopback, and DATA then has no recipient', async () => {
    const c = await mxSession();
    expect(codeOf(await c.cmd('MAIL FROM:<attacker@evil.example>'))).toBe('250 2.1.0');
    for (const [what, path] of RELAY_PATHS) {
      const r = await c.cmd(`RCPT TO:${path}`);
      expect(r.code, `${what}: ${path} → ${codeOf(r)}`).toBeGreaterThanOrEqual(500);
    }
    // Nothing was accepted, so there is no message to take.
    expect(codeOf(await c.cmd('DATA'))).toBe('554 5.5.1');
    c.close();
  });

  it('smtp-in: the relay-shaped paths are refused with 550 5.7.1 (policy), not merely as syntax', async () => {
    const c = await mxSession();
    await c.cmd('MAIL FROM:<attacker@evil.example>');
    for (const path of [
      '<victim@gmail.com>',
      '<VICTIM@GMAIL.COM>',
      '<victim@d3cloud.io.evil.example>',
      '<victim@mx.d3cloud.io>',
      '<@d3cloud.io:victim@gmail.com>',
      '<postmaster@gmail.com>',
      '<victim@[127.0.0.1]>',
      '<victim@[IPv6:::1]>',
    ]) {
      expect(codeOf(await c.cmd(`RCPT TO:${path}`)), path).toBe('550 5.7.1');
    }
    // Local-part tricks at our domain name no mailbox: 550 5.1.1, never forwarded.
    for (const path of ['<victim%gmail.com@d3cloud.io>', '<gmail.com!victim@d3cloud.io>', '<"victim@gmail.com"@d3cloud.io>']) {
      expect(codeOf(await c.cmd(`RCPT TO:${path}`)), path).toBe('550 5.1.1');
    }
    c.close();
  });

  it('smtp-in: SMTPUTF8 and IDN foreign domains are refused too', async () => {
    const c = await mxSession();
    expect((await c.cmd('MAIL FROM:<attacker@evil.example> SMTPUTF8')).code).toBe(250);
    for (const path of ['<victim@gmaïl.com>', '<victim@d3clöud.io>', '<victim@ｄ３cloud.io>', '<жертва@почта.рф>']) {
      const r = await c.cmd(`RCPT TO:${path}`);
      expect(r.code, `${path} → ${codeOf(r)}`).toBeGreaterThanOrEqual(500);
    }
    expect(codeOf(await c.cmd('DATA'))).toBe('554 5.5.1');
    c.close();
  });

  it('smtp-in: local postmaster variants and a route through a foreign host stay local', async () => {
    const c = await mxSession();
    await c.cmd('MAIL FROM:<attacker@evil.example>');
    // <Postmaster> must always be accepted (RFC 5321 §4.5.1) — for OUR postmaster.
    expect(codeOf(await c.cmd('RCPT TO:<Postmaster>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<POSTMASTER@D3CLOUD.IO>'))).toBe('250 2.1.5');
    // A source route is stripped (RFC 5321 Appendix C): the hop is ignored and the mailbox is ours.
    expect(codeOf(await c.cmd(`RCPT TO:<@gmail.com:${alice.address}>`))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('DATA'))).toBe('354');
    c.write(`From: attacker@evil.example\r\nTo: ${alice.address}\r\nSubject: local\r\n\r\nhi\r\n.\r\n`);
    expect((await c.next()).code).toBe(250);
    const stored = await w.db.inboundMessage.findMany({ orderBy: { receivedAt: 'desc' }, take: 1 });
    const rcpts = JSON.stringify(stored[0]?.recipients);
    expect(rcpts).not.toContain('gmail.com');
    c.close();
  });

  it('smtp-in: no AUTH is offered, and trying it grants nothing', async () => {
    const c = await mxSession();
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`\0${alice.address}\0${alice.smtpPassword}`)}`))).toBe('502 5.5.1');
    expect(codeOf(await c.cmd('AUTH LOGIN'))).toBe('502 5.5.1');
    // RFC 4954's AUTH= MAIL parameter is not a way in either.
    expect((await c.cmd(`MAIL FROM:<${alice.address}> AUTH=${alice.address}`)).code).toBe(555);
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd('RCPT TO:<victim@gmail.com>'))).toBe('550 5.7.1');
    c.close();
  });

  it('smtp-in: over STARTTLS the policy is the same', async () => {
    const c = await mxSession();
    expect(codeOf(await c.cmd('STARTTLS'))).toBe('220 2.0.0');
    await c.upgrade();
    expect((await c.cmd('EHLO attacker.example')).code).toBe(250);
    await c.cmd(`MAIL FROM:<${alice.address}>`);
    expect(codeOf(await c.cmd('RCPT TO:<victim@gmail.com>'))).toBe('550 5.7.1');
    c.close();
  });

  it('smtp-in via the edge: a forwarded private, loopback or edge address is never trusted to relay', async () => {
    for (const source of ['127.0.0.1', '10.0.0.5', '10.77.0.1', '172.16.3.4', '192.168.1.10', '100.64.0.7', '203.0.113.7']) {
      const c = await mxSession(mxViaEdge, proxyFrom(source));
      await c.cmd(`MAIL FROM:<${alice.address}>`);
      expect(codeOf(await c.cmd('RCPT TO:<victim@gmail.com>')), source).toBe('550 5.7.1');
      expect(codeOf(await c.cmd('RCPT TO:<@d3cloud.io:victim@gmail.com>')), source).toBe('550 5.7.1');
      c.close();
    }
  });

  it('smtp-in: nothing ever reaches the outbound queue', async () => {
    expect(await w.db.outboundMessage.count()).toBe(0);
    expect(await w.db.job.count({ where: { queue: 'outbound' } })).toBe(0);
  });

  // --- submission -----------------------------------------------------------------------------

  async function sub587Tls(): Promise<SmtpClient> {
    const c = await SmtpClient.plain(sub587);
    expect((await c.next()).code).toBe(220);
    await c.cmd('EHLO attacker.example');
    expect((await c.cmd('STARTTLS')).code).toBe(220);
    await c.upgrade();
    expect((await c.cmd('EHLO attacker.example')).code).toBe(250);
    return c;
  }

  async function authed(acct: Account): Promise<SmtpClient> {
    const c = await SmtpClient.implicitTls(sub465);
    expect((await c.next()).code).toBe(220);
    await c.cmd('EHLO client.example');
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`\0${acct.address}\0${acct.smtpPassword}`)}`))).toBe('235 2.7.0');
    return c;
  }

  it('submission: no transaction without AUTH — plaintext, STARTTLS or implicit TLS, any sender', async () => {
    const before = await w.db.outboundMessage.count();
    const plain = await SmtpClient.plain(sub587);
    await plain.next();
    await plain.cmd('EHLO attacker.example');
    expect(codeOf(await plain.cmd(`MAIL FROM:<${alice.address}>`))).toBe('530 5.7.0');
    expect(codeOf(await plain.cmd('RCPT TO:<victim@gmail.com>'))).toBe('503 5.5.1');
    expect(codeOf(await plain.cmd('DATA'))).toBe('503 5.5.1');
    plain.close();

    const tls = await sub587Tls();
    for (const from of [`<${alice.address}>`, '<>', '<postmaster@d3cloud.io>', '<victim@gmail.com>']) {
      expect(codeOf(await tls.cmd(`MAIL FROM:${from}`)), from).toBe('530 5.7.0');
    }
    // Claiming an authenticated submitter with the AUTH= parameter is not authentication.
    expect(codeOf(await tls.cmd(`MAIL FROM:<${alice.address}> AUTH=${alice.address}`))).toBe('530 5.7.0');
    expect(codeOf(await tls.cmd('RCPT TO:<victim@gmail.com>'))).toBe('503 5.5.1');
    tls.close();

    const implicit = await SmtpClient.implicitTls(sub465);
    await implicit.next();
    await implicit.cmd('EHLO attacker.example');
    expect(codeOf(await implicit.cmd(`MAIL FROM:<${alice.address}>`))).toBe('530 5.7.0');
    implicit.close();
    expect(await w.db.outboundMessage.count()).toBe(before);
  });

  it('submission: an authenticated account may only use envelope senders it owns', async () => {
    const c = await authed(alice);
    for (const from of [
      `<${bob.address}>`,
      '<postmaster@d3cloud.io>',
      '<victim@gmail.com>',
      '<>',
      `<${alice.login}@gmail.com>`,
      `<${alice.login}@mx.${DOMAIN}>`,
      `<"${alice.address}"@evil.example>`,
      `<${alice.login}%evil.example@${DOMAIN}>`,
    ]) {
      expect(codeOf(await c.cmd(`MAIL FROM:${from}`)), from).toBe('553 5.7.1');
    }
    // Case in the address is not ownership; the address is.
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address.toUpperCase()}>`))).toBe('250 2.1.0');
    c.close();
  });

  it('submission: an authenticated account may only use header From addresses it owns', async () => {
    const before = await w.db.outboundMessage.count();
    const spoofs = [
      `From: ${bob.address}`,
      `From: "${alice.address}" <${bob.address}>`,
      `From: ${alice.address}, ${bob.address}`,
      `From: Team: ${alice.address}, ${bob.address};`,
      `From: ${bob.address} (${alice.address})`,
      `From: <@${DOMAIN}:${bob.address}>`,
      `From: ${alice.address}\r\nFrom: ${bob.address}`,
      `FROM: ${bob.address}`,
      `From: =?utf-8?q?${alice.login}?= <${bob.address}>`,
      'Subject: no from at all',
    ];
    for (const header of spoofs) {
      const c = await authed(alice);
      expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('250 2.1.0');
      expect((await c.cmd('RCPT TO:<friend@example.com>')).code).toBe(250);
      expect((await c.cmd('DATA')).code).toBe(354);
      c.write(`${header}\r\nTo: friend@example.com\r\nSubject: spoof\r\n\r\nbody\r\n.\r\n`);
      const r = await c.next();
      expect(codeOf(r), header).toBe('553 5.7.1');
      c.close();
    }
    expect(await w.db.outboundMessage.count()).toBe(before);
  });

  it('submission: with its own app password and its own From, an account relays (the one sanctioned path)', async () => {
    const c = await authed(alice);
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('250 2.1.0');
    expect((await c.cmd('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write(`From: Alice <${alice.address}>\r\nTo: friend@example.com\r\nSubject: legit\r\n\r\nhello\r\n.\r\n`);
    expect(codeOf(await c.next())).toBe('250 2.0.0');
    const queued = await w.db.outboundMessage.findFirstOrThrow({ where: { accountId: alice.id } });
    expect(queued.envelopeFrom.toLowerCase()).toBe(alice.address);
    expect(queued.appPasswordId).toBe(alice.smtpPasswordId);
    c.close();
  });
});
