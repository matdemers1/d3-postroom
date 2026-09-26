// PST-REQ-072 as a property: random APPEND / COPY / MOVE / STORE / EXPUNGE / UID EXPUNGE from two
// concurrent sessions on one mailbox (and a second mailbox they copy and move into). After every
// step, in the database:
//   - UIDVALIDITY never changes, and a UID is never reused within it: every new UID is at least the
//     previous UIDNEXT, and was never seen before;
//   - HIGHESTMODSEQ strictly increases with every change, and does not move without one;
//   - no message's modseq exceeds HIGHESTMODSEQ, and no UID reaches UIDNEXT;
// and on the wire, after a NOOP, each session's sequence-number → UID map (kept only from the
// EXISTS / EXPUNGE / FETCH responses it received) equals the mailbox.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAIN } from '../fixtures.js';
import { ImapClient } from './client.js';
import { hasOpenssl, makeAccount, startHarness, type Account, type Harness } from './harness.js';

const canRun = process.env['DATABASE_URL'] !== undefined && (await hasOpenssl());

type Kind = 'append' | 'append-other' | 'copy' | 'copy-self' | 'move' | 'flag' | 'unflag' | 'expunge' | 'uid-expunge' | 'noop';

interface Op {
  readonly who: 0 | 1;
  readonly kind: Kind;
  readonly pick: number;
  /** Run at the same time as the next op, when that one is the other session's. */
  readonly together: boolean;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  who: fc.constantFrom<0 | 1>(0, 1),
  kind: fc.constantFrom<Kind>('append', 'append', 'append-other', 'copy', 'copy-self', 'move', 'flag', 'unflag', 'expunge', 'uid-expunge', 'noop'),
  pick: fc.nat(1000),
  together: fc.boolean(),
});

interface MailboxState {
  uidvalidity: number;
  uidnext: number;
  highest: bigint;
  /** uid → "flags|modseq" */
  messages: Map<number, string>;
  ever: Set<number>;
}

describe.skipIf(!canRun)('UIDs and modseq under two concurrent sessions (PST-REQ-072)', () => {
  let h: Harness;
  let account: Account;
  const clients: ImapClient[] = [];
  let run = 0;

  beforeAll(async () => {
    h = await startHarness('pst_t32p');
    account = await makeAccount(h);
    for (let i = 0; i < 2; i++) {
      const c = await ImapClient.plain(h.port);
      await c.next();
      await c.startTls();
      const r = await c.command(`LOGIN ${account.address} ${account.appPassword}`);
      expect(r.tagged).toMatch(/OK/);
      clients.push(c);
    }
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await h.close();
  });

  async function state(name: string): Promise<MailboxState & { id: string }> {
    const mb = await h.db.mailbox.findFirstOrThrow({
      where: { accountId: account.id, name },
      include: { messages: { select: { uid: true, flags: true, modseq: true } } },
    });
    return {
      id: mb.id,
      uidvalidity: mb.uidvalidity,
      uidnext: mb.uidnext,
      highest: mb.highestModseq,
      messages: new Map(mb.messages.map((m) => [m.uid, `${[...m.flags].sort().join(' ')}|${m.modseq}`])),
      ever: new Set(),
    };
  }

  function check(prev: MailboxState, next: MailboxState & { id: string }, label: string): void {
    expect(next.uidvalidity, `${label}: UIDVALIDITY changed`).toBe(prev.uidvalidity);
    expect(next.uidnext, `${label}: UIDNEXT went backwards`).toBeGreaterThanOrEqual(prev.uidnext);
    for (const uid of next.messages.keys()) {
      expect(uid, `${label}: UID ${uid} is not below UIDNEXT ${next.uidnext}`).toBeLessThan(next.uidnext);
      if (!prev.messages.has(uid)) {
        expect(prev.ever.has(uid), `${label}: UID ${uid} reused`).toBe(false);
        expect(uid, `${label}: new UID ${uid} below the previous UIDNEXT ${prev.uidnext}`).toBeGreaterThanOrEqual(prev.uidnext);
      }
      const modseq = BigInt(next.messages.get(uid)?.split('|')[1] ?? '0');
      expect(modseq <= next.highest, `${label}: modseq ${modseq} of UID ${uid} above HIGHESTMODSEQ ${next.highest}`).toBe(true);
    }
    const changed = prev.messages.size !== next.messages.size || [...next.messages].some(([uid, v]) => prev.messages.get(uid) !== v);
    if (changed) expect(next.highest > prev.highest, `${label}: changed without a new HIGHESTMODSEQ (${prev.highest} → ${next.highest})`).toBe(true);
    else expect(next.highest, `${label}: HIGHESTMODSEQ moved without a change`).toBe(prev.highest);
    next.ever = new Set([...prev.ever, ...next.messages.keys()]);
  }

  async function perform(c: ImapClient, op: Op, a: string, b: string): Promise<void> {
    const live = (c.model ?? []).filter((u) => u !== 0);
    const uid = live.length === 0 ? null : live[op.pick % live.length];
    const need = async (fn: (u: number) => Promise<unknown>): Promise<void> => {
      if (uid === null || uid === undefined) await c.command('NOOP');
      else await fn(uid);
    };
    const ok = (r: { tagged: string }): void => {
      expect(r.tagged, `${op.kind}: ${r.tagged}`).toMatch(/^A\d+ OK/);
    };
    switch (op.kind) {
      case 'append':
        ok(await c.append(a, PLAIN, op.pick % 2 === 0 ? '(\\Seen)' : ''));
        return;
      case 'append-other':
        ok(await c.append(b, PLAIN));
        return;
      case 'copy':
        return need(async (u) => { ok(await c.command(`UID COPY ${u} ${b}`)); });
      case 'copy-self':
        return need(async (u) => { ok(await c.command(`UID COPY ${u} ${a}`)); });
      case 'move':
        return need(async (u) => { ok(await c.command(`UID MOVE ${u} ${b}`)); });
      case 'flag':
        return need(async (u) => { ok(await c.command(`UID STORE ${u} +FLAGS (\\Flagged $Tag)`)); });
      case 'unflag':
        return need(async (u) => { ok(await c.command(`UID STORE ${u} -FLAGS (\\Flagged)`)); });
      case 'expunge':
        return need(async (u) => {
          ok(await c.command(`UID STORE ${u} +FLAGS.SILENT (\\Deleted)`));
          ok(await c.command('EXPUNGE'));
        });
      case 'uid-expunge':
        return need(async (u) => {
          ok(await c.command(`UID STORE ${u} +FLAGS.SILENT (\\Deleted)`));
          ok(await c.command(`UID EXPUNGE ${u}`));
        });
      case 'noop':
        ok(await c.command('NOOP'));
        return;
    }
  }

  it('holds for random interleavings', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
        run++;
        const a = `Prop${run}a`;
        const b = `Prop${run}b`;
        const [c0, c1] = clients;
        if (c0 === undefined || c1 === undefined) throw new Error('clients missing');
        expect((await c0.command(`CREATE ${a}`)).tagged).toMatch(/OK/);
        expect((await c0.command(`CREATE ${b}`)).tagged).toMatch(/OK/);
        for (const c of clients) {
          c.model = [];
          expect((await c.command(`SELECT ${a}`)).tagged).toMatch(/OK/);
        }
        let prevA = await state(a);
        let prevB = await state(b);
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op === undefined) continue;
          const next = ops[i + 1];
          if (op.together && next !== undefined && next.who !== op.who) {
            await Promise.all([perform(clients[op.who] ?? c0, op, a, b), perform(clients[next.who] ?? c1, next, a, b)]);
            i++;
          } else {
            await perform(clients[op.who] ?? c0, op, a, b);
          }
          const nowA = await state(a);
          const nowB = await state(b);
          check(prevA, nowA, `step ${i} ${a}`);
          check(prevB, nowB, `step ${i} ${b}`);
          prevA = nowA;
          prevB = nowB;
          // After NOOP each session's view is the mailbox, in UID order.
          const uids = [...nowA.messages.keys()].sort((x, y) => x - y);
          for (const c of clients) {
            expect((await c.command('NOOP')).tagged).toMatch(/OK/);
            expect(c.violations).toEqual([]);
            expect(c.model).toEqual(uids);
          }
        }
        // And the server agrees with the client's numbering.
        for (const c of clients) {
          const all = await c.command('FETCH 1:* (UID)');
          const seen = all.untagged.flatMap((l) => {
            const m = /^\* (\d+) FETCH \(UID (\d+)\)$/.exec(l);
            return m === null ? [] : [[Number(m[1]), Number(m[2])]];
          });
          expect(seen).toEqual((c.model ?? []).map((u, i) => [i + 1, u]));
        }
      }),
      { numRuns: 25, endOnFailure: true },
    );
  }, 600_000);
});
