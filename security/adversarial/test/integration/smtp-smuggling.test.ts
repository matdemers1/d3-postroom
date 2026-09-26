// Adversarial class 3 — SMTP smuggling (PST-REQ-087, PST-REQ-049; the SEC Consult 2023 class,
// CVE-2023-51764/51765/51766).
//
// Expected safe behaviour: only <CRLF>.<CRLF> ends DATA. Every other "end of data" a lenient MTA
// might honour — <LF>.<LF>, <LF>.<CRLF>, <CR>.<CR>, <CRLF>.<LF>, <CR>.<CRLF>, <CRLF>.<CR> — is just
// bytes inside the message, which the bare CR / bare LF makes a 5xx for the whole message once the
// real terminator arrives. So a second message smuggled behind a fake terminator is never parsed
// as commands, never gets a reply of its own, and never reaches storage — on smtp-in (port 25) and
// submission alike. A bare CR or LF in a command line is a 5xx (and the session closes). BDAT is not
// advertised, so there is no chunking path to smuggle through.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64, codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, World, type Account } from './support/world.js';

/** True when every CR and LF in `ending` is part of a CRLF pair and there is no NUL. */
function isCleanEnding(ending: string): boolean {
  const rest = ending.replaceAll('\r\n', '');
  return !rest.includes('\r') && !rest.includes('\n') && !rest.includes('\u0000');
}

describe.skipIf(DATABASE_URL === undefined)('adversarial: SMTP smuggling (PST-REQ-087 / PST-REQ-049)', () => {
  let w: World;
  let alice: Account;
  let mx = 0;
  let sub465 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_smuggle');
    alice = await w.account();
    mx = (await w.smtpIn()).port;
    sub465 = (await w.submission()).port465;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const smuggled = (marker: string): string =>
    `MAIL FROM:<admin@d3cloud.io>\r\nRCPT TO:<${alice.address}>\r\nDATA\r\n` +
    `From: admin@d3cloud.io\r\nTo: ${alice.address}\r\nSubject: ${marker}\r\n\r\nsmuggled\r\n`;

  /** The fake terminators, with the smuggled transaction behind each. */
  const ENDINGS: readonly (readonly [string, string])[] = [
    ['<LF>.<LF>', '\n.\n'],
    ['<LF>.<CRLF>', '\n.\r\n'],
    ['<CR>.<CR>', '\r.\r'],
    ['<CRLF>.<LF>', '\r\n.\n'],
    ['<CR>.<CRLF>', '\r.\r\n'],
    ['<CRLF>.<CR>', '\r\n.\r'],
    ['<CR><LF>.<NUL><CR><LF>', '\r\n.\u0000\r\n'],
    ['<CRLF><SP>.<CRLF>', '\r\n .\r\n'],
  ];

  async function inboundSubjects(): Promise<string[]> {
    const rows = await w.db.inboundMessage.findMany({ select: { blobSha256: true } });
    const out: string[] = [];
    for (const r of rows) {
      // Only the header section: a smuggled "Subject:" left inside a body is not a message.
      const text = (await w.blobs.getBuffer(r.blobSha256)).toString('latin1');
      const head = text.slice(0, text.indexOf('\r\n\r\n'));
      out.push(...[...head.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1] ?? ''));
    }
    return out;
  }

  async function mxData(): Promise<SmtpClient> {
    const c = await SmtpClient.plain(mx);
    await c.next();
    await c.cmd('EHLO attacker.example');
    expect(codeOf(await c.cmd('MAIL FROM:<attacker@evil.example>'))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd(`RCPT TO:<${alice.address}>`))).toBe('250 2.1.5');
    expect((await c.cmd('DATA')).code).toBe(354);
    return c;
  }

  for (const [name, ending] of ENDINGS) {
    it(`smtp-in: ${name} does not end DATA; the smuggled message is refused with the carrier and never stored`, async () => {
      const marker = `smuggled-${name}`;
      const c = await mxData();
      c.write(`From: attacker@evil.example\r\nSubject: carrier\r\n\r\ncarrier body${ending}${smuggled(marker)}.\r\n`);
      const r = await c.next();
      // No 250 for the carrier: the fake terminator made the message unacceptable (or, for the
      // CRLF-clean variants, it is one message whose body contains the "smuggled" text).
      const clean = isCleanEnding(ending);
      if (clean) expect(codeOf(r)).toBe('250 2.0.0');
      else expect(r.code).toBeGreaterThanOrEqual(500);
      // Exactly one reply for the whole thing: MAIL, RCPT and DATA inside it were never commands.
      expect(await c.unsolicited(300)).toEqual([]);
      expect(codeOf(await c.cmd('NOOP'))).toBe('250 2.0.0');
      c.close();
      const subjects = await inboundSubjects();
      expect(subjects).not.toContain(marker);
    });
  }

  it('smtp-in: a bare-LF message is 550 5.6.0 and nothing is stored', async () => {
    const before = await w.db.inboundMessage.count();
    const c = await mxData();
    c.write('Subject: bare lf\n\nhello\n.\r\n');
    // A lone ".\r\n" after bare LFs is not <CRLF>.<CRLF>: still inside DATA.
    expect(await c.unsolicited(300)).toEqual([]);
    c.write('\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('550 5.6.0');
    expect(await w.db.inboundMessage.count()).toBe(before);
    c.close();
  });

  it('smtp-in: a bare CR anywhere in the body is 550 5.6.0', async () => {
    const before = await w.db.inboundMessage.count();
    const c = await mxData();
    c.write('Subject: bare cr\r\n\r\nhel\rlo\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('550 5.6.0');
    expect(await w.db.inboundMessage.count()).toBe(before);
    c.close();
  });

  it('smtp-in: dot-stuffing cannot forge a terminator (a stuffed ".." line stays in the body)', async () => {
    const c = await mxData();
    c.write('From: a@evil.example\r\nSubject: dotstuff\r\n\r\nline\r\n..\r\n...\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('250 2.0.0');
    expect(await c.unsolicited(200)).toEqual([]);
    c.close();
  });

  it('smtp-in: a bare LF or bare CR in a command line is 500 and closes the session', async () => {
    for (const line of [`MAIL FROM:<a@evil.example>\nRCPT TO:<${alice.address}>\r\n`, 'NOOP\rRSET\r\n', 'NOOP\n']) {
      const c = await SmtpClient.plain(mx);
      await c.next();
      await c.cmd('EHLO attacker.example');
      c.write(line);
      expect(codeOf(await c.next())).toBe('500 5.5.2');
      expect(await c.closed()).toBe(true);
    }
  });

  it('smtp-in: BDAT/CHUNKING is not offered and not accepted', async () => {
    const c = await SmtpClient.plain(mx);
    await c.next();
    const ehlo = await c.cmd('EHLO attacker.example');
    expect(ehlo.lines.some((l) => /^CHUNKING|^BINARYMIME/.test(l))).toBe(false);
    await c.cmd('MAIL FROM:<a@evil.example>');
    await c.cmd(`RCPT TO:<${alice.address}>`);
    expect((await c.cmd('BDAT 10 LAST')).code).toBeGreaterThanOrEqual(500);
    // The chunk a BDAT client would now send is read as a command line, never as message data.
    expect((await c.cmd('Subject: x')).code).toBeGreaterThanOrEqual(500);
    c.close();
  });

  it('smtp-in: a pipelined smuggle after a fake terminator gets no reply of its own', async () => {
    const before = await w.db.inboundMessage.count();
    const c = await mxData();
    // Carrier ends with "\n.\n", then a whole second transaction including its own <CRLF>.<CRLF>,
    // then QUIT. A vulnerable server answers 250 (carrier), 250, 250, 354, 250 (smuggled), 221.
    c.write(`Subject: carrier\r\n\r\nx\n.\n${smuggled('pipelined-smuggle')}.\r\nQUIT\r\n`);
    const first = await c.next();
    expect(first.code).toBe(550);
    const second = await c.next();
    expect(codeOf(second)).toBe('221 2.0.0');
    expect(await c.closed()).toBe(true);
    expect(await w.db.inboundMessage.count()).toBe(before);
  });

  // --- submission -----------------------------------------------------------------------------

  it('submission: fake terminators do not end DATA and nothing smuggled is queued', async () => {
    for (const [name, ending] of ENDINGS) {
      const before = await w.db.outboundMessage.count();
      const c = await SmtpClient.implicitTls(sub465);
      await c.next();
      await c.cmd('EHLO client.example');
      expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`\0${alice.address}\0${alice.smtpPassword}`)}`))).toBe('235 2.7.0');
      expect((await c.cmd(`MAIL FROM:<${alice.address}>`)).code).toBe(250);
      expect((await c.cmd('RCPT TO:<friend@example.com>')).code).toBe(250);
      expect((await c.cmd('DATA')).code).toBe(354);
      const smuggle = `MAIL FROM:<${alice.address}>\r\nRCPT TO:<victim@example.net>\r\nDATA\r\nFrom: ${alice.address}\r\nSubject: sub-smuggled\r\n\r\nx\r\n`;
      c.write(`From: ${alice.address}\r\nTo: friend@example.com\r\nSubject: carrier\r\n\r\nbody${ending}${smuggle}.\r\n`);
      const r = await c.next();
      const clean = isCleanEnding(ending);
      if (clean) expect(r.code, name).toBe(250);
      else expect(r.code, name).toBeGreaterThanOrEqual(500);
      expect(await c.unsolicited(200), name).toEqual([]);
      c.close();
      const after = await w.db.outboundMessage.count();
      expect(after - before, name).toBe(clean ? 1 : 0);
      const victims = await w.db.outboundRecipient.count({ where: { address: 'victim@example.net' } });
      expect(victims, name).toBe(0);
    }
  });
});
