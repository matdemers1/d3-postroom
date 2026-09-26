// PST-T-3.3 doneWhen, per extension, over real loopback TLS against a real database:
//   IDLE       (RFC 2177; PST-REQ-073) — a change made anywhere (the worker's path, another IMAP
//              session) reaches an idling session within 2 s; DONE ends it; a killed LISTEN backend
//              reconnects and nothing is missed; an overlong IDLE ends in BYE.
//   CONDSTORE  (RFC 7162 §3.1) — ENABLE and implicit enabling, MODSEQ in FETCH, [MODIFIED],
//              STATUS HIGHESTMODSEQ, SEARCH MODSEQ.
//   QRESYNC    (RFC 7162 §3.2) — SELECT (QRESYNC …) answers VANISHED (EARLIER) with exactly the
//              UIDs expunged since the client's modseq and FETCH for exactly the changed messages;
//              UID FETCH (CHANGEDSINCE m VANISHED); VANISHED replaces EXPUNGE; [CLOSED].
// The remaining PST-REQ-071 capabilities (MOVE, UIDPLUS, SPECIAL-USE, NAMESPACE, ESEARCH, LITERAL-,
// ENABLE) are exercised by the rev1/rev2 scripts in sessions.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgMailboxNotifier } from '../../src/extensions/notify.js';
import { PLAIN } from '../fixtures.js';
import { ImapClient } from './client.js';
import { hasOpenssl, makeAccount, seedMessage, startHarness, type Account, type Harness } from './harness.js';

const canRun = process.env['DATABASE_URL'] !== undefined && (await hasOpenssl());

const PUSH_BUDGET_MS = 2_000;

describe.skipIf(!canRun)('IMAP extensions (PST-T-3.3)', () => {
  let h: Harness;
  const open: ImapClient[] = [];

  beforeAll(async () => {
    h = await startHarness('pst_t33');
  }, 120_000);

  afterAll(async () => {
    for (const c of open) c.close();
    await h.close();
  });

  async function login(account: Account, port = h.tlsPort): Promise<ImapClient> {
    const c = await ImapClient.tls(port);
    open.push(c);
    expect(await c.next()).toMatch(/^\* OK /);
    expect((await c.command(`LOGIN ${account.address} ${account.appPassword}`)).tagged).toMatch(/^A\d+ OK /);
    return c;
  }

  async function mailboxId(account: Account, name = 'INBOX'): Promise<string> {
    return (await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name } })).id;
  }

  /** File a message the way the worker does: fileLocalMessage, then pg_notify. */
  async function deliver(account: Account): Promise<number> {
    const uid = await seedMessage(h, account.id, 'INBOX', PLAIN);
    await h.db.$executeRaw`SELECT pg_notify('postroom_mailbox', ${await mailboxId(account)})`;
    return uid;
  }

  /** Read responses until one matches; returns it, how long it took, and everything before it. */
  async function waitFor(c: ImapClient, re: RegExp, timeoutMs = 5_000): Promise<{ line: string; ms: number; seen: string[] }> {
    const started = Date.now();
    const seen: string[] = [];
    for (;;) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) throw new Error(`no ${String(re)} within ${timeoutMs} ms; saw ${JSON.stringify(seen)}`);
      const line = await c.next(left);
      if (line === null) throw new Error(`connection closed waiting for ${String(re)}; saw ${JSON.stringify(seen)}`);
      if (re.test(line)) return { line, ms: Date.now() - started, seen };
      seen.push(line);
    }
  }

  function notifier(): PgMailboxNotifier {
    const n = h.listeners.notifier;
    if (!(n instanceof PgMailboxNotifier)) throw new Error('the harness has no LISTEN connection');
    return n;
  }

  async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function listenPids(): Promise<number[]> {
    const rows = await h.db.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN postroom_mailbox'`;
    return rows.map((r) => r.pid);
  }

  async function highestModseq(account: Account, name = 'INBOX'): Promise<bigint> {
    return (await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name } })).highestModseq;
  }

  function selectModseq(untagged: readonly string[]): bigint {
    for (const l of untagged) {
      const m = /^\* OK \[HIGHESTMODSEQ (\d+)\]/.exec(l);
      if (m?.[1] !== undefined) return BigInt(m[1]);
    }
    throw new Error(`no HIGHESTMODSEQ in ${JSON.stringify(untagged)}`);
  }

  describe('capabilities (PST-REQ-071)', () => {
    it('advertises IDLE, CONDSTORE and QRESYNC beside the core extensions once authenticated', async () => {
      const account = await makeAccount(h);
      const c = await ImapClient.tls(h.tlsPort);
      open.push(c);
      const greeting = await c.next();
      expect(greeting).not.toMatch(/IDLE|CONDSTORE|QRESYNC/);
      await c.command(`LOGIN ${account.address} ${account.appPassword}`);
      const caps = (await c.command('CAPABILITY')).untagged[0]?.split(' ') ?? [];
      for (const cap of ['IMAP4rev1', 'IMAP4rev2', 'IDLE', 'MOVE', 'UIDPLUS', 'SPECIAL-USE', 'NAMESPACE', 'ESEARCH', 'LITERAL-', 'ENABLE', 'CONDSTORE', 'QRESYNC']) {
        expect(caps).toContain(cap);
      }
      c.close();
    });
  });

  describe('IDLE (RFC 2177, PST-REQ-073)', () => {
    it('pushes EXISTS, FETCH FLAGS and EXPUNGE within 2 s, and DONE ends it', async () => {
      const account = await makeAccount(h);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      const a = await login(account);
      const b = await login(account);
      expect((await a.command('SELECT INBOX')).tagged).toMatch(/OK \[READ-WRITE\]/);
      expect((await b.command('SELECT INBOX')).tagged).toMatch(/OK \[READ-WRITE\]/);

      a.write('I1 IDLE\r\n');
      expect(await a.next()).toBe('+ idling');
      await until(() => notifier().connected);

      // A new message, filed the way the worker files it.
      let t0 = Date.now();
      await deliver(account);
      const exists = await waitFor(a, /^\* 3 EXISTS$/);
      const existsMs = Date.now() - t0;
      console.log(`IDLE push latency: EXISTS ${existsMs} ms`);
      expect(existsMs).toBeLessThan(PUSH_BUDGET_MS);
      expect(exists.seen).toEqual([]);

      // Another IMAP session flags a message.
      t0 = Date.now();
      expect((await b.command('STORE 1 +FLAGS.SILENT (\\Flagged)')).tagged).toMatch(/OK/);
      await waitFor(a, /^\* 1 FETCH \(UID 1 FLAGS \(\\Flagged\)\)$/);
      const flagMs = Date.now() - t0;
      console.log(`IDLE push latency: FETCH FLAGS ${flagMs} ms`);
      expect(flagMs).toBeLessThan(PUSH_BUDGET_MS);

      // …and expunges one.
      t0 = Date.now();
      await b.command('STORE 2 +FLAGS.SILENT (\\Deleted)');
      expect((await b.command('EXPUNGE')).untagged).toEqual(['* 2 EXPUNGE']);
      await waitFor(a, /^\* 2 EXPUNGE$/);
      const expungeMs = Date.now() - t0;
      console.log(`IDLE push latency: EXPUNGE ${expungeMs} ms`);
      expect(expungeMs).toBeLessThan(PUSH_BUDGET_MS);

      a.write('DONE\r\n');
      expect((await a.collect('I1')).tagged).toBe('I1 OK IDLE terminated');
      // The session is in step: a NOOP has nothing left to say.
      expect(await a.command('NOOP', 'N1')).toEqual({ untagged: [], tagged: 'N1 OK NOOP completed' });
      expect(await a.command('UID FETCH 1:* (UID)', 'F1')).toEqual({
        untagged: ['* 1 FETCH (UID 1)', '* 2 FETCH (UID 3)'],
        tagged: 'F1 OK FETCH completed',
      });
    });

    it('reconnects a killed LISTEN backend and still delivers (nothing is missed while it is down)', async () => {
      const account = await makeAccount(h);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      const a = await login(account);
      await a.command('SELECT INBOX');
      a.write('I2 IDLE\r\n');
      expect(await a.next()).toBe('+ idling');
      await until(() => notifier().connected);
      const before = notifier().connects;
      const pids = await listenPids();
      expect(pids).toHaveLength(1);

      await h.db.$executeRaw`SELECT pg_terminate_backend(${pids[0]}::int)`;
      // Filed and notified while nobody may be listening: the reconnect's full resync delivers it.
      await deliver(account);
      await waitFor(a, /^\* 2 EXISTS$/);
      await until(() => notifier().connects > before && notifier().connected);
      const after = await listenPids();
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(pids[0]);

      // And the next change arrives over the new connection, within the budget.
      const t0 = Date.now();
      await deliver(account);
      await waitFor(a, /^\* 3 EXISTS$/);
      expect(Date.now() - t0).toBeLessThan(PUSH_BUDGET_MS);
      a.write('DONE\r\n');
      expect((await a.collect('I2')).tagged).toBe('I2 OK IDLE terminated');
    });

    it('works without a selected mailbox, rejects anything but DONE, and says BYE when IDLE runs too long', async () => {
      const account = await makeAccount(h);
      const a = await login(account);
      a.write('I3 IDLE\r\n');
      expect(await a.next()).toBe('+ idling');
      a.write('done\r\n');
      expect((await a.collect('I3')).tagged).toBe('I3 OK IDLE terminated');

      await a.command('SELECT INBOX');
      a.write('I4 IDLE\r\n');
      expect(await a.next()).toBe('+ idling');
      a.write('NOOP\r\n');
      expect((await a.collect('I4')).tagged).toBe('I4 BAD Expected DONE');

      const short = await h.listenersWith({ maxIdleMs: 300 });
      const s = await login(account, short.tlsPort);
      await s.command('SELECT INBOX');
      s.write('I5 IDLE\r\n');
      expect(await s.next()).toBe('+ idling');
      expect(await s.next()).toBe('* BYE Autologout; idle for too long');
      expect(await s.next()).toBeNull();
    });

    it('under CONDSTORE and QRESYNC, pushes FETCH with MODSEQ and VANISHED instead of EXPUNGE', async () => {
      const account = await makeAccount(h);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      const a = await login(account);
      const b = await login(account);
      expect((await a.command('ENABLE QRESYNC')).untagged).toEqual(['* ENABLED QRESYNC']);
      await a.command('SELECT INBOX');
      await b.command('SELECT INBOX');
      a.write('I6 IDLE\r\n');
      expect(await a.next()).toBe('+ idling');

      await b.command('STORE 1 +FLAGS.SILENT (\\Seen)');
      const m = await highestModseq(account);
      await waitFor(a, new RegExp(`^\\* 1 FETCH \\(UID 1 FLAGS \\(\\\\Seen\\) MODSEQ \\(${m}\\)\\)$`));
      await b.command('STORE 1 +FLAGS.SILENT (\\Deleted)');
      await b.command('EXPUNGE');
      const gone = await waitFor(a, /^\* VANISHED /);
      expect(gone.line).toBe('* VANISHED 1');
      expect(gone.seen.filter((l) => l.includes('EXPUNGE'))).toEqual([]);
      a.write('DONE\r\n');
      expect((await a.collect('I6')).tagged).toBe('I6 OK IDLE terminated');
    });
  });

  describe('CONDSTORE (RFC 7162 §3.1)', () => {
    it('ENABLE CONDSTORE puts MODSEQ in FETCH; UNCHANGEDSINCE conflicts answer [MODIFIED]; STATUS HIGHESTMODSEQ', async () => {
      const account = await makeAccount(h);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      const a = await login(account);
      const b = await login(account);

      expect(await a.command('ENABLE CONDSTORE', 'E1')).toEqual({ untagged: ['* ENABLED CONDSTORE'], tagged: 'E1 OK ENABLE completed' });
      await a.command('SELECT INBOX');
      await b.command('SELECT INBOX');
      expect((await a.command('FETCH 1:2 (FLAGS)')).untagged).toEqual(['* 1 FETCH (FLAGS () MODSEQ (1))', '* 2 FETCH (FLAGS () MODSEQ (2))']);
      // A macro with FLAGS gets MODSEQ too.
      expect((await a.command('FETCH 1 FAST')).untagged[0]).toMatch(/^\* 1 FETCH \(FLAGS \(\) INTERNALDATE ".*" RFC822\.SIZE \d+ MODSEQ \(1\)\)$/);

      // STORE answers carry MODSEQ once CONDSTORE is on.
      const stored = await a.command('STORE 1 +FLAGS (\\Answered)');
      expect(stored.untagged).toEqual(['* 1 FETCH (FLAGS (\\Answered) MODSEQ (3))']);

      // B changes message 2 behind A's back: A's conditional STORE on it fails with [MODIFIED 2].
      await b.command('STORE 2 +FLAGS (\\Flagged)');
      const conflict = await a.command('STORE 1:2 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)', 'S1');
      expect(conflict.tagged).toBe('S1 OK [MODIFIED 2] Some messages were modified since');
      expect(conflict.untagged).toContain('* 1 FETCH (FLAGS (\\Answered \\Seen) MODSEQ (5))');

      // STATUS HIGHESTMODSEQ is the mailbox's.
      const hm = await highestModseq(account);
      expect(hm).toBe(5n);
      const status = await b.command('STATUS INBOX (HIGHESTMODSEQ MESSAGES)');
      expect(status.untagged).toContain(`* STATUS "INBOX" (HIGHESTMODSEQ ${hm} MESSAGES 2)`);
      // STATUS (HIGHESTMODSEQ) made B CONDSTORE-aware, so A's change reaches it with its MODSEQ.
      expect(status.untagged).toContain('* 1 FETCH (UID 1 FLAGS (\\Answered \\Seen) MODSEQ (5))');

      // SEARCH MODSEQ reports the highest modseq of what it found.
      expect((await a.command('SEARCH MODSEQ 4')).untagged).toEqual(['* SEARCH 1 2 (MODSEQ 5)']);
      expect((await a.command('SEARCH RETURN (ALL) MODSEQ 5', 'R1')).untagged).toEqual(['* ESEARCH (TAG "R1") ALL 1 MODSEQ 5']);
    });

    it('is enabled implicitly by the first CONDSTORE enabling command', async () => {
      const account = await makeAccount(h);
      await seedMessage(h, account.id, 'INBOX', PLAIN);
      const a = await login(account);
      await a.command('SELECT INBOX');
      expect((await a.command('FETCH 1 (FLAGS)')).untagged).toEqual(['* 1 FETCH (FLAGS ())']);
      expect((await a.command('FETCH 1 (MODSEQ)')).untagged).toEqual(['* 1 FETCH (MODSEQ (1))']);
      expect((await a.command('FETCH 1 (FLAGS)')).untagged).toEqual(['* 1 FETCH (FLAGS () MODSEQ (1))']);

      // SELECT (CONDSTORE) on a fresh session does the same.
      const c = await login(account);
      await c.command('SELECT INBOX (CONDSTORE)');
      expect((await c.command('FETCH 1 (FLAGS)')).untagged).toEqual(['* 1 FETCH (FLAGS () MODSEQ (1))']);
      // Unsolicited flag updates carry MODSEQ as well.
      await a.command('STORE 1 +FLAGS.SILENT (\\Seen)');
      expect((await c.command('NOOP')).untagged).toEqual(['* 1 FETCH (UID 1 FLAGS (\\Seen) MODSEQ (2))']);
    });
  });

  describe('QRESYNC (RFC 7162 §3.2)', () => {
    async function scenario(): Promise<{ account: Account; v: number; m: bigint }> {
      const account = await makeAccount(h);
      for (let i = 0; i < 5; i++) await seedMessage(h, account.id, 'INBOX', PLAIN);
      const b = await login(account);
      await b.command('SELECT INBOX');
      // Expunged before the client's cached state: never reported.
      await b.command('UID STORE 1 +FLAGS.SILENT (\\Deleted)');
      await b.command('UID EXPUNGE 1');
      // The client caches (UIDVALIDITY, HIGHESTMODSEQ) here and goes away.
      const a = await login(account);
      expect((await a.command('ENABLE QRESYNC')).untagged).toEqual(['* ENABLED QRESYNC']);
      const sel = await a.command('SELECT INBOX');
      const m = selectModseq(sel.untagged);
      a.close();
      // Meanwhile another session expunges UIDs 2 and 3 and flags UID 4.
      await b.command('UID STORE 2:3 +FLAGS.SILENT (\\Deleted)');
      await b.command('UID EXPUNGE 2:3');
      await b.command('UID STORE 4 +FLAGS.SILENT (\\Flagged)');
      b.close();
      const v = (await h.db.mailbox.findFirstOrThrow({ where: { accountId: account.id, name: 'INBOX' } })).uidvalidity;
      return { account, v, m };
    }

    it('SELECT (QRESYNC (v m)) answers VANISHED (EARLIER) with exactly the expunged UIDs and FETCH for the changed ones', async () => {
      const { account, v, m } = await scenario();
      const flaggedAt = await highestModseq(account);
      const a = await login(account);
      await a.command('ENABLE QRESYNC');
      const r = await a.command(`SELECT INBOX (QRESYNC (${v} ${m}))`, 'Q1');
      expect(r.tagged).toBe('Q1 OK [READ-WRITE] SELECT completed');
      expect(r.untagged).toContain('* 2 EXISTS');
      expect(r.untagged.filter((l) => l.startsWith('* VANISHED'))).toEqual(['* VANISHED (EARLIER) 2:3']);
      expect(r.untagged.filter((l) => / FETCH /.test(l))).toEqual([`* 1 FETCH (UID 4 FLAGS (\\Flagged) MODSEQ (${flaggedAt}))`]);

      // Known UIDs narrow the answer.
      const k = await a.command(`EXAMINE INBOX (QRESYNC (${v} ${m} 3:5))`, 'Q2');
      expect(k.untagged[0]).toBe('* OK [CLOSED] Previous mailbox is now closed');
      expect(k.untagged.filter((l) => l.startsWith('* VANISHED'))).toEqual(['* VANISHED (EARLIER) 3']);

      // A stale UIDVALIDITY means a plain SELECT.
      const w = await a.command(`SELECT INBOX (QRESYNC (${v + 1} ${m}))`, 'Q3');
      expect(w.tagged).toBe('Q3 OK [READ-WRITE] SELECT completed');
      expect(w.untagged.filter((l) => l.startsWith('* VANISHED') || / FETCH /.test(l))).toEqual([]);
    });

    it('UID FETCH (CHANGEDSINCE m VANISHED), VANISHED for our own EXPUNGE, and BAD without ENABLE', async () => {
      const { account, v, m } = await scenario();
      const flaggedAt = await highestModseq(account);

      const plain = await login(account);
      expect((await plain.command(`SELECT INBOX (QRESYNC (${v} ${m}))`, 'P1')).tagged).toBe('P1 BAD QRESYNC is not enabled');
      await plain.command('SELECT INBOX');
      expect((await plain.command(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${m} VANISHED)`, 'P2')).tagged).toBe('P2 BAD VANISHED requires ENABLE QRESYNC');

      const a = await login(account);
      await a.command('ENABLE QRESYNC');
      await a.command('SELECT INBOX');
      expect(await a.command(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${m} VANISHED)`, 'F1')).toEqual({
        untagged: ['* VANISHED (EARLIER) 2:3', `* 1 FETCH (UID 4 FLAGS (\\Flagged) MODSEQ (${flaggedAt}))`],
        tagged: 'F1 OK FETCH completed',
      });
      // Only the UIDs in the set are reported.
      expect((await a.command(`UID FETCH 3:5 (FLAGS) (CHANGEDSINCE ${m} VANISHED)`)).untagged[0]).toBe('* VANISHED (EARLIER) 3');

      // Our own EXPUNGE is announced as VANISHED, never "n EXPUNGE".
      await a.command('UID STORE 5 +FLAGS.SILENT (\\Deleted)');
      expect((await a.command('EXPUNGE', 'X1')).untagged).toEqual(['* VANISHED 5']);
      // And a MOVE likewise.
      const mv = await a.command('UID MOVE 4 Archive', 'X2');
      expect(mv.untagged[1]).toBe('* VANISHED 4');
      expect(mv.untagged.some((l) => l.endsWith('EXPUNGE'))).toBe(false);
    });
  });
});
