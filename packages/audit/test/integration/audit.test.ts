// Proves PST-T-0.5's doneWhen: a property test over mutating routes finds one audit row per call.
import type { Express } from 'express';
import fc from 'fast-check';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { missingAuditCount, waitForAuditGuard } from '../../src/index.js';
import { buildApp } from './app.js';

/** The guard correlates by the server-generated `x-request-id` response header, never a request one. */
function serverRequestId(res: request.Response): string {
  const id = res.headers['x-request-id'];
  if (!id) throw new Error('response carried no x-request-id header');
  return id;
}

const baseUrl = process.env['DATABASE_URL'];
const KEYS = ['alpha', 'beta', 'gamma'] as const;

describe.skipIf(!baseUrl)('mutation audit guard + audited() (PST-T-0.5)', () => {
  let testDb: TestDatabase;
  let app: Express;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t05');
    app = buildApp(testDb.db);
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('a route that throws after the write persists nothing and writes no audit row', async () => {
    const before = missingAuditCount.value;
    const res = await request(app).post('/settings/boom-key/boom').send({ value: 'x' });
    expect(res.status).toBe(500);

    const row = await testDb.db.setting.findUnique({ where: { key: 'boom-key' } });
    expect(row).toBeNull();

    const audits = await testDb.db.auditEvent.count({ where: { entityId: 'boom-key' } });
    expect(audits).toBe(0);

    await waitForAuditGuard();
    // Status 500 is excluded from the guard's check (it only watches successful mutations).
    expect(missingAuditCount.value).toBe(before);
  });

  it('a 400 validation failure never touches the database and writes no audit row', async () => {
    const before = await testDb.db.auditEvent.count();
    const res = await request(app).post('/settings-validate').send({});
    expect(res.status).toBe(400);
    const after = await testDb.db.auditEvent.count();
    expect(after).toBe(before);
  });

  it('a GET writes no audit row', async () => {
    const before = await testDb.db.auditEvent.count();
    const res = await request(app).get('/settings/does-not-exist');
    expect(res.status).toBe(404);
    const after = await testDb.db.auditEvent.count();
    expect(after).toBe(before);
  });

  it('a route that mutates without audited() trips the guard', async () => {
    const before = missingAuditCount.value;
    const res = await request(app).post('/settings/unsafe-key/unsafe').send({ value: 1 });
    expect(res.status).toBe(200);
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(before + 1);
  });

  it('a client cannot spoof the guard by replaying an earlier legitimate x-request-id', async () => {
    // First, a genuinely audited mutation — server assigns its own requestId regardless of what
    // (if anything) the client sends.
    const legit = await request(app).put('/settings/replay-key').send({ value: 'legit' });
    expect([200, 201]).toContain(legit.status);
    const legitRequestId = serverRequestId(legit);
    await waitForAuditGuard();
    const legitAudits = await testDb.db.auditEvent.count({ where: { requestId: legitRequestId } });
    expect(legitAudits).toBe(1);

    // Now an attacker calls the unsafe (unaudited) route, replaying that earlier id as its own
    // x-request-id header. If the guard trusted the client header, it would find the legit row
    // under the replayed id and stay silent about this request's own unaudited mutation.
    const before = missingAuditCount.value;
    const spoof = await request(app)
      .post('/settings/replay-attack-key/unsafe')
      .set('x-request-id', legitRequestId)
      .send({ value: 'attacker' });
    expect(spoof.status).toBe(200);
    // The server must have minted its own, different id for this request.
    expect(serverRequestId(spoof)).not.toBe(legitRequestId);

    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(before + 1);
  });

  it('property: random sequences of successful mutating calls each produce exactly one attributed audit row', async () => {
    const valueArb = fc.oneof(fc.string(), fc.integer(), fc.boolean());
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant<'put'>('put'), key: fc.constantFrom(...KEYS), value: valueArb }),
      fc.record({ kind: fc.constant<'delete'>('delete'), key: fc.constantFrom(...KEYS) }),
    );
    const seqArb = fc.array(opArb, { minLength: 1, maxLength: 15 });

    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        // Each run starts from a clean slate for these three keys, so the local shadow model of
        // "what's in the database" matches reality without resetting audit_event (append-only).
        await testDb.db.setting.deleteMany({ where: { key: { in: [...KEYS] } } });
        const guardBefore = missingAuditCount.value;

        const expectations: { requestId: string; action: string; key: string; before: unknown; after: unknown }[] = [];
        const shadow = new Map<string, unknown>();

        for (const op of ops) {
          if (op.kind === 'put') {
            const res = await request(app).put(`/settings/${op.key}`).send({ value: op.value });
            expect([200, 201]).toContain(res.status);
            const requestId = serverRequestId(res);
            expectations.push({ requestId, action: 'settings.upsert', key: op.key, before: shadow.get(op.key) ?? null, after: op.value });
            shadow.set(op.key, op.value);
          } else {
            const existed = shadow.has(op.key);
            const res = await request(app).delete(`/settings/${op.key}`);
            if (existed) {
              expect(res.status).toBe(204);
              const requestId = serverRequestId(res);
              expectations.push({ requestId, action: 'settings.delete', key: op.key, before: shadow.get(op.key), after: null });
              shadow.delete(op.key);
            } else {
              expect(res.status).toBe(404);
            }
          }
        }

        await waitForAuditGuard();
        expect(missingAuditCount.value).toBe(guardBefore);

        const requestIds = expectations.map((e) => e.requestId);
        const rows = await testDb.db.auditEvent.findMany({ where: { requestId: { in: requestIds } } });
        // The doneWhen property: one audit row per successful mutating call.
        expect(rows).toHaveLength(expectations.length);

        const byRequestId = new Map(rows.map((r) => [r.requestId, r]));
        for (const exp of expectations) {
          const row = byRequestId.get(exp.requestId);
          expect(row).toBeDefined();
          expect(row?.action).toBe(exp.action);
          expect(row?.entityType).toBe('setting');
          expect(row?.entityId).toBe(exp.key);
          expect(row?.before).toEqual(exp.before);
          expect(row?.after).toEqual(exp.after);
        }
      }),
      { numRuns: 12 },
    );
  }, 90_000);
});
