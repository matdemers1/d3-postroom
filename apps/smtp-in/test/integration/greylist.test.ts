// PST-REQ-062 over a real smtp-in session: an authenticated (SPF pass) first contact is accepted
// straight through; an unauthenticated bad-IP triplet is deferred with 451 4.7.1 and only accepted
// on a retry after the 5-minute delay.
//
// `server.ts` (owned by PST-T-2.6, in parallel) calls `checkGreylist` with only
// `{ clientIp, mailFrom, recipient }` today — it does not yet forward the SPF result or FCrDNS. These
// tests use the `greylist` override already exposed on `SmtpInOptions` to exercise the real
// `checkGreylist` against the real database and clock policy exactly as production will once that
// one-line wiring lands (see the task's `needsOutside`).
import type { SpfDns } from '@postroom/auth-checks';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import { checkGreylist, type GreylistInput, type GreylistVerdict } from '../../src/greylist.js';
import { createSmtpInServer, type SmtpInServer } from '../../src/server.js';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];
const MIN = 60_000;

const spfDns: SpfDns = {
  txt: (name) =>
    Promise.resolve(
      name === 'good.example' ? { records: ['v=spf1 ip4:203.0.113.50 -all'], void: false } : { records: [], void: true },
    ),
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

describe.skipIf(baseUrl === undefined)('greylist over smtp-in (PST-REQ-062)', () => {
  let t: TestDatabase;
  const servers: SmtpInServer[] = [];
  let now = new Date('2026-01-01T00:00:00Z');

  // The greylist call server.ts makes today carries neither an SPF result nor FCrDNS, which
  // checkGreylist treats as "not yet wired" and passes through unconditionally (see greylist.ts). These
  // overrides stand in for the values server.ts will supply once wired (see needsOutside): SPF pass for
  // the authenticated case, and an explicit `fcrdns: false` for the unauthenticated bad-IP case.
  function greylistOf(withSpf: boolean): (input: GreylistInput) => Promise<GreylistVerdict> {
    return (input) =>
      checkGreylist(t.db, withSpf ? { ...input, spfResult: 'pass' } : { ...input, fcrdns: false }, { now: () => now });
  }

  async function start(withSpf: boolean): Promise<number> {
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
      reverseLookup: () => Promise.resolve(null),
      greylist: greylistOf(withSpf),
      log: () => {
        /* no-op: the shared smtp-in.test.ts already covers logging */
      },
    });
    servers.push(server);
    return (await server.listen(0, '127.0.0.1')).port;
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t28');
    const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    await t.db.address.create({ data: { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId } });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await t.drop();
  });

  async function ready(port: number, helo = 'client.example'): Promise<TestClient> {
    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd(`EHLO ${helo}`)).code).toBe(250);
    return c;
  }

  it('an authenticated (SPF pass) first contact passes straight through', async () => {
    const port = await start(true);
    const c = await ready(port);
    expect(codeOf(await c.cmd('MAIL FROM:<sender@good.example>'))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
    await c.quit();
  });

  it('an unauthenticated bad-IP triplet defers with 451 4.7.1, then passes on retry after 5 minutes', async () => {
    const port = await start(false);

    const first = await ready(port);
    await first.cmd('MAIL FROM:<bad@sender.example>');
    expect(codeOf(await first.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('451 4.7.1');
    await first.quit();

    // Too soon: still inside the 5-minute delay.
    now = new Date(now.getTime() + 4 * MIN);
    const soon = await ready(port);
    await soon.cmd('MAIL FROM:<bad@sender.example>');
    expect(codeOf(await soon.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('451 4.7.1');
    await soon.quit();

    // At 5 minutes: the retry is accepted.
    now = new Date(now.getTime() + MIN);
    const retry = await ready(port);
    await retry.cmd('MAIL FROM:<bad@sender.example>');
    expect(codeOf(await retry.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
    await retry.quit();

    // A subsequent contact from the same triplet passes immediately.
    const again = await ready(port);
    await again.cmd('MAIL FROM:<bad@sender.example>');
    expect(codeOf(await again.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
    await again.quit();
  });
});
