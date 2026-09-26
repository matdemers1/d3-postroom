// PST-T-6.3, PST-REQ-117, PST-REQ-118: the operator's transcript browser and live viewer — admin
// only, and the live stream actually receives what a daemon publishes over Postgres NOTIFY.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('admin SMTP transcripts and live view (PST-T-6.3)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let admin: { id: string; cookie: string };
  let user: { id: string; cookie: string };

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (isAdmin: boolean): Promise<{ id: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, cookie: await signIn(login, totpSecret) };
  };

  const makeTranscript = async (overrides: { daemon?: string; sessionId?: string } = {}): Promise<string> => {
    const text = '2026-09-26T00:00:00.000Z\tC: EHLO client.example\n2026-09-26T00:00:00.100Z\tS: 250 mx.d3cloud.io\n';
    const compressed = gzipSync(Buffer.from(text, 'utf8'));
    const row = await db.smtpTranscript.create({
      data: {
        daemon: overrides.daemon ?? 'smtp-in',
        sessionId: overrides.sessionId ?? randomUUID(),
        clientIp: '203.0.113.5',
        startedAt: new Date('2026-09-26T00:00:00.000Z'),
        endedAt: new Date('2026-09-26T00:00:01.000Z'),
        lineCount: 2,
        rawBytes: Buffer.byteLength(text),
        compressedBytes: compressed.length,
        compression: 'gzip',
        body: compressed,
      },
    });
    return row.id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t63_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: { DATABASE_URL: testDb.url }, config: baseConfig(clock) });
    admin = await person(true);
    user = await person(false);
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('is admin only: 401 without a session, 403 for a non-admin', async () => {
    expect((await request(app).get('/api/admin/smtp/transcripts')).status).toBe(401);
    expect((await request(app).get('/api/admin/smtp/transcripts').set('cookie', user.cookie)).status).toBe(403);
    const id = await makeTranscript();
    expect((await request(app).get(`/api/admin/smtp/transcripts/${id}`).set('cookie', user.cookie)).status).toBe(403);
  });

  it('lists transcripts newest first and never includes the compressed body', async () => {
    const olderId = await makeTranscript({ sessionId: randomUUID() });
    const newerId = await makeTranscript({ sessionId: randomUUID() });

    const res = await request(app).get('/api/admin/smtp/transcripts?limit=200').set('cookie', admin.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { transcripts: { id: string; body?: unknown }[] };
    const ids = body.transcripts.map((t) => t.id);
    expect(ids).toContain(olderId);
    expect(ids).toContain(newerId);
    expect(body.transcripts.every((t) => t.body === undefined)).toBe(true);
  });

  it('filters by daemon', async () => {
    const submissionId = await makeTranscript({ daemon: 'submission', sessionId: randomUUID() });
    const res = await request(app).get('/api/admin/smtp/transcripts?daemon=submission').set('cookie', admin.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { transcripts: { id: string; daemon: string }[] };
    expect(body.transcripts.every((t) => t.daemon === 'submission')).toBe(true);
    expect(body.transcripts.map((t) => t.id)).toContain(submissionId);
  });

  it('returns the decompressed lines for one transcript, and 404 for an unknown id', async () => {
    const id = await makeTranscript({ sessionId: randomUUID() });
    const res = await request(app).get(`/api/admin/smtp/transcripts/${id}`).set('cookie', admin.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { lines: { dir: string; line: string }[] };
    expect(body.lines).toEqual([
      { at: '2026-09-26T00:00:00.000Z', dir: 'C', line: 'EHLO client.example' },
      { at: '2026-09-26T00:00:00.100Z', dir: 'S', line: '250 mx.d3cloud.io' },
    ]);
    expect((await request(app).get(`/api/admin/smtp/transcripts/${randomUUID()}`).set('cookie', admin.cookie)).status).toBe(404);
  });

  describe('live view (server-sent events)', () => {
    let server: http.Server;
    let port = 0;

    beforeAll(async () => {
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    });

    it('is admin only', async () => {
      expect((await request(app).get('/api/admin/smtp/live')).status).toBe(401);
      expect((await request(app).get('/api/admin/smtp/live').set('cookie', user.cookie)).status).toBe(403);
    });

    it('streams a line published over NOTIFY', async () => {
      const events: { event: string; data: unknown }[] = [];
      const opened = await new Promise<{ res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/admin/smtp/live', headers: { cookie: admin.cookie, accept: 'text/event-stream' } },
          (res) => {
            resolve({ res, req });
          },
        );
        req.on('error', reject);
      });
      expect(opened.res.statusCode).toBe(200);
      expect(opened.res.headers['content-type']).toMatch(/^text\/event-stream/);
      let buf = '';
      opened.res.setEncoding('utf8');
      opened.res.on('data', (chunk: string) => {
        buf += chunk;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length > 0) events.push({ event, data: JSON.parse(data.join('\n')) as unknown });
        }
      });

      // Give the SSE handler time to subscribe (it awaits ensureListening()) before publishing.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const line = { daemon: 'smtp-in', sessionId: randomUUID(), dir: 'C', line: 'EHLO client.example', at: new Date().toISOString() };
      await db.$executeRaw`SELECT pg_notify('smtp_live', ${JSON.stringify(line)})`;

      const deadline = Date.now() + 5_000;
      while (!events.some((e) => e.event === 'line') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      opened.req.destroy();
      const received = events.find((e) => e.event === 'line');
      expect(received).toBeDefined();
      expect(received?.data).toEqual(line);
    });
  });
});
