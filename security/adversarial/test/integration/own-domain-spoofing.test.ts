// Adversarial — own-domain spoofing at the MX (PST-REQ-184) and the harvest limit (PST-REQ-185).
//
// Expected safe behaviour:
//   smtp-in    refuses, with 550 5.7.1 at end of DATA, any message from outside whose header From
//              names one of our domains (or a subdomain of one) without an aligned SPF or DKIM
//              pass — whatever the display name, case or folding, and however the From field is
//              repeated — even though our own DMARC record is p=none. The refusal is stored with
//              its reason and a Rejects copy, never delivered to the inbox.
//              A network guessing addresses is cut off with 421 once it passes the unknown-
//              recipient limit, counted on the PROXY-reported client, not the edge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, DOMAIN, World, type Account } from './support/world.js';

describe.skipIf(DATABASE_URL === undefined)('adversarial: own-domain spoofing at the MX (PST-REQ-184 / PST-REQ-185)', () => {
  let w: World;
  let alice: Account;
  let mx = 0;
  let mxViaEdge = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_spoof');
    alice = await w.account();
    mx = (await w.smtpIn()).port;
    mxViaEdge = (await w.smtpIn({ edgePeers: ['127.0.0.1'] })).port;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const FORGED_FROMS: readonly string[] = [
    `From: ceo@${DOMAIN}`,
    `From: "Alice (IT)" <it@${DOMAIN}>`,
    `From: ceo@${DOMAIN.toUpperCase()}`,
    `From: ceo@billing.${DOMAIN}`,
    `From:\r\n ceo@${DOMAIN}`,
    `From: someone@evil.example, ceo@${DOMAIN}`,
    `From: someone@evil.example\r\nFrom: ceo@${DOMAIN}`,
    `From: =?utf-8?q?Support?= <support@${DOMAIN}>`,
  ];

  for (const from of FORGED_FROMS) {
    it(`smtp-in: ${JSON.stringify(from)} from a stranger is 550 5.7.1 and lands only in Rejects`, async () => {
      const c = await SmtpClient.plain(mx);
      await c.next();
      await c.cmd('EHLO attacker.example');
      expect(codeOf(await c.cmd('MAIL FROM:<attacker@evil.example>'))).toBe('250 2.1.0');
      expect(codeOf(await c.cmd(`RCPT TO:<${alice.address}>`))).toBe('250 2.1.5');
      expect((await c.cmd('DATA')).code).toBe(354);
      c.write(`${from}\r\nTo: ${alice.address}\r\nSubject: urgent\r\n\r\nwire the money\r\n.\r\n`);
      const r = await c.next();
      expect(codeOf(r)).toBe('550 5.7.1');
      c.close();
      const row = await w.db.inboundMessage.findFirst({ orderBy: { receivedAt: 'desc' } });
      expect(row?.state).toBe('rejected');
      expect(row?.dispositionReason).toMatch(/one of our domains|From header fields/);
    });
  }

  it('smtp-in: the unknown-recipient limit counts the PROXY-reported client and cuts it off with 421', async () => {
    const proxy = (source: string): Buffer =>
      encodeProxyV2({ command: 'PROXY', family: 'TCP4', source: { address: source, port: 40_000 }, destination: { address: '10.77.0.2', port: 25 } });
    const c = await SmtpClient.plain(mxViaEdge, proxy('198.51.100.23'));
    expect((await c.next()).code).toBe(220);
    await c.cmd('EHLO harvester.example');
    expect(codeOf(await c.cmd('MAIL FROM:<h@harvester.example>'))).toBe('250 2.1.0');
    const codes: string[] = [];
    for (let i = 0; i < 21; i++) codes.push(codeOf(await c.cmd(`RCPT TO:<guess${String(i)}@${DOMAIN}>`)));
    expect(codes.slice(0, 20).every((x) => x === '550 5.1.1')).toBe(true);
    expect(codes[20]).toBe('421 4.7.0');
    c.close();
    // Every connection came from the same edge address (loopback here); only the reported client's
    // /24 is refused — another network behind the same edge still gets in.
    const sameNet = await SmtpClient.plain(mxViaEdge, proxy('198.51.100.200'));
    expect(codeOf(await sameNet.next())).toBe('421 4.7.0');
    sameNet.close();
    const otherNet = await SmtpClient.plain(mxViaEdge, proxy('198.51.101.23'));
    expect((await otherNet.next()).code).toBe(220);
    otherNet.close();
  });
});
