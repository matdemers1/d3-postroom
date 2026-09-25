import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createApp } from '../../src/app.js';

function fakeDb(rows: { migration_name: string }[] | Error): Db {
  return {
    $queryRaw: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)),
  } as unknown as Db;
}

const config = { webDist: undefined, webOrigin: 'http://localhost', revision: 'abc123' };

describe('api app', () => {
  it('reports revision and schema on /health', async () => {
    const app = createApp({ db: fakeDb([{ migration_name: '20260925220130_init' }]), env: {}, config });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', daemon: 'api', revision: 'abc123', schemaRevision: '20260925220130_init' });
  });

  it('answers 503 when the database is gone', async () => {
    const app = createApp({ db: fakeDb(new Error('connection refused')), env: {}, config });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'down' });
  });

  it('sends a strict CSP with no third-party origin', async () => {
    const app = createApp({ db: fakeDb([]), env: {}, config });
    const res = await request(app).get('/api/nothing');
    expect(res.status).toBe(404);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('refuses /api/admin without a session', async () => {
    const app = createApp({ db: fakeDb([]), env: {}, config });
    expect((await request(app).get('/api/admin/anything')).status).toBe(401);
  });
});
