// Proves PST-T-0.5's doneWhen: a property test over mutating routes finds one audit row per call.
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import fc from 'fast-check';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { missingAuditCount, waitForAuditGuard } from '../../src/index.js';
import { buildApp } from './app.js';

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
          const requestId = randomUUID();
          if (op.kind === 'put') {
            const res = await request(app).put(`/settings/${op.key}`).set('x-request-id', requestId).send({ value: op.value });
            expect([200, 201]).toContain(res.status);
            expectations.push({ requestId, action: 'settings.upsert', key: op.key, before: shadow.get(op.key) ?? null, after: op.value });
            shadow.set(op.key, op.value);
          } else {
            const existed = shadow.has(op.key);
            const res = await request(app).delete(`/settings/${op.key}`).set('x-request-id', requestId);
            if (existed) {
              expect(res.status).toBe(204);
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
