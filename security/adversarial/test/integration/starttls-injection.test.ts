// Adversarial class 4 — STARTTLS command injection (PST-REQ-087, PST-REQ-029; CVE-2011-0411 and
// the 2021 "NO STARTTLS" family).
//
// Expected safe behaviour: whatever a client (or a man in the middle) pipelines after STARTTLS in
// the same packet is discarded — it is never executed after the handshake, never answered over the
// encrypted channel, and never changes session state. After TLS the session starts from scratch
// (RFC 3207 §4.2: forget EHLO, AUTH and any transaction). Checked on smtp-in, submission (587) and
// IMAP (143). STARTTLS on an already-encrypted connection (a second STARTTLS, or on 465/993) is
// refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient } from './support/imap-client.js';
import { b64, codeOf, SmtpClient } from './support/smtp-client.js';
import { DATABASE_URL, World, type Account } from './support/world.js';

describe.skipIf(DATABASE_URL === undefined)('adversarial: STARTTLS injection (PST-REQ-087 / PST-REQ-029)', () => {
  let w: World;
  let alice: Account;
  let mx = 0;
  let sub587 = 0;
  let sub465 = 0;
  let imap143 = 0;
  let imap993 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_starttls');
    alice = await w.account();
    mx = (await w.smtpIn()).port;
    const s = await w.submission();
    sub587 = s.port587;
    sub465 = s.port465;
    const i = await w.imap();
    imap143 = i.port;
    imap993 = i.tlsPort;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const q = (s: string): string => `"${s.replace(/[\\"]/g, (m) => `\\${m}`)}"`;

  it('smtp-in: EHLO/MAIL/RCPT pipelined behind STARTTLS are discarded, not run after the handshake', async () => {
    const c = await SmtpClient.plain(mx);
    await c.next();
    expect((await c.cmd('EHLO attacker.example')).lines).toContain('STARTTLS');
    c.write(`STARTTLS\r\nEHLO injected.example\r\nMAIL FROM:<attacker@evil.example>\r\nRCPT TO:<${alice.address}>\r\n`);
    expect(codeOf(await c.next())).toBe('220 2.0.0');
    // Nothing else came back in plaintext either.
    expect(c.transcript.map(codeOf).slice(-1)).toEqual(['220 2.0.0']);
    await c.upgrade();
    // A vulnerable server now answers 250, 250, 250 over TLS without being asked.
    expect(await c.unsolicited(400)).toEqual([]);
    // And the state proves it: no EHLO has happened, no transaction exists.
    // (A bare "503": without EHLO there are no enhanced status codes — itself proof no EHLO ran.)
    expect(codeOf(await c.cmd('MAIL FROM:<attacker@evil.example>'))).toBe('503');
    expect((await c.cmd('EHLO real.example')).code).toBe(250);
    expect(codeOf(await c.cmd('DATA'))).toBe('503 5.5.1');
    c.close();
  });

  it('smtp-in: a second STARTTLS inside TLS is refused', async () => {
    const c = await SmtpClient.plain(mx);
    await c.next();
    await c.cmd('EHLO attacker.example');
    await c.cmd('STARTTLS');
    await c.upgrade();
    const ehlo = await c.cmd('EHLO attacker.example');
    expect(ehlo.lines).not.toContain('STARTTLS');
    expect(codeOf(await c.cmd('STARTTLS'))).toBe('503 5.5.1');
    c.close();
  });

  it('submission 587: EHLO + AUTH (with a valid app password) + MAIL behind STARTTLS never authenticate the session', async () => {
    const c = await SmtpClient.plain(sub587);
    await c.next();
    await c.cmd('EHLO attacker.example');
    c.write(
      `STARTTLS\r\nEHLO injected.example\r\nAUTH PLAIN ${b64(`\0${alice.address}\0${alice.smtpPassword}`)}\r\n` +
        `MAIL FROM:<${alice.address}>\r\nRCPT TO:<victim@example.net>\r\n`,
    );
    expect(codeOf(await c.next())).toBe('220 2.0.0');
    await c.upgrade();
    expect(await c.unsolicited(400)).toEqual([]);
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('503');
    expect((await c.cmd('EHLO real.example')).code).toBe(250);
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('530 5.7.0');
    // The injected credentials were never even evaluated.
    const pw = await w.db.appPassword.findUniqueOrThrow({ where: { id: alice.smtpPasswordId } });
    expect(pw.lastUsedAt).toBeNull();
    c.close();
  });

  it('submission 587: injected bytes split across writes before the handshake do not survive it either', async () => {
    const c = await SmtpClient.plain(sub587);
    await c.next();
    await c.cmd('EHLO attacker.example');
    c.write('STARTTLS\r\n');
    c.write(`EHLO injected.example\r\nAUTH PLAIN ${b64(`\0${alice.address}\0${alice.smtpPassword}`)}\r\n`);
    expect(codeOf(await c.next())).toBe('220 2.0.0');
    // Either the bytes were discarded with the plaintext buffer, or they reached the TLS layer as a
    // garbage handshake and the connection died. What may never happen is a live, authenticated session.
    let upgraded = true;
    try {
      await c.upgrade();
    } catch {
      upgraded = false;
    }
    if (upgraded) {
      expect(await c.unsolicited(300)).toEqual([]);
      if (!c.ended) {
        await c.cmd('EHLO real.example').catch(() => null);
        const r = await c.cmd(`MAIL FROM:<${alice.address}>`).catch(() => null);
        if (r !== null) expect(codeOf(r)).toBe('530 5.7.0');
      }
    }
    const pw = await w.db.appPassword.findUniqueOrThrow({ where: { id: alice.smtpPasswordId } });
    expect(pw.lastUsedAt).toBeNull();
    c.close();
  });

  it('submission 465: STARTTLS on implicit TLS is refused', async () => {
    const c = await SmtpClient.implicitTls(sub465);
    await c.next();
    const ehlo = await c.cmd('EHLO attacker.example');
    expect(ehlo.lines).not.toContain('STARTTLS');
    expect(codeOf(await c.cmd('STARTTLS'))).toBe('503 5.5.1');
    c.close();
  });

  it('IMAP 143: LOGIN and SELECT pipelined behind STARTTLS are discarded', async () => {
    const c = await ImapClient.plain(imap143);
    await c.next();
    c.write(`s1 STARTTLS\r\ni1 LOGIN ${q(alice.address)} ${q(alice.imapPassword)}\r\ni2 SELECT INBOX\r\n`);
    const r = await c.collect('s1');
    expect(r.tagged).toMatch(/^s1 OK /);
    await c.upgrade();
    // A vulnerable server answers i1 OK / i2 OK over TLS here.
    expect(await c.unsolicited(400)).toEqual([]);
    expect((await c.command('s2', 'SELECT INBOX')).tagged).toMatch(/^s2 BAD /);
    const cap = await c.command('s3', 'CAPABILITY');
    expect(cap.untagged.join(' ')).not.toContain('STARTTLS');
    expect(c.transcript.some((l) => l.startsWith('i1 ') || l.startsWith('i2 '))).toBe(false);
    const pw = await w.db.appPassword.findUniqueOrThrow({ where: { id: alice.imapPasswordId } });
    expect(pw.lastUsedAt).toBeNull();
    c.close();
  });

  it('IMAP 143: a literal-carrying command behind STARTTLS is discarded too', async () => {
    const c = await ImapClient.plain(imap143);
    await c.next();
    const pw = Buffer.from(alice.imapPassword);
    c.write(Buffer.concat([
      Buffer.from(`s1 STARTTLS\r\ni1 LOGIN ${q(alice.address)} {${String(pw.length)}+}\r\n`),
      pw,
      Buffer.from('\r\n'),
    ]));
    expect((await c.collect('s1')).tagged).toMatch(/^s1 OK /);
    await c.upgrade();
    expect(await c.unsolicited(400)).toEqual([]);
    expect((await c.command('s2', 'SELECT INBOX')).tagged).toMatch(/^s2 BAD /);
    c.close();
  });

  it('IMAP: STARTTLS inside TLS (after STARTTLS, or on 993) is refused', async () => {
    const c = await ImapClient.plain(imap143);
    await c.next();
    expect((await c.command('s1', 'STARTTLS')).tagged).toMatch(/^s1 OK /);
    await c.upgrade();
    expect((await c.command('s2', 'STARTTLS')).tagged).toMatch(/^s2 (BAD|NO) /);
    c.close();
    const d = await ImapClient.implicitTls(imap993);
    await d.next();
    expect((await d.command('s3', 'STARTTLS')).tagged).toMatch(/^s3 (BAD|NO) /);
    d.close();
  });
});
