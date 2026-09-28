// PST-T-4.15, PST-REQ-186 at the wire: a fresh install (the first-run seed: primary domain and its
// admin operator) reconciled the way the api does at start and when setup completes, ends with
// postmaster@, abuse@ and both report mailboxes resolving at RCPT — including the bare
// <Postmaster> form RFC 5321 §4.5.1 requires — and the mail reaching the right accounts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluateSpfResult, SpfDns } from '@postroom/auth-checks';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { reply } from '@postroom/smtp-proto';
// The api's reconciler itself, not a copy of the rows it makes (the precedent: api's tests import
// worker code the same way). It depends only on @postroom/db and @postroom/audit, as smtp-in does.
import { reconcileRoleAddresses } from '../../../api/src/role-addresses/index.js';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import type { AcceptMessage, InboundContext } from '../../src/data.js';
import { createSmtpInServer, type SmtpInServer } from '../../src/server.js';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];

const noDns: SpfDns = {
  txt: () => Promise.resolve({ records: [], void: true }),
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

describe.skipIf(baseUrl === undefined)('role addresses resolve at RCPT (PST-T-4.15, PST-REQ-186)', () => {
  let t: TestDatabase;
  let server: SmtpInServer;
  let port = 0;
  let operatorId = '';
  const captured: { ctx: InboundContext; spf: EvaluateSpfResult }[] = [];

  const capture: AcceptMessage = async (ctx, body, verdicts) => {
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    expect(bytes).toBeGreaterThan(0);
    captured.push({ ctx, spf: verdicts.spf });
    return reply(250, '2.0.0', 'captured');
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t415_rcpt');
    operatorId = (await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    const result = await reconcileRoleAddresses(t.db, {});
    expect(result.created.sort()).toEqual(['abuse@d3cloud.io', 'dmarc-reports@d3cloud.io', 'postmaster@d3cloud.io', 'tls-reports@d3cloud.io']);
    server = createSmtpInServer({
      db: t.db,
      hostname: 'mx.d3cloud.io',
      maxSize: MAX_MESSAGE_SIZE,
      edgePeers: [],
      proxyTimeoutMs: 5_000,
      maxConnectionsPerIp: 50,
      maxRecipientsPerMessage: 100,
      maxRecipientsPerSession: 150,
      maxErrors: 10,
      idleTimeoutMs: 60_000,
      spfDns: noDns,
      dkimDns: { txt: () => Promise.resolve([]) },
      reverseLookup: () => Promise.resolve(null),
      acceptMessage: capture,
      log: () => undefined,
    });
    port = (await server.listen(0, '127.0.0.1')).port;
  }, 120_000);

  afterAll(async () => {
    await server.close();
    await t.drop();
  });

  it('accepts <Postmaster>, postmaster@, abuse@ and both report mailboxes, delivering where they should', async () => {
    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO client.example')).code).toBe(250);
    expect(codeOf(await c.cmd('MAIL FROM:<reporter@sender.example>'))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd('RCPT TO:<Postmaster>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<postmaster@d3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<Abuse@D3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<dmarc-reports@d3cloud.io>'))).toBe('250 2.1.5');
    expect(codeOf(await c.cmd('RCPT TO:<tls-reports@d3cloud.io>'))).toBe('250 2.1.5');
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write('Subject: role addresses\r\n\r\nhello\r\n.\r\n');
    expect(codeOf(await c.next())).toBe('250 2.0.0');
    await c.quit();

    const recipients = captured[0]?.ctx.recipients ?? [];
    expect(recipients.map((r) => [r.rcpt, r.resolution.kind])).toEqual([
      ['Postmaster', 'alias'],
      ['postmaster@d3cloud.io', 'alias'],
      ['Abuse@D3cloud.io', 'alias'],
      ['dmarc-reports@d3cloud.io', 'service'],
      ['tls-reports@d3cloud.io', 'service'],
    ]);
    // postmaster@ and abuse@ reach the first admin; the report mailboxes reach their service accounts.
    for (const r of recipients.slice(0, 3)) expect(r.resolution.accountIds).toEqual([operatorId]);
    const services = await t.db.account.findMany({ where: { kind: 'service' }, select: { id: true } });
    expect(recipients.slice(3).flatMap((r) => r.resolution.accountIds).sort()).toEqual(services.map((s) => s.id).sort());
  });
});
