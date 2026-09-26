// Adversarial class 2 — authentication bypass (PST-REQ-087; PST-REQ-027 app passwords only,
// PST-REQ-025/029 no AUTH before TLS, PST-REQ-075 throttling).
//
// Expected safe behaviour, on submission (587/465) and IMAP (143/993) alike:
//   - the account (web) password never authenticates a protocol session; only an app password
//     scoped to that protocol does, and only for the account that owns it;
//   - no credential is even looked at before TLS (587 answers 538, IMAP answers PRIVACYREQUIRED —
//     even when the credentials are right);
//   - SASL PLAIN with an authorization identity other than the authentication identity is refused
//     (nobody logs in "as" somebody else);
//   - empty, NUL-embedded, truncated or undecodable credentials are refused, never crash, never
//     succeed;
//   - a revoked app password is dead immediately;
//   - past the throttle's ceiling, even the right password is refused.
// A refused session stays unauthenticated: the next mail/mailbox command is still refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeAppPassword } from '@postroom/credentials';
import { ImapClient } from './support/imap-client.js';
import { b64, codeOf, SmtpClient } from './support/smtp-client.js';
import { ACCOUNT_PASSWORD, DATABASE_URL, World, type Account } from './support/world.js';

const NUL = '\u0000';

describe.skipIf(DATABASE_URL === undefined)('adversarial: auth bypass (PST-REQ-087 / PST-REQ-027)', () => {
  let w: World;
  let alice: Account;
  let bob: Account;
  let revoked: Account;
  let sub587 = 0;
  let sub465 = 0;
  let imap143 = 0;
  let imap993 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_auth');
    alice = await w.account();
    bob = await w.account();
    revoked = await w.account();
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

  // --- submission -----------------------------------------------------------------------------

  async function sub(port = sub465): Promise<SmtpClient> {
    const c = await SmtpClient.implicitTls(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO attacker.example')).code).toBe(250);
    return c;
  }

  /** After a refused AUTH, the session must still be unauthenticated. */
  async function stillAnonymous(c: SmtpClient): Promise<void> {
    expect(codeOf(await c.cmd(`MAIL FROM:<${alice.address}>`))).toBe('530 5.7.0');
  }

  it('submission: the account password is refused (PLAIN and LOGIN)', async () => {
    const c = await sub();
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${ACCOUNT_PASSWORD}`)}`))).toBe('535 5.7.8');
    expect((await c.cmd('AUTH LOGIN')).code).toBe(334);
    expect((await c.cmd(b64(alice.address))).code).toBe(334);
    expect(codeOf(await c.cmd(b64(ACCOUNT_PASSWORD)))).toBe('535 5.7.8');
    await stillAnonymous(c);
    c.close();
  });

  it('submission: an IMAP-scoped app password, or another account\'s, is refused', async () => {
    const c = await sub();
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.imapPassword}`)}`))).toBe('535 5.7.8');
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${bob.smtpPassword}`)}`))).toBe('535 5.7.8');
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${bob.address}${NUL}${alice.smtpPassword}`)}`))).toBe('535 5.7.8');
    await stillAnonymous(c);
    c.close();
  });

  it('submission: AUTH before STARTTLS is refused without looking at the credentials, and not advertised', async () => {
    const c = await SmtpClient.plain(sub587);
    await c.next();
    const ehlo = await c.cmd('EHLO attacker.example');
    expect(ehlo.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
    const failuresBefore = await w.db.auditEvent.count({ where: { action: 'auth.failure' } });
    // Correct credentials, still refused: encryption first.
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.smtpPassword}`)}`))).toBe('538 5.7.11');
    expect(codeOf(await c.cmd('AUTH LOGIN'))).toBe('538 5.7.11');
    await stillAnonymous(c);
    // Refused before evaluation: no throttle row was needed because nothing was checked.
    expect(await w.db.auditEvent.count({ where: { action: 'auth.failure' } })).toBe(failuresBefore);
    const used = await w.db.appPassword.findUniqueOrThrow({ where: { id: alice.smtpPasswordId } });
    expect(used.lastUsedAt).toBeNull();
    c.close();
  });

  it('submission: SASL PLAIN with an authorization identity other than the login is refused', async () => {
    const c = await sub();
    // Log in as alice, act as bob.
    const r1 = await c.cmd(`AUTH PLAIN ${b64(`${bob.address}${NUL}${alice.address}${NUL}${alice.smtpPassword}`)}`);
    expect(r1.code).toBeGreaterThanOrEqual(500);
    // Log in as alice, act as the postmaster.
    const r2 = await c.cmd(`AUTH PLAIN ${b64(`postmaster@d3cloud.io${NUL}${alice.address}${NUL}${alice.smtpPassword}`)}`);
    expect(r2.code).toBeGreaterThanOrEqual(500);
    await stillAnonymous(c);
    // The same identity in both slots is fine (RFC 4616).
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${alice.address}${NUL}${alice.address}${NUL}${alice.smtpPassword}`)}`))).toBe('235 2.7.0');
    c.close();
  });

  it('submission: empty, NUL-embedded, truncated and undecodable credentials never authenticate', async () => {
    const attempts = [
      'AUTH PLAIN =',
      `AUTH PLAIN ${b64(`${NUL}${NUL}`)}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}`)}`,
      `AUTH PLAIN ${b64(`${NUL}${NUL}${alice.smtpPassword}`)}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.smtpPassword}${NUL}`)}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.smtpPassword}${NUL}extra`)}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${NUL}${alice.smtpPassword}`)}`,
      `AUTH PLAIN ${b64(`${alice.address}${NUL}${alice.smtpPassword}`)}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.smtpPassword}`).slice(0, -4)}`,
      'AUTH PLAIN !!!not-base64!!!',
      `AUTH PLAIN ${Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x41]).toString('base64')}`,
      `AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}`)}${b64(alice.smtpPassword)}`,
    ];
    for (const line of attempts) {
      const c = await sub();
      const r = await c.cmd(line);
      expect(r.code, `${line} → ${codeOf(r)}`).not.toBe(235);
      expect(r.code, line).toBeGreaterThanOrEqual(400);
      await stillAnonymous(c);
      c.close();
    }
    // AUTH LOGIN with an empty or NUL-carrying username/password.
    for (const [user, pass] of [
      ['', alice.smtpPassword],
      [alice.address, ''],
      [`${alice.address}${NUL}`, alice.smtpPassword],
      [alice.address, `${alice.smtpPassword}${NUL}`],
      [`${NUL}${alice.address}`, alice.smtpPassword],
    ] as const) {
      const c = await sub();
      let r = await c.cmd('AUTH LOGIN');
      expect(r.code).toBe(334);
      r = await c.cmd(b64(user));
      if (r.code === 334) r = await c.cmd(b64(pass));
      expect(r.code, JSON.stringify([user, pass])).not.toBe(235);
      expect(r.code).toBeGreaterThanOrEqual(400);
      if (!c.ended) await stillAnonymous(c);
      c.close();
    }
  });

  it('submission: a cancelled exchange, or a second AUTH after success, grants nothing new', async () => {
    const c = await sub();
    expect((await c.cmd('AUTH PLAIN')).code).toBe(334);
    expect(codeOf(await c.cmd('*'))).toBe('501 5.0.0');
    await stillAnonymous(c);
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.smtpPassword}`)}`))).toBe('235 2.7.0');
    // Re-authenticating as bob mid-session (with bob's own valid password) is refused: one identity per session.
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${bob.address}${NUL}${bob.smtpPassword}`)}`))).toBe('503 5.5.1');
    expect(codeOf(await c.cmd(`MAIL FROM:<${bob.address}>`))).toBe('553 5.7.1');
    c.close();
  });

  it('submission: a revoked app password is refused at once', async () => {
    let c = await sub();
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${revoked.address}${NUL}${revoked.smtpPassword}`)}`))).toBe('235 2.7.0');
    c.close();
    await revokeAppPassword(w.db, { kind: 'system', label: 'adversarial-suite' }, { id: revoked.smtpPasswordId });
    c = await sub();
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${revoked.address}${NUL}${revoked.smtpPassword}`)}`))).toBe('535 5.7.8');
    await stillAnonymous(c);
    c.close();
  });

  it('submission: past the throttle ceiling even the right password is refused (454), and each failure is audited', async () => {
    const victim = await w.account();
    const locked = await w.submission({ throttle: w.throttle({ sourceCeiling: 3 }) });
    // The ceiling counts failures from this source in the window, whoever they were for. Earlier
    // tests already failed from loopback, so this listener starts locked: prove the lock holds.
    const failures = await w.db.auditEvent.count({ where: { action: 'auth.failure' } });
    expect(failures).toBeGreaterThanOrEqual(3);
    const c = await sub(locked.port465);
    expect(codeOf(await c.cmd(`AUTH PLAIN ${b64(`${NUL}${victim.address}${NUL}${victim.smtpPassword}`)}`))).toBe('454 4.7.0');
    await stillAnonymous(c);
    c.close();
    // The audit rows carry no secret.
    const rows = await w.db.auditEvent.findMany({ where: { action: 'auth.failure' } });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(ACCOUNT_PASSWORD);
    expect(text).not.toContain(alice.smtpPassword);
    expect(text).not.toContain(alice.imapPassword);
  });

  // --- IMAP -----------------------------------------------------------------------------------

  async function imaps(port = imap993): Promise<ImapClient> {
    const c = await ImapClient.implicitTls(port);
    expect(await c.next()).toMatch(/^\* OK /);
    return c;
  }

  async function imapStillAnonymous(c: ImapClient): Promise<void> {
    const r = await c.command('Z1', 'SELECT INBOX');
    expect(r.tagged).toMatch(/^Z1 BAD /);
  }

  const q = (s: string): string => `"${s.replace(/[\\"]/g, (m) => `\\${m}`)}"`;

  it('IMAP: the account password and an SMTP-scoped app password are refused', async () => {
    const c = await imaps();
    expect((await c.command('a1', `LOGIN ${q(alice.address)} ${q(ACCOUNT_PASSWORD)}`)).tagged).toMatch(/^a1 NO \[AUTHENTICATIONFAILED\]/);
    expect((await c.command('a2', `LOGIN ${q(alice.address)} ${q(alice.smtpPassword)}`)).tagged).toMatch(/^a2 NO \[AUTHENTICATIONFAILED\]/);
    expect((await c.command('a3', `LOGIN ${q(bob.address)} ${q(alice.imapPassword)}`)).tagged).toMatch(/^a3 NO \[AUTHENTICATIONFAILED\]/);
    const plain = b64(`${NUL}${alice.address}${NUL}${ACCOUNT_PASSWORD}`);
    expect((await c.command('a4', `AUTHENTICATE PLAIN ${plain}`)).tagged).toMatch(/^a4 NO \[AUTHENTICATIONFAILED\]/);
    await imapStillAnonymous(c);
    c.close();
  });

  it('IMAP: on the plaintext port, LOGINDISABLED holds even for correct credentials', async () => {
    const c = await ImapClient.plain(imap143);
    const greeting = await c.next();
    expect(greeting).toContain('LOGINDISABLED');
    expect((await c.command('a1', `LOGIN ${q(alice.address)} ${q(alice.imapPassword)}`)).tagged).toMatch(/^a1 NO \[PRIVACYREQUIRED\]/);
    const plain = b64(`${NUL}${alice.address}${NUL}${alice.imapPassword}`);
    expect((await c.command('a2', `AUTHENTICATE PLAIN ${plain}`)).tagged).toMatch(/^a2 NO \[PRIVACYREQUIRED\]/);
    await imapStillAnonymous(c);
    c.close();
  });

  it('IMAP: AUTHENTICATE PLAIN with a foreign authorization identity is refused', async () => {
    const c = await imaps();
    const asBob = b64(`${bob.address}${NUL}${alice.address}${NUL}${alice.imapPassword}`);
    expect((await c.command('a1', `AUTHENTICATE PLAIN ${asBob}`)).tagged).toMatch(/^a1 NO /);
    await imapStillAnonymous(c);
    const same = b64(`${alice.address}${NUL}${alice.address}${NUL}${alice.imapPassword}`);
    expect((await c.command('a2', `AUTHENTICATE PLAIN ${same}`)).tagged).toMatch(/^a2 OK /);
    c.close();
  });

  it('IMAP: empty, NUL-embedded and undecodable credentials never authenticate', async () => {
    const attempts: (string | Buffer)[] = [
      'LOGIN "" ""',
      `LOGIN ${q(alice.address)} ""`,
      `LOGIN "" ${q(alice.imapPassword)}`,
      'AUTHENTICATE PLAIN =',
      `AUTHENTICATE PLAIN ${b64(`${NUL}${NUL}`)}`,
      `AUTHENTICATE PLAIN ${b64(`${NUL}${alice.address}${NUL}${alice.imapPassword}${NUL}`)}`,
      `AUTHENTICATE PLAIN ${b64(`${NUL}${alice.address}${NUL}${NUL}${alice.imapPassword}`)}`,
      `AUTHENTICATE PLAIN ${b64(`${alice.address}${NUL}${alice.imapPassword}`)}`,
      'AUTHENTICATE PLAIN !!!!',
      'AUTHENTICATE LOGIN',
      'AUTHENTICATE XOAUTH2 dXNlcj1hbGljZQ==',
    ];
    const c = await imaps();
    let n = 0;
    for (const a of attempts) {
      const tag = `n${String(n++)}`;
      const r = await c.command(tag, a.toString());
      expect(r.tagged, a.toString()).toMatch(new RegExp(`^${tag} (NO|BAD) `));
    }
    // A NUL inside a quoted string or a literal is not IMAP text at all.
    c.write(`x1 LOGIN ${q(`${alice.address}${NUL}`)} ${q(alice.imapPassword)}\r\n`);
    expect((await c.collect('x1')).tagged).toMatch(/^x1 (NO|BAD) /);
    const user = Buffer.from(`${alice.address}${NUL}`);
    c.write(`x2 LOGIN {${String(user.length)}}\r\n`);
    const cont = await c.next();
    if (cont?.startsWith('+') === true) {
      c.write(Buffer.concat([user, Buffer.from(` ${q(alice.imapPassword)}\r\n`)]));
      expect((await c.collect('x2')).tagged).toMatch(/^x2 (NO|BAD) /);
    } else {
      expect(cont).toMatch(/^x2 (NO|BAD) /);
    }
    await imapStillAnonymous(c);
    c.close();
  });

  it('IMAP: a SASL continuation that is cancelled or garbage grants nothing', async () => {
    const c = await imaps();
    c.write('s1 AUTHENTICATE PLAIN\r\n');
    expect(await c.next()).toMatch(/^\+/);
    c.write('*\r\n');
    expect((await c.collect('s1')).tagged).toMatch(/^s1 BAD /);
    c.write('s2 AUTHENTICATE PLAIN\r\n');
    expect(await c.next()).toMatch(/^\+/);
    c.write('%%%%\r\n');
    expect((await c.collect('s2')).tagged).toMatch(/^s2 BAD /);
    await imapStillAnonymous(c);
    c.close();
  });

  it('IMAP: a revoked app password is refused at once', async () => {
    const c = await imaps();
    expect((await c.command('r1', `LOGIN ${q(revoked.address)} ${q(revoked.imapPassword)}`)).tagged).toMatch(/^r1 OK /);
    c.close();
    await revokeAppPassword(w.db, { kind: 'system', label: 'adversarial-suite' }, { id: revoked.imapPasswordId });
    const d = await imaps();
    expect((await d.command('r2', `LOGIN ${q(revoked.address)} ${q(revoked.imapPassword)}`)).tagged).toMatch(/^r2 NO \[AUTHENTICATIONFAILED\]/);
    await imapStillAnonymous(d);
    d.close();
  });

  it('IMAP: past the throttle ceiling even the right password is refused', async () => {
    const victim = await w.account();
    const locked = await w.imap({ throttle: w.throttle({ sourceCeiling: 3 }) });
    const c = await imaps(locked.tlsPort);
    expect((await c.command('t1', `LOGIN ${q(victim.address)} ${q(victim.imapPassword)}`)).tagged).toMatch(/^t1 NO \[UNAVAILABLE\]/);
    await imapStillAnonymous(c);
    c.close();
  });
});
