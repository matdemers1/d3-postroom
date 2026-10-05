// PST-T-20.4, the D3 App contract's push: a device registers its relay and key with a native session
// and gets one postroom.registered notification — sealed as envelope v1 to its key, signed with the
// relay send key — and only it can open. The registration belongs to the session (revoking it forgets
// the registration), a 410 from the relay forgets it too, and only https relays are accepted outside a
// test configuration. The contract's reference vectors open with this implementation.
import { createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { kekFromBase64 } from '@postroom/crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { openEnvelope, pushToAccount, sealEnvelope, signRelayRequest } from '@postroom/push';
import { request } from '../loopback.js';
import { baseConfig, createAccount, KEK_BASE64, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const vectors = JSON.parse(readFileSync(new URL('../fixtures/envelope-v1.json', import.meta.url), 'utf8')) as {
  devicePrivateKeyD: string;
  cases: { payload: unknown; envelope: string }[];
};

describe('envelope v1', () => {
  it('opens the contract’s reference envelopes with its test key', () => {
    const device = createECDH('prime256v1');
    device.setPrivateKey(Buffer.from(vectors.devicePrivateKeyD, 'base64url'));
    for (const c of vectors.cases) {
      expect(JSON.parse(openEnvelope(device, c.envelope).toString('utf8'))).toEqual(c.payload);
    }
  });

  it('seals so only the device opens it, with a fresh ephemeral key every time', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const a = sealEnvelope(device.getPublicKey(), Buffer.from('{"v":1}'));
    const b = sealEnvelope(device.getPublicKey(), Buffer.from('{"v":1}'));
    expect(a).not.toBe(b);
    expect(openEnvelope(device, a).toString()).toBe('{"v":1}');
    const stranger = createECDH('prime256v1');
    stranger.generateKeys();
    expect(() => openEnvelope(stranger, a)).toThrow();
  });
});

interface Pushed {
  path: string;
  timestamp: string;
  signature: string;
  raw: string;
}

describe.skipIf(!baseUrl)('relay registration (PST-T-20.4)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let relay: Server;
  let relayUrl = '';
  let relayAnswer = 202;
  const pushes: Pushed[] = [];
  const clock = new TestClock();
  let account: { id: string; totpSecret: string };
  let login = '';

  const signIn = async (): Promise<{ accessToken: string; session: { id: string } }> => {
    const first = await request(app).post('/api/auth/native/signin').send({ email: login, password: 'correct horse battery staple' });
    clock.advance(31_000);
    const second = await request(app).post('/api/auth/native/signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: totpCode(account.totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    return second.body as { accessToken: string; session: { id: string } };
  };
  const device = () => {
    const pair = createECDH('prime256v1');
    pair.generateKeys();
    return pair;
  };
  const register = (token: string, pub: Buffer, registration: string, url = relayUrl, categories: string[] = ['postroom.priority']) =>
    request(app)
      .post('/api/push/native/register')
      .set({ authorization: `Bearer ${token}` })
      .send({ devicePublicKey: pub.toString('base64'), relay: { url, registration, sendKey: `send-key-${registration}-0123456789` }, categories });
  const waitForPush = async (n: number): Promise<Pushed> => {
    for (let i = 0; i < 80 && pushes.length < n; i++) await new Promise((r) => setTimeout(r, 25));
    const p = pushes[n - 1];
    if (p === undefined) throw new Error('no push reached the relay');
    return p;
  };

  beforeAll(async () => {
    relay = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        pushes.push({ path: req.url ?? '', timestamp: String(req.headers['x-d3-relay-timestamp']), signature: String(req.headers['x-d3-relay-signature']), raw });
        res.writeHead(relayAnswer, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => { resolve(); }));
    relayUrl = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`;

    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t204');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    login = 'phone';
    account = await createAccount(db, { login, password: 'correct horse battery staple' });
    app = createApp({ db, env: {}, config: baseConfig(clock, { relayAllowLoopbackHttp: true }) });
  }, 60_000);

  afterAll(async () => {
    relay.close();
    await testDb.drop();
  });

  it('the manifest names the endpoint', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    expect((res.body as { endpoints: Record<string, string> }).endpoints['relayRegister']).toMatch(/\/api\/push\/native\/register$/);
  });

  it('registers, then sends one postroom.registered notification only this device can open', async () => {
    const tokens = await signIn();
    const key = device();
    const res = await register(tokens.accessToken, key.getPublicKey(), 'reg-1');
    expect(res.status).toBe(204);

    const pushed = await waitForPush(1);
    expect(pushed.path).toBe('/v1/push/reg-1');
    expect(Math.abs(Date.now() / 1000 - Number(pushed.timestamp))).toBeLessThan(300);
    expect(pushed.signature).toBe(signRelayRequest('send-key-reg-1-0123456789', pushed.timestamp, pushed.raw));
    const payload = JSON.parse(openEnvelope(key, (JSON.parse(pushed.raw) as { ciphertext: string }).ciphertext).toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 1, category: 'postroom.registered', title: 'Notifications are on' });

    const row = await db.relayRegistration.findFirstOrThrow({ where: { registration: 'reg-1' } });
    expect(row.sessionId).toBe(tokens.session.id);
    // The send key is sealed at rest, never stored as given.
    expect(Buffer.from(row.sendKeySealed).toString('utf8')).not.toContain('send-key-reg-1');
  });

  it('refuses a registration without a relay, a bad key, a plain-http relay off loopback, or the browser’s cookie', async () => {
    const tokens = await signIn();
    const key = device();
    const noRelay = await request(app).post('/api/push/native/register').set({ authorization: `Bearer ${tokens.accessToken}` }).send({ devicePublicKey: key.getPublicKey().toString('base64'), apnsToken: 'ab'.repeat(32) });
    expect(noRelay.status).toBe(400);
    expect((await register(tokens.accessToken, Buffer.alloc(65, 4), 'bad-key')).status).toBe(400);
    expect((await register(tokens.accessToken, key.getPublicKey(), 'plain', 'http://relay.example.com')).status).toBe(400);
    expect((await request(app).post('/api/push/native/register').set({ 'x-postroom-csrf': '1' }).send({})).status).toBe(401);
  });

  it('only https relays outside a test configuration', async () => {
    const strict = createApp({ db, env: {}, config: baseConfig(clock) });
    const tokens = await signIn();
    const key = device();
    const res = await request(strict)
      .post('/api/push/native/register')
      .set({ authorization: `Bearer ${tokens.accessToken}` })
      .send({ devicePublicKey: key.getPublicKey().toString('base64'), relay: { url: relayUrl, registration: 'strict', sendKey: 'send-key-strict-0123456789' }, categories: [] });
    expect(res.status).toBe(400);
    // An unreachable https relay is accepted: the notification fails later, quietly.
    const unreachable = await register(tokens.accessToken, key.getPublicKey(), 'unreachable', 'https://relay.invalid');
    expect(unreachable.status).toBe(204);
  });

  it('registering again replaces; revoking the session forgets the registration', async () => {
    const tokens = await signIn();
    const key = device();
    expect((await register(tokens.accessToken, key.getPublicKey(), 'reg-a')).status).toBe(204);
    expect((await register(tokens.accessToken, key.getPublicKey(), 'reg-b')).status).toBe(204);
    expect(await db.relayRegistration.count({ where: { sessionId: tokens.session.id } })).toBe(1);
    expect((await request(app).post('/api/auth/native/revoke').set({ authorization: `Bearer ${tokens.accessToken}` })).status).toBe(204);
    expect(await db.relayRegistration.count({ where: { registration: { in: ['reg-a', 'reg-b'] } } })).toBe(0);
  });

  it('sends only the categories a device asked for, and forgets a registration the relay answers 410', async () => {
    const tokens = await signIn();
    const key = device();
    await register(tokens.accessToken, key.getPublicKey(), 'reg-gone', relayUrl, ['postroom.priority']);
    await waitForPush(pushes.length + 1);
    const kek = kekFromBase64(KEK_BASE64);
    const before = pushes.length;
    await pushToAccount(db, kek, account.id, { v: 1, category: 'postroom.other', title: 'x', sentAt: new Date().toISOString() });
    expect(pushes.length).toBe(before);

    relayAnswer = 410;
    try {
      const results = await pushToAccount(db, kek, account.id, { v: 1, category: 'postroom.priority', title: 'Sarah', body: 'Re: copy', sentAt: new Date().toISOString() });
      expect(results).toContain('gone');
      expect(await db.relayRegistration.count({ where: { registration: 'reg-gone' } })).toBe(0);
    } finally {
      relayAnswer = 202;
    }
  });
});
