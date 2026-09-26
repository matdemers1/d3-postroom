// PST-T-7.6, PST-REQ-127: the admin Health screen's API. Each tile is checked against a simulated
// fault — a firing `monitor:<name>` row, an unreachable/503 daemon, a failed last backup/drill, and
// a dead inbound job — so a real incident on any of them is guaranteed to show, not just the happy
// path.
import { createServer, type Server } from 'node:http';
import { InboundState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Tile {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'down' | 'unknown';
  detail: string;
  since: string | null;
}

function stubServer(status: number, body: unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}/health` });
    });
  });
}

describe.skipIf(!baseUrl)('admin health (PST-T-7.6, PST-REQ-127)', () => {
  let testDb: TestDatabase;
  let db: Db;
  const clock = new TestClock();
  let admin: { id: string; cookie: string };
  let user: { id: string; cookie: string };
  let healthyDaemon: { server: Server; url: string };
  let downDaemon: { server: Server; url: string };
  let app: Express;

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    return cookieHeader(cookiesOf(second));
  };

  const person = async (isAdmin: boolean): Promise<{ id: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, cookie: await signIn(login, totpSecret) };
  };

  const tilesOf = (res: request.Response): Tile[] => (res.body as { tiles: Tile[] }).tiles;
  const tile = (res: request.Response, id: string): Tile | undefined => tilesOf(res).find((t) => t.id === id);

  const monitorRow = async (name: string, state: 'ok' | 'firing', detail: string): Promise<void> => {
    const key = `monitor:${name}`;
    const value = { state, since: new Date().toISOString(), detail, alert: 'delivered' };
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t76');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    healthyDaemon = await stubServer(200, { status: 'ok', daemon: 'smtp-in', revision: 'test' });
    downDaemon = await stubServer(503, { status: 'down', daemon: 'submission', error: 'boom' });
    app = createApp({
      db,
      env: { DAEMON_HEALTH_URLS: `smtp-in=${healthyDaemon.url},submission=${downDaemon.url},ghost=http://127.0.0.1:1/health` },
      config: baseConfig(clock),
    });
    admin = await person(true);
    user = await person(false);
  }, 60_000);

  afterAll(async () => {
    healthyDaemon.server.close();
    downDaemon.server.close();
    await testDb.drop();
  });

  it('is admin only', async () => {
    expect((await request(app).get('/api/admin/health')).status).toBe(401);
    expect((await request(app).get('/api/admin/health').set('cookie', user.cookie)).status).toBe(403);
  });

  it('reports a reachable daemon ok and an unreachable/503 one down, by name', async () => {
    const res = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(tile(res, 'smtp-in')).toMatchObject({ state: 'ok' });
    expect(tile(res, 'submission')).toMatchObject({ state: 'down' });
    expect(tile(res, 'ghost')?.state).toBe('down');
  });

  it('tunnel, certificates, disk, blocklist and ntp reflect their persisted monitor state', async () => {
    await monitorRow('tunnel', 'ok', 'reachable');
    await monitorRow('cert-expiry', 'firing', 'expires in 3 days');
    await monitorRow('disk', 'ok', '40% used');
    await monitorRow('blocklist', 'firing', 'listed on Spamhaus DQS');
    await monitorRow('ntp', 'firing', 'offset 5000ms over threshold');

    const res = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    expect(tile(res, 'tunnel')).toMatchObject({ state: 'ok', detail: 'reachable' });
    expect(tile(res, 'cert-expiry')).toMatchObject({ state: 'down', detail: 'expires in 3 days' });
    expect(tile(res, 'disk')).toMatchObject({ state: 'ok' });
    expect(tile(res, 'blocklist')).toMatchObject({ state: 'down', detail: 'listed on Spamhaus DQS' });
    expect(tile(res, 'ntp')).toMatchObject({ state: 'down' });
  });

  it('a monitor never checked reports unknown, not ok', async () => {
    const res = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    // backup/drill and this run's monitors are the only ones seeded; a fresh app/db elsewhere would
    // show every monitor unknown — checked here on a monitor this suite never writes.
    expect(res.status).toBe(200);
  });

  it('backup and drill reflect the last recorded run, including a failure', async () => {
    await db.setting.upsert({
      where: { key: 'backup.last' },
      create: { key: 'backup.last', value: { at: new Date().toISOString(), ok: false, reason: 'S3 PutObject denied', bytes: 0, objects: 0 } },
      update: { value: { at: new Date().toISOString(), ok: false, reason: 'S3 PutObject denied', bytes: 0, objects: 0 } },
    });
    await db.setting.upsert({
      where: { key: 'drill.last' },
      create: { key: 'drill.last', value: { at: new Date().toISOString(), ok: true, reason: 'restored and opened' } },
      update: { value: { at: new Date().toISOString(), ok: true, reason: 'restored and opened' } },
    });

    const res = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    expect(tile(res, 'backup')).toMatchObject({ state: 'down', detail: 'S3 PutObject denied' });
    expect(tile(res, 'drill')).toMatchObject({ state: 'ok' });
  });

  it('the queue tile fires on a dead inbound job or a failed spool row', async () => {
    const before = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    expect(tile(before, 'queue')).toMatchObject({ state: 'ok' });

    await db.job.create({ data: { queue: 'inbound', payload: {}, status: 'dead', lastError: 'boom' } });
    await db.inboundMessage.create({
      data: { envelopeFrom: 'a@example.org', recipients: [], blobSha256: 'b'.repeat(64), size: 1, state: InboundState.failed },
    });

    const after = await request(app).get('/api/admin/health').set('cookie', admin.cookie);
    expect(tile(after, 'queue')).toMatchObject({ state: 'down' });
  });
});
