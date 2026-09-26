// Adversarial class 8 — IMAP literal abuse (PST-REQ-087, PST-REQ-070).
//
// Expected safe behaviour: a client can never make the server allocate, or wait for, more than the
// reader's fixed ceilings — 64 KiB per line, 1 MiB per command (APPEND data streams, ≤ 100 MB), 64
// literals per command, 4096 octets per non-synchronizing literal (LITERAL-, RFC 7888), 16 levels
// of parentheses — and hitting a ceiling is decided from the announced size, before any byte of
// the literal is accepted:
//   - an oversized synchronizing literal gets a tagged NO [TOOBIG] and no "+" continuation; the
//     session carries on;
//   - an oversized non-synchronizing literal is already on its way and cannot be framed, so it is
//     "* BYE" and the connection closes;
//   - too many literals, too-long lines and too-deep nesting are a tagged BAD, the rest of the
//     command is discarded without being kept, and the session carries on;
//   - none of this is any different before authentication (APPEND pre-auth never gets a "+");
//   - a stream of bad commands ends in BYE.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient } from './support/imap-client.js';
import { DATABASE_URL, World, type Account } from './support/world.js';

const MiB = 1024 * 1024;

describe.skipIf(DATABASE_URL === undefined)('adversarial: IMAP literal abuse (PST-REQ-087 / PST-REQ-070)', () => {
  let w: World;
  let alice: Account;
  let imap993 = 0;

  beforeAll(async () => {
    w = await World.create('pst_adv_literal');
    alice = await w.account();
    imap993 = (await w.imap()).tlsPort;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  async function anon(): Promise<ImapClient> {
    const c = await ImapClient.implicitTls(imap993);
    expect(await c.next()).toMatch(/^\* OK /);
    return c;
  }

  async function authed(select = false): Promise<ImapClient> {
    const c = await anon();
    expect((await c.command('l0', `LOGIN "${alice.address}" "${alice.imapPassword}"`)).tagged).toMatch(/^l0 OK /);
    if (select) expect((await c.command('l1', 'SELECT INBOX')).tagged).toMatch(/^l1 OK /);
    return c;
  }

  /** The session still answers a plain command. */
  async function alive(c: ImapClient): Promise<void> {
    expect((await c.command('zz', 'NOOP')).tagged).toMatch(/^zz OK /);
  }

  const buffered = (): number => process.memoryUsage().arrayBuffers;

  it('a huge synchronizing literal is refused from its announced size: NO [TOOBIG], no "+", nothing allocated', async () => {
    const before = buffered();
    for (const size of ['2000000', '99999999999', '18446744073709551616', '9'.repeat(400)]) {
      const c = await anon();
      c.write(`a1 LOGIN {${size}}\r\n`);
      const r = await c.next();
      expect(r, size).toMatch(/^a1 NO \[TOOBIG\]/);
      // The client was never invited to send it.
      expect(c.transcript.some((l) => l.startsWith('+'))).toBe(false);
      await alive(c);
      c.close();
    }
    expect(buffered() - before).toBeLessThan(32 * MiB);
  });

  it('APPEND past the 100 MB ceiling is refused before any data, and APPEND before login never gets a "+"', async () => {
    const c = await authed();
    c.write('a1 APPEND INBOX {200000000}\r\n');
    expect(await c.next()).toMatch(/^a1 NO \[TOOBIG\]/);
    c.write(`a2 APPEND INBOX {${'9'.repeat(30)}}\r\n`);
    expect(await c.next()).toMatch(/^a2 NO \[TOOBIG\]/);
    expect(c.transcript.some((l) => l.startsWith('+'))).toBe(false);
    await alive(c);
    c.close();

    const d = await anon();
    d.write('p1 APPEND INBOX {50}\r\n');
    expect(await d.next()).toMatch(/^p1 BAD /);
    expect(d.transcript.some((l) => l.startsWith('+'))).toBe(false);
    await alive(d);
    d.close();
  });

  it('a non-synchronizing literal over 4096 octets (LITERAL-) is BYE and close — before and after login', async () => {
    for (const make of [anon, () => authed()]) {
      const c = await make();
      c.write(`b1 LOGIN {4097+}\r\n${'x'.repeat(4097)} y\r\n`);
      const lines = await c.drain(3_000);
      expect(lines.some((l) => /^\* BYE /.test(l))).toBe(true);
      expect(await c.closed()).toBe(true);
    }
    // Pre-auth APPEND with a huge non-synchronizing literal: same.
    const d = await anon();
    d.write('b2 APPEND INBOX {500000000+}\r\n');
    const lines = await d.drain(3_000);
    expect(lines.some((l) => /^\* BYE /.test(l))).toBe(true);
    expect(await d.closed()).toBe(true);
  });

  it('non-synchronizing literals within LITERAL- work before login, but grant nothing', async () => {
    const c = await anon();
    const user = Buffer.from(alice.address);
    const pass = Buffer.from('not-the-password');
    c.write(Buffer.concat([
      Buffer.from(`c1 LOGIN {${String(user.length)}+}\r\n`), user,
      Buffer.from(` {${String(pass.length)}+}\r\n`), pass, Buffer.from('\r\n'),
    ]));
    expect((await c.collect('c1')).tagged).toMatch(/^c1 NO \[AUTHENTICATIONFAILED\]/);
    // Pre-auth APPEND with a small non-synchronizing literal: its bytes are skipped, not stored.
    const msg = Buffer.from('From: x@evil.example\r\nSubject: pre-auth\r\n\r\nx\r\n');
    c.write(Buffer.concat([Buffer.from(`c2 APPEND INBOX {${String(msg.length)}+}\r\n`), msg, Buffer.from('\r\n')]));
    expect((await c.collect('c2')).tagged).toMatch(/^c2 BAD /);
    await alive(c);
    c.close();
    const inbox = await w.db.mailbox.findFirstOrThrow({ where: { accountId: alice.id, name: 'INBOX' } });
    expect(await w.db.message.count({ where: { mailboxId: inbox.id } })).toBe(0);
  });

  it('literal count exhaustion: the 65th literal in one command is BAD, its bytes skipped, the session carries on', async () => {
    for (const make of [anon, () => authed()]) {
      const c = await make();
      const parts: string[] = ['d1 LOGIN'];
      for (let i = 0; i < 70; i++) parts.push(` {1+}\r\nx`);
      c.write(`${parts.join('')}\r\n`);
      expect((await c.collect('d1')).tagged).toMatch(/^d1 BAD /);
      await alive(c);
      c.close();
    }
  });

  it('literals adding up past the 1 MiB command ceiling are refused at the one that crosses it', async () => {
    const c = await anon();
    const chunk = 600_000;
    c.write(`e1 LOGIN {${String(chunk)}}\r\n`);
    expect(await c.next()).toMatch(/^\+/);
    c.write(`${'u'.repeat(chunk)} {${String(chunk)}}\r\n`);
    expect(await c.next()).toMatch(/^e1 NO \[TOOBIG\]/);
    await alive(c);
    c.close();
  });

  it('a line over 64 KiB — or a megabyte with no line end at all — is BAD, never buffered whole', async () => {
    const before = buffered();
    const c = await anon();
    c.write(`f1 LOGIN ${'a'.repeat(70_000)} b\r\n`);
    expect((await c.collect('f1')).tagged).toMatch(/^f1 BAD /);
    await alive(c);
    // 4 MiB without CRLF, then the line end: one BAD, and the session is still in step.
    const blob = Buffer.alloc(MiB, 0x61);
    c.write('f2 LOGIN ');
    for (let i = 0; i < 4; i++) c.write(blob);
    c.write('\r\n');
    expect((await c.collect('f2', 20_000)).tagged).toMatch(/^f2 BAD /);
    await alive(c);
    c.close();
    expect(buffered() - before).toBeLessThan(64 * MiB);
  });

  it('deeply nested parentheses are BAD (no stack overflow), before and after login', async () => {
    const c = await anon();
    c.write(`g1 LOGIN ${'('.repeat(20_000)}\r\n`);
    expect((await c.collect('g1')).tagged).toMatch(/^g1 BAD /);
    await alive(c);
    c.close();
    const d = await authed(true);
    for (const depth of [17, 100, 10_000, 30_000]) {
      const r = await d.command(`g${String(depth)}`, `SEARCH ${'('.repeat(depth)}ALL${')'.repeat(depth)}`);
      expect(r.tagged, String(depth)).toMatch(/ BAD /);
    }
    const nots = await d.command('g2', `SEARCH ${'NOT '.repeat(5_000)}ALL`);
    expect(nots.tagged).toMatch(/^g2 BAD /);
    const ors = await d.command('g3', `SEARCH ${'OR ALL '.repeat(5_000)}ALL`);
    expect(ors.tagged).toMatch(/^g3 BAD /);
    // A reasonable nesting is fine.
    expect((await d.command('g4', 'SEARCH ((ALL))')).tagged).toMatch(/^g4 OK /);
    d.close();
  });

  it('malformed literal markers and literal8 where it is not allowed are BAD, not literals', async () => {
    const c = await anon();
    for (const [tag, text] of [
      ['h1', 'LOGIN {-1}'],
      ['h2', 'LOGIN {1a}'],
      ['h3', 'LOGIN { 5}'],
      ['h4', 'LOGIN {}'],
      ['h5', 'LOGIN ~{5+}\r\nxxxxx y'],
    ] as const) {
      c.write(`${tag} ${text}\r\n`);
      const line = await c.next();
      expect(line, text).toMatch(new RegExp(`^${tag} (BAD|NO) `));
    }
    expect(c.transcript.some((l) => l.startsWith('+'))).toBe(false);
    await alive(c);
    c.close();
  });

  it('a synchronizing literal the client never sends ends in the pre-auth idle timeout, not a held slot', async () => {
    const quick = await w.imap({ preauthTimeoutMs: 500 });
    const c = await ImapClient.implicitTls(quick.tlsPort);
    await c.next();
    c.write('i1 LOGIN {100}\r\n');
    expect(await c.next()).toMatch(/^\+/);
    const lines = await c.drain(3_000);
    expect(lines.some((l) => /^\* BYE /.test(l))).toBe(true);
    expect(await c.closed()).toBe(true);
  });

  it('a flood of bad commands ends in BYE', async () => {
    const c = await anon();
    for (let i = 0; i < 25; i++) c.write(`j${String(i)} FROB {x}\r\n`);
    const lines = await c.drain(5_000);
    expect(lines.some((l) => /^\* BYE /.test(l))).toBe(true);
    expect(await c.closed()).toBe(true);
  });
});
