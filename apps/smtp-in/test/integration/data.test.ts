// Durable acceptance end to end over loopback, against a real database and blob store:
// the stored message and its trace headers (PST-REQ-069), the spool row + job committed before 250
// (PST-REQ-060), DMARC reject → 550 with a Rejects copy for every local recipient (PST-REQ-058/059),
// a trusted ARC override, p=quarantine, a DNSBL listing, and a failed commit answering 451.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dnsRecordFor, type SpfDns } from '@postroom/auth-checks';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { arcSeal } from '../../../../packages/auth-checks/test/unit/fixtures/arc/signer.js';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import { createAcceptMessage, type InboundDns, type InboundStorage } from '../../src/data.js';
import type { DnsblVerdict } from '../../src/decide.js';
import { createSmtpInServer, type SmtpInServer } from '../../src/server.js';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];

let googleKey: KeyObject;
let txt: Record<string, string[]> = {};

const dns: InboundDns = {
  txt: (name) => Promise.resolve(txt[name.toLowerCase().replace(/\.$/, '')] ?? []),
};

const spfDns: SpfDns = {
  txt: (name) => {
    const records = (txt[name.toLowerCase()] ?? []).filter((r) => r.startsWith('v=spf1'));
    return Promise.resolve(records.length > 0 ? { records, void: false } : { records: [], void: true });
  },
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

function message(from: string, subject: string, body = 'hello\r\n'): string {
  return (
    `From: Alice <${from}>\r\n` +
    'To: matt@d3cloud.io\r\n' +
    `Subject: ${subject}\r\n` +
    'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
    `Message-ID: <${subject.replace(/\W/g, '')}@example>\r\n` +
    '\r\n' +
    body
  );
}

describe.skipIf(baseUrl === undefined)('smtp-in durable acceptance', () => {
  let t: TestDatabase;
  let blobRoot = '';
  let blobs: BlobStore;
  let server: SmtpInServer;
  let port = 0;
  let operatorId = '';
  let otherId = '';
  let dnsbl: DnsblVerdict | undefined;
  let failCommit = false;

  beforeAll(async () => {
    googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    t = await createTestDatabase(baseUrl ?? '', 'pst_t26');
    const seeded = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    operatorId = seeded.operatorId;
    const other = await t.db.account.create({ data: { displayName: 'Other' } });
    otherId = other.id;
    await t.db.address.create({ data: { localPart: 'matt', domainId: seeded.domainId, kind: 'primary', accountId: operatorId } });
    const team = await t.db.address.create({ data: { localPart: 'team', domainId: seeded.domainId, kind: 'alias' } });
    await t.db.addressTarget.createMany({ data: [{ addressId: team.id, accountId: operatorId }, { addressId: team.id, accountId: otherId }] });

    blobRoot = mkdtempSync(join(tmpdir(), 'smtp-in-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db: t.db, kek: generateKek() });
    const storage: InboundStorage = {
      db: t.db,
      blobs,
      dns,
      trustedArcSealers: ['google.com'],
      faults: {
        beforeCommit: () => (failCommit ? Promise.reject(new Error('injected failure before commit')) : Promise.resolve()),
      },
    };
    const accept = createAcceptMessage(storage);
    server = createSmtpInServer({
      db: t.db,
      hostname: 'mx.d3cloud.io',
      maxSize: MAX_MESSAGE_SIZE,
      edgePeers: ['10.77.0.1'],
      proxyTimeoutMs: 5_000,
      maxConnectionsPerIp: 50,
      maxRecipientsPerMessage: 100,
      maxRecipientsPerSession: 500,
      maxErrors: 10,
      idleTimeoutMs: 60_000,
      spfDns,
      dkimDns: dns,
      reverseLookup: () => Promise.resolve(null),
      greylist: () => Promise.resolve('pass'),
      acceptMessage: (ctx, body, verdicts) => accept(ctx, body, { ...verdicts, dnsbl }),
      log: () => undefined,
    });
    port = (await server.listen(0, '127.0.0.1')).port;
  }, 120_000);

  afterAll(async () => {
    await server.close();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    dnsbl = undefined;
    failCommit = false;
    txt = {
      'pass.example': ['v=spf1 ip4:127.0.0.1 -all'],
      '_dmarc.pass.example': ['v=DMARC1; p=reject'],
      'reject.example': ['v=spf1 -all'],
      '_dmarc.reject.example': ['v=DMARC1; p=reject'],
      'quar.example': ['v=spf1 -all'],
      '_dmarc.quar.example': ['v=DMARC1; p=quarantine'],
      'arc-20240605._domainkey.google.com': [dnsRecordFor('rsa-sha256', googleKey)],
    };
  });

  async function send(mailFrom: string, rcpts: string[], data: string): Promise<{ code: string; text: string }> {
    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO client.example')).code).toBe(250);
    expect((await c.cmd(`MAIL FROM:<${mailFrom}>`)).code).toBe(250);
    for (const r of rcpts) expect((await c.cmd(`RCPT TO:<${r}>`)).code).toBe(250);
    expect((await c.cmd('DATA')).code).toBe(354);
    c.write(`${data}.\r\n`);
    const r = await c.next();
    await c.quit();
    return { code: codeOf(r), text: r.lines.join(' ') };
  }

  function splitStored(stored: Buffer): { trace: string[]; rest: Buffer } {
    // The first two fields are ours; everything after them is the message exactly as received.
    const text = stored.toString('latin1');
    const fields: string[] = [];
    let pos = 0;
    for (let n = 0; n < 2; n++) {
      let end = text.indexOf('\r\n', pos);
      while (text[end + 2] === ' ' || text[end + 2] === '\t') end = text.indexOf('\r\n', end + 2);
      fields.push(text.slice(pos, end + 2));
      pos = end + 2;
    }
    return { trace: fields, rest: stored.subarray(pos) };
  }

  it('DMARC pass: 250 after commit; spooled row, job, audit; stored = Received + Authentication-Results + exact bytes', async () => {
    const data = message('alice@pass.example', 'Pass one', 'line one\r\n..leading dot\r\n');
    const r = await send('alice@pass.example', ['matt@d3cloud.io'], data);
    expect(r.code).toBe('250 2.0.0');
    const id = /Queued as ([0-9a-f-]{36})/.exec(r.text)?.[1] ?? '';
    const row = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: 'spooled', disposition: 'accept', envelopeFrom: 'alice@pass.example' });
    expect(row.smtpReply).toBe(`250 2.0.0 Queued as ${id}`);
    expect(row.recipients).toEqual([{ rcpt: 'matt@d3cloud.io', address: 'matt@d3cloud.io', accountIds: [operatorId], kind: 'mailbox' }]);
    const verdicts = row.verdicts as { spf: { result: string }; dmarc: { result: string; reasons: string[] }; arc: { result: string }; decision: { reasons: string[] } };
    expect(verdicts.spf.result).toBe('pass');
    expect(verdicts.dmarc.result).toBe('pass');
    expect(verdicts.arc.result).toBe('none');
    expect(verdicts.decision.reasons.length).toBeGreaterThan(0);

    const job = await t.db.job.findUniqueOrThrow({ where: { idempotencyKey: `inbound:${id}` } });
    expect(job).toMatchObject({ queue: 'inbound', status: 'pending', payload: { inboundMessageId: id } });
    expect(await t.db.auditEvent.count({ where: { action: 'inbound.accept', entityId: id } })).toBe(1);
    const session = await t.db.inboundSession.findUniqueOrThrow({ where: { id: row.sessionId ?? '' } });
    expect(session).toMatchObject({ clientIp: '127.0.0.1', helo: 'client.example', proxied: false });

    const stored = await blobs.getBuffer(row.blobSha256);
    const { trace, rest } = splitStored(stored);
    expect(trace[0]).toMatch(/^Received: from client\.example /);
    const ar = (trace[1] ?? '').replace(/\r\n[\t ]/g, ' ');
    expect(ar).toMatch(/^Authentication-Results: mx\.d3cloud\.io; spf=pass .*; dkim=none; dmarc=pass .*header\.from=pass\.example; arc=none\r\n$/);
    // Dot-unstuffed, byte for byte.
    expect(rest.toString('latin1')).toBe(data.replace('\r\n..leading', '\r\n.leading'));
    expect(await blobs.verify(row.blobSha256)).toBe(true);
    // Nothing filed yet: filing is the worker's (PST-T-2.7).
    expect(await t.db.message.count({ where: { inboundMessageId: id } })).toBe(0);
  });

  it('DMARC p=reject with SPF fail and no DKIM: 550 5.7.1, and a Rejects copy for every local recipient with its reasons', async () => {
    const data = message('alice@reject.example', 'Spoofed invoice');
    const r = await send('alice@reject.example', ['matt@d3cloud.io', 'team@d3cloud.io'], data);
    expect(r.code).toBe('550 5.7.1');
    expect(r.text).toContain('DMARC policy of reject.example (p=reject)');

    const row = await t.db.inboundMessage.findFirstOrThrow({ where: { envelopeFrom: 'alice@reject.example' }, orderBy: { receivedAt: 'desc' } });
    expect(row).toMatchObject({ state: 'rejected', disposition: 'reject' });
    expect(row.smtpReply).toMatch(/^550 5\.7\.1 /);
    expect(row.dispositionReason).toContain('dmarc=fail');
    const verdicts = row.verdicts as { rejects: { retentionDays: number; expiresAt: string } };
    expect(verdicts.rejects.retentionDays).toBe(14);
    expect(new Date(verdicts.rejects.expiresAt).getTime() - row.receivedAt.getTime()).toBe(14 * 86_400_000);
    // No job: nothing for the worker to file.
    expect(await t.db.job.count({ where: { idempotencyKey: `inbound:${row.id}` } })).toBe(0);

    // matt and team both resolve to the operator; team also to Other: one copy per account.
    const copies = await t.db.message.findMany({
      where: { inboundMessageId: row.id },
      include: { mailbox: true, verdict: true },
      orderBy: { receivedAt: 'asc' },
    });
    expect(copies.map((m) => m.mailbox.accountId).sort()).toEqual([operatorId, otherId].sort());
    for (const m of copies) {
      expect(m.mailbox.name).toBe('Rejects');
      expect(m.mailbox.specialUse).toBe('rejects');
      expect(m).toMatchObject({ blobSha256: row.blobSha256, subject: 'Spoofed invoice', fromAddress: 'alice@reject.example', messageIdHeader: 'Spoofedinvoice@example' });
      expect(m.verdict?.bucket).toBe('rejects');
      expect(m.verdict?.reasons.some((x) => x.includes('dmarc=fail'))).toBe(true);
      expect(m.verdict?.reasons.some((x) => x.startsWith('rejected with 550 5.7.1'))).toBe(true);
    }
    // One reference for the spool row and one per copy.
    expect((await blobs.stat(row.blobSha256))?.refcount).toBe(3);
    const stored = await blobs.getBuffer(row.blobSha256);
    expect(splitStored(stored).rest.toString('latin1')).toBe(data);
    expect(await t.db.auditEvent.count({ where: { action: 'inbound.reject', entityId: row.id } })).toBe(1);
  });

  it('the same DMARC reject arriving through a trusted ARC chain is accepted, with the override reason stored', async () => {
    const original = message('alice@reject.example', 'Via a list');
    const sealed = arcSeal(original, {
      key: googleKey,
      domain: 'google.com',
      selector: 'arc-20240605',
      authservId: 'mx.google.com',
      results: 'dkim=pass header.i=@reject.example; spf=pass smtp.mailfrom=reject.example; dmarc=pass (p=REJECT) header.from=reject.example',
    });
    const r = await send('alice@reject.example', ['matt@d3cloud.io'], sealed);
    expect(r.code).toBe('250 2.0.0');
    const id = /Queued as ([0-9a-f-]{36})/.exec(r.text)?.[1] ?? '';
    const row = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: 'spooled', disposition: 'accept' });
    const v = row.verdicts as { dmarc: { result: string }; arc: { result: string }; arcOverride: { overridden: boolean; reason: string } };
    expect(v.dmarc.result).toBe('fail');
    expect(v.arc.result).toBe('pass');
    expect(v.arcOverride.overridden).toBe(true);
    expect(v.arcOverride.reason).toMatch(/^DMARC fail overridden by ARC pass sealed by google\.com \(trusted\)/);
    expect(row.dispositionReason).toContain('overridden by ARC');
    const ar = splitStored(await blobs.getBuffer(row.blobSha256)).trace[1]?.replace(/\r\n[\t ]/g, ' ') ?? '';
    expect(ar).toMatch(/dmarc=fail .*; arc=pass \(i=1 oldest-pass=1 sealed by google\.com\)/);
  });

  it('p=quarantine is accepted with disposition quarantine', async () => {
    const r = await send('bob@quar.example', ['matt@d3cloud.io'], message('bob@quar.example', 'Quarantine me'));
    expect(r.code).toBe('250 2.0.0');
    const id = /Queued as ([0-9a-f-]{36})/.exec(r.text)?.[1] ?? '';
    const row = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: 'spooled', disposition: 'quarantine' });
    expect(await t.db.job.count({ where: { idempotencyKey: `inbound:${id}` } })).toBe(1);
  });

  it('a DNSBL-listed client is refused 554 5.7.1 and the message kept in Rejects', async () => {
    dnsbl = { listed: true, zone: 'zen.spamhaus.org', reason: 'XBL' };
    const r = await send('alice@pass.example', ['matt@d3cloud.io'], message('alice@pass.example', 'Listed sender'));
    expect(r.code).toBe('554 5.7.1');
    expect(r.text).toContain('zen.spamhaus.org');
    const copy = await t.db.message.findFirstOrThrow({ where: { subject: 'Listed sender' }, include: { mailbox: true, verdict: true, inbound: true } });
    expect(copy.mailbox.name).toBe('Rejects');
    expect(copy.inbound).toMatchObject({ state: 'rejected', disposition: 'reject' });
    expect(copy.verdict?.reasons[0]).toBe('client IP is listed on zen.spamhaus.org: XBL');
  });

  it('DMARC temperror is deferred 451 4.4.3 and nothing is stored', async () => {
    dns.txt = (name) => (name.startsWith('_dmarc.') ? Promise.reject(new Error('SERVFAIL')) : Promise.resolve(txt[name] ?? []));
    try {
      const before = await t.db.inboundMessage.count();
      const r = await send('alice@reject.example', ['matt@d3cloud.io'], message('alice@reject.example', 'Temperror'));
      expect(r.code).toBe('451 4.4.3');
      expect(await t.db.inboundMessage.count()).toBe(before);
    } finally {
      dns.txt = (name) => Promise.resolve(txt[name.toLowerCase().replace(/\.$/, '')] ?? []);
    }
  });

  it('a failure before commit answers 451 4.3.0 and leaves nothing half-written', async () => {
    failCommit = true;
    const counts = async () => ({
      inbound: await t.db.inboundMessage.count(),
      jobs: await t.db.job.count(),
      blobs: await t.db.blob.count(),
      messages: await t.db.message.count(),
      audit: await t.db.auditEvent.count({ where: { action: { startsWith: 'inbound.' } } }),
    });
    const before = await counts();
    const accepted = await send('alice@pass.example', ['matt@d3cloud.io'], message('alice@pass.example', 'Never stored'));
    expect(accepted.code).toBe('451 4.3.0');
    const rejected = await send('alice@reject.example', ['matt@d3cloud.io'], message('alice@reject.example', 'Never stored either'));
    expect(rejected.code).toBe('451 4.3.0');
    expect(await counts()).toEqual(before);
    // The orphan blob files are the blob store's to collect.
    expect((await blobs.gc({ olderThanMs: -1_000 })).orphans).toBeGreaterThanOrEqual(1);
  });
});
