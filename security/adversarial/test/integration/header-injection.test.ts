// Adversarial class 5 — header injection (PST-REQ-087).
//
// Expected safe behaviour: nothing a client puts in the envelope or in protocol arguments becomes a
// header field of a stored message (or of anything generated from it later).
//   - A CRLF can never be inside an SMTP command line: it ends it. So "EHLO x<CRLF>X-Injected: y"
//     is two commands, the second a 500, and the stored message has no X-Injected field.
//   - A bare CR or LF in a command line is a 500 and the session closes (nothing stored).
//   - xtext-encoded CR/LF/NUL ("+0D+0A") in ENVID, ORCPT or AUTH= — values that are echoed into a
//     DSN's Original-Envelope-Id / Original-Recipient — is a 501 on the wire.
//   - Envelope values that do reach trace headers (HELO, MAIL FROM, RCPT) are single-line.
//   - IMAP: APPEND flags cannot carry header text (flags are atoms), the stored message is exactly
//     the literal the client sent, and a mailbox name with CR/LF (via a literal) is refused.
// API-driven compose is not reachable yet (apps/api has no compose endpoint); when it lands its
// path belongs in this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient } from './support/imap-client.js';
import { b64, codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, World, type Account } from './support/world.js';

/** The field names of a stored message's header section. */
function headerNames(message: Buffer): string[] {
  const text = message.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  const head = end < 0 ? text : text.slice(0, end);
  return head
    .split('\r\n')
    .filter((l) => l !== '' && l[0] !== ' ' && l[0] !== '\t')
    .map((l) => l.slice(0, l.indexOf(':')).toLowerCase());
}

describe.skipIf(DATABASE_URL === undefined)('adversarial: header injection (PST-REQ-087)', () => {
  let w: World;
  let alice: Account;
  let mx = 0;
  let sub465 = 0;
  let imap993 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_hdrinj');
    alice = await w.account();
    mx = (await w.smtpIn()).port;
    sub465 = (await w.submission()).port465;
    imap993 = (await w.imap()).tlsPort;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  async function latestInbound(): Promise<Buffer> {
    const row = await w.db.inboundMessage.findFirstOrThrow({ orderBy: { receivedAt: 'desc' } });
    return w.blobs.getBuffer(row.blobSha256);
  }

  it('smtp-in: CRLF inside EHLO / MAIL / RCPT splits the command; the extra line is a 500, never a header', async () => {
    const c = await SmtpClient.plain(mx);
    await c.next();
    c.write('EHLO evil.example\r\nX-Injected-Helo: yes\r\n');
    expect((await c.next()).code).toBe(250);
    expect(codeOf(await c.next())).toBe('500 5.5.1');
    c.write('MAIL FROM:<attacker@evil.example>\r\nX-Injected-From: yes\r\n');
    expect((await c.next()).code).toBe(250);
    expect((await c.next()).code).toBe(500);
    c.write(`RCPT TO:<${alice.address}>\r\nX-Injected-Rcpt: yes\r\n`);
    expect((await c.next()).code).toBe(250);
    expect((await c.next()).code).toBe(500);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write('From: attacker@evil.example\r\nSubject: hdr\r\n\r\nbody\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('250 2.0.0');
    c.close();
    const names = headerNames(await latestInbound());
    expect(names.filter((n) => n.startsWith('x-injected'))).toEqual([]);
    expect(names).toContain('received');
  });

  it('smtp-in: bare CR / LF inside envelope commands closes the session and stores nothing', async () => {
    const before = await w.db.inboundMessage.count();
    for (const evil of ['EHLO evil.example\rX-Injected: yes\r\n', 'EHLO evil.example\nX-Injected: yes\r\n']) {
      const c = await SmtpClient.plain(mx);
      await c.next();
      c.write(evil);
      expect((await c.next()).code).toBe(500);
      expect(await c.closed()).toBe(true);
    }
    const c = await SmtpClient.plain(mx);
    await c.next();
    await c.cmd('EHLO evil.example');
    c.write('MAIL FROM:<attacker@evil.example>\rX-Injected: yes\r\n');
    expect(codeOf(await c.next())).toBe('500 5.5.2');
    expect(await c.closed()).toBe(true);
    expect(await w.db.inboundMessage.count()).toBe(before);
  });

  it('smtp-in: header-looking text in HELO and the envelope stays on one trace line', async () => {
    const c = await SmtpClient.plain(mx);
    await c.next();
    // Not a domain: refused outright.
    expect((await c.cmd('EHLO evil.example X-Injected: yes')).code).toBe(501);
    expect((await c.cmd('EHLO evil.example')).code).toBe(250);
    expect((await c.cmd('MAIL FROM:<"x: X-Injected: yes;"@evil.example>')).code).toBe(250);
    expect((await c.cmd(`RCPT TO:<${alice.address}>`)).code).toBe(250);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write('Subject: quoted\r\n\r\nbody\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('250 2.0.0');
    c.close();
    const names = headerNames(await latestInbound());
    expect(names.filter((n) => n.includes('injected'))).toEqual([]);
  });

  async function submitter(): Promise<SmtpClient> {
    const c = await SmtpClient.implicitTls(sub465);
    await c.next();
    await c.cmd('EHLO client.example');
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`\0${alice.address}\0${alice.smtpPassword}`)}`))).toBe('235 2.7.0');
    return c;
  }

  it('submission: xtext-encoded CR/LF/NUL in ENVID, ORCPT and AUTH= is refused on the wire', async () => {
    const before = await w.db.outboundMessage.count({ where: { accountId: alice.id } });
    const c = await submitter();
    for (const params of ['ENVID=abc+0D+0AX-Injected:+20yes', 'ENVID=+0AX-Injected:+20yes', 'ENVID=abc+00def', `AUTH=${alice.login}+0D+0AX-Injected:+20yes`]) {
      expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}> ${params}`)), params).toBe('501 5.5.4');
    }
    expect((await c.cmd(`MAIL FROM:<${alice.address}> ENVID=clean-id`)).code).toBe(250);
    for (const params of ['ORCPT=rfc822;friend+40example.com+0D+0AX-Injected:+20yes', 'ORCPT=rfc822;friend+0A+40example.com']) {
      expect(codeOf(await c.cmd(`RCPT TO:<friend@example.com> ${params}`)), params).toBe('501 5.5.4');
    }
    expect((await c.cmd('RCPT TO:<friend@example.com> ORCPT=rfc822;friend+40example.com')).code).toBe(250);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write(`From: ${alice.address}\r\nTo: friend@example.com\r\nSubject: clean\r\n\r\nbody\r\n.\r\n`);
    expect((await c.next()).code).toBe(250);
    c.close();
    const rows = await w.db.outboundMessage.findMany({ where: { accountId: alice.id } });
    expect(rows).toHaveLength(before + 1);
    for (const r of rows) {
      const envid = r.dsnEnvid ?? '';
      expect(envid.includes('\r') || envid.includes('\n') || envid.includes('\u0000')).toBe(false);
    }
  });

  it('submission: CRLF-split envelope lines never reach the signed message', async () => {
    const c = await submitter();
    c.write(`MAIL FROM:<${alice.address}>\r\nX-Injected-From: yes\r\n`);
    expect((await c.next()).code).toBe(250);
    expect((await c.next()).code).toBe(500);
    c.write('RCPT TO:<friend@example.com>\r\nBcc: victim@example.net\r\n');
    expect((await c.next()).code).toBe(250);
    expect((await c.next()).code).toBe(500);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write(`From: ${alice.address}\r\nTo: friend@example.com\r\nSubject: split\r\n\r\nbody\r\n.\r\n`);
    const r = await c.next();
    expect(r.code).toBe(250);
    c.close();
    const id = /Queued as ([0-9a-f-]{36})/.exec(r.lines[0] ?? '')?.[1] ?? '';
    const msg = await w.db.outboundMessage.findUniqueOrThrow({ where: { id }, include: { recipients: true } });
    expect(msg.recipients.map((x) => x.address)).toEqual(['friend@example.com']);
    const names = headerNames(await w.blobs.getBuffer(msg.blobSha256));
    expect(names.filter((n) => n.startsWith('x-injected') || n === 'bcc')).toEqual([]);
  });

  // --- IMAP -----------------------------------------------------------------------------------

  async function imapLogin(): Promise<ImapClient> {
    const c = await ImapClient.implicitTls(imap993);
    await c.next();
    expect((await c.command('l1', `LOGIN "${alice.address}" "${alice.imapPassword}"`)).tagged).toMatch(/^l1 OK /);
    return c;
  }

  it('IMAP: APPEND flags cannot carry header text, and the stored message is byte-for-byte the literal', async () => {
    const c = await imapLogin();
    const message = Buffer.from(`From: ${alice.address}\r\nSubject: append\r\n\r\nbody\r\n`);
    // A flag list that tries to break out of the atom grammar is a BAD, not a header.
    c.write(`a1 APPEND INBOX (\\Seen "X-Injected: yes") {${String(message.length)}}\r\n`);
    const refused = await c.next();
    expect(refused).toMatch(/^a1 (BAD|NO) /);
    c.write(`a2 APPEND INBOX (\\Seen X-Injected) {${String(message.length)}}\r\n`);
    expect(await c.next()).toMatch(/^\+/);
    c.write(Buffer.concat([message, Buffer.from('\r\n')]));
    expect((await c.collect('a2')).tagged).toMatch(/^a2 OK /);
    const inbox = await w.db.mailbox.findFirstOrThrow({ where: { accountId: alice.id, name: 'INBOX' } });
    const stored = await w.db.message.findFirstOrThrow({ where: { mailboxId: inbox.id }, orderBy: { uid: 'desc' } });
    const blob = await w.blobs.getBuffer(stored.blobSha256);
    expect(blob.equals(message)).toBe(true);
    c.close();
  });

  it('IMAP: a mailbox name carrying CR/LF (in a literal) is refused and never created', async () => {
    const c = await imapLogin();
    const name = Buffer.from('Evil\r\nX-Injected: yes');
    c.write(`c1 CREATE {${String(name.length)}}\r\n`);
    const cont = await c.next();
    if (cont?.startsWith('+') === true) {
      c.write(Buffer.concat([name, Buffer.from('\r\n')]));
      expect((await c.collect('c1')).tagged).toMatch(/^c1 (NO|BAD) /);
    } else {
      expect(cont).toMatch(/^c1 (NO|BAD) /);
    }
    // Quoted strings cannot hold CR/LF at all.
    expect((await c.command('c2', 'CREATE "Evil\rX"')).tagged).toMatch(/^c2 (NO|BAD) /);
    const names = await w.db.mailbox.findMany({ where: { accountId: alice.id }, select: { name: true } });
    expect(names.some((m) => /[\r\n]/.test(m.name) || m.name.startsWith('Evil'))).toBe(false);
    c.close();
  });
});
