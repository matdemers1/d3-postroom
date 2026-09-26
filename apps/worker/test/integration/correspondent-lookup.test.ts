// PST-T-5.8 doneWhen (PST-REQ-102): "Classifying a message for an account with 100k sent messages
// does one indexed lookup (EXPLAIN shows an index scan) and stays under 5 ms; the table is
// backfilled from existing Sent/OutboundRecipient rows idempotently."
import { AddressKind, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inReplyGraph } from '../../src/stages/classify.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('the correspondent table is one indexed lookup at scale (PST-T-5.8, PST-REQ-102)', () => {
  let t: TestDatabase;
  let db: Db;
  let accountId = '';
  const NEEDLE = 'needle@example.org';

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t58perf');
    db = t.db;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const account = await db.account.create({ data: { displayName: 'bulk' } });
    await db.address.create({ data: { localPart: 'bulk', domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    accountId = account.id;

    // 100k correspondent rows for the account, via generate_series (fast bulk insert), plus one
    // deliberately-placed needle so the lookup has something real to find.
    await db.$executeRaw`
      INSERT INTO correspondent (account_id, address, first_written_at, last_written_at, count)
      SELECT ${accountId}::uuid, 'person' || i || '@example.org', now() - interval '1 day', now(), 1
      FROM generate_series(1, 100000) AS i`;
    await db.correspondent.create({
      data: { accountId, address: NEEDLE, firstWrittenAt: new Date(Date.now() - 86_400_000), lastWrittenAt: new Date(), count: 1 },
    });
    await db.$executeRaw`ANALYZE correspondent`;
  }, 120_000);

  afterAll(async () => {
    await t.drop();
  });

  it('EXPLAIN shows an index (or index-only) scan for the (account_id, address) lookup', async () => {
    const plan = await db.$queryRaw<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (ANALYZE, FORMAT TEXT) SELECT 1 FROM correspondent WHERE account_id = ${accountId}::uuid AND address = ${NEEDLE}`;
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index( Only)? Scan/i);
    expect(text).not.toMatch(/Seq Scan/i);
  });

  it('inReplyGraph resolves in well under 5 ms (median of several runs) via one indexed lookup', async () => {
    const before = new Date();
    // Warm the connection/plan cache once, then measure.
    await inReplyGraph(db, { accountId, address: NEEDLE, before });
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      await inReplyGraph(db, { accountId, address: NEEDLE, before });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThan(5);
  });

  it('a stranger not in the correspondent table resolves false, still via the indexed lookup', async () => {
    const found = await inReplyGraph(db, { accountId, address: 'stranger@example.org', before: new Date() });
    expect(found).toBe(false);
  });

  it('bounded by firstWrittenAt: a replay before the account ever wrote to the address is not in its reply graph yet', async () => {
    const before = new Date(Date.now() - 2 * 86_400_000); // two days before the needle's firstWrittenAt
    const found = await inReplyGraph(db, { accountId, address: NEEDLE, before });
    expect(found).toBe(false);
  });
});

describe.skipIf(baseUrl === undefined)('the backfill from outbound_recipient/outbound_message is idempotent (PST-T-5.8)', () => {
  let t: TestDatabase;
  let db: Db;
  let accountId = '';

  const backfill = () => db.$executeRaw`
    INSERT INTO correspondent (account_id, address, first_written_at, last_written_at, count)
    SELECT m.account_id, lower(r.address), min(m.created_at), max(m.created_at), count(*)::int
    FROM outbound_recipient r
    JOIN outbound_message m ON m.id = r.outbound_message_id
    GROUP BY m.account_id, lower(r.address)
    ON CONFLICT (account_id, address) DO NOTHING`;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t58bf');
    db = t.db;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const account = await db.account.create({ data: { displayName: 'legacy' } });
    await db.address.create({ data: { localPart: 'legacy', domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    accountId = account.id;

    // Pre-existing OutboundRecipient rows (a sender that wrote to the same address 3 times, before
    // the correspondent table existed).
    for (let i = 0; i < 3; i++) {
      const m = await db.outboundMessage.create({
        data: {
          accountId,
          envelopeFrom: 'legacy@d3cloud.io',
          headerFrom: 'legacy@d3cloud.io',
          blobSha256: 'a'.repeat(64),
          size: 1,
          submittedVia: 'submission',
          createdAt: new Date(Date.now() - (3 - i) * 60_000),
        },
      });
      await db.outboundRecipient.create({ data: { outboundMessageId: m.id, address: 'ADDR@Example.ORG', domain: 'example.org' } });
    }
  }, 120_000);

  afterAll(async () => {
    await t.drop();
  });

  it('the first run creates one row aggregating every prior OutboundRecipient', async () => {
    await backfill();
    const row = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'addr@example.org' } } });
    expect(row).toMatchObject({ count: 3 });
  });

  it('running it again changes nothing (idempotent)', async () => {
    const before = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'addr@example.org' } } });
    await backfill();
    await backfill();
    const after = await db.correspondent.findUnique({ where: { accountId_address: { accountId, address: 'addr@example.org' } } });
    expect(after).toEqual(before);
    expect(await db.correspondent.count({ where: { accountId } })).toBe(1);
  });
});
