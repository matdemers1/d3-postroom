// PST-T-6.3, PST-REQ-118: a real smtp-in session, over loopback against a real database, ends with
// exactly one compressed transcript row that never says who or what the recipient is by anything
// other than what actually crossed the wire, and never a message body.
import { reply } from '@postroom/smtp-proto';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import { createSmtpInServer, type SmtpInServer } from '../../src/server.js';
import { decompressTranscript } from '../../src/transcript.js';
import { TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('smtp-in session transcripts (PST-T-6.3)', () => {
  let t: TestDatabase;
  let server: SmtpInServer;
  let port: number;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t63_smtpin');
    const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    await t.db.address.create({ data: { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId } });

    server = createSmtpInServer({
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
      spfDns: { txt: () => Promise.resolve({ records: [], void: true }), a: () => Promise.resolve({ records: [], void: true }), aaaa: () => Promise.resolve({ records: [], void: true }), mx: () => Promise.resolve({ records: [], void: true }), ptr: () => Promise.resolve({ records: [], void: true }) },
      dkimDns: { txt: () => Promise.resolve([]) },
      reverseLookup: () => Promise.resolve(null),
      acceptMessage: async (_ctx, body) => {
        // Drain — this test only cares about the transcript, not storage.
        let drained = 0;
        for await (const chunk of body) drained += (chunk as Buffer).length;
        expect(drained).toBeGreaterThan(0);
        return reply(250, '2.0.0', 'accepted for test');
      },
      log: () => undefined,
    });
    port = (await server.listen(0, '127.0.0.1')).port;
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await t.drop();
  });

  it('records one compressed transcript with no message body and no relay attempt visible as anything but a line', async () => {
    const before = await t.db.smtpTranscript.findMany({ where: { daemon: 'smtp-in' } });

    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO client.example')).code).toBe(250);
    expect((await c.cmd('MAIL FROM:<sender@example.org>')).code).toBe(250);
    expect((await c.cmd('RCPT TO:<matt@d3cloud.io>')).code).toBe(250);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write('Subject: hi\r\n\r\nthis is the secret body\r\n.\r\n');
    expect((await c.next()).code).toBe(250);
    await c.quit();
    expect(await c.closed()).toBe(true);

    // finish() runs after session.done, which resolves once QUIT's 221 has been sent and the
    // connection is closing — poll briefly rather than assume a specific tick.
    let rows: Awaited<ReturnType<typeof t.db.smtpTranscript.findMany>> = [];
    for (let i = 0; i < 50; i++) {
      rows = await t.db.smtpTranscript.findMany({ where: { daemon: 'smtp-in' } });
      if (rows.length > before.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(rows.length).toBe(before.length + 1);
    const row = rows[rows.length - 1];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.compressedBytes).toBeGreaterThan(0);
    expect(row.rawBytes).toBeGreaterThan(0);
    expect(row.lineCount).toBeGreaterThan(0);
    expect(row.compression).toBe('gzip');

    const text = decompressTranscript(row);
    expect(text).toContain('C: EHLO client.example');
    expect(text).toContain('C: MAIL FROM:<sender@example.org>');
    expect(text).toContain('C: RCPT TO:<matt@d3cloud.io>');
    expect(text).toContain('C: DATA');
    expect(text).toMatch(/\[message body: \d+ bytes\]/);
    expect(text).not.toContain('this is the secret body');
    expect(text).not.toContain('Subject: hi');
  });
});
