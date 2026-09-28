// PST-T-11.15 / PST-REQ-176: POST /api/ses/sns through the real app against a real database. It is
// reachable without a session or CSRF header; only signed messages from a listed topic are read; a
// SubscriptionConfirmation is confirmed by fetching its SubscribeURL; a Permanent 5.1.1 bounce marks
// the delivered recipient bounced (correlated by the SES message id SES answered DATA with) and
// suppresses the address; a Transient one only records; a complaint is recorded and alerts once;
// and forged signatures, unlisted topics, foreign certificate hosts and malformed bodies are refused
// before anything is written. The certificate is served by an injected fetcher: no network.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertMessage } from '@postroom/alerts';
import { RecipientState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { SnsMessage } from '../../src/ses/sns.js';
import { request } from '../loopback.js';
import { CERT_URL, SUBSCRIBE_URL, TOPIC, makeKey, makeSnsSigner, notification } from '../sns-signer.js';
import { TestClock, baseConfig } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const signer = makeSnsSigner();
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'ses');

describe.skipIf(!baseUrl || signer === undefined)('POST /api/ses/sns (PST-T-11.15)', () => {
  const s = signer as NonNullable<typeof signer>;
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let accountId = '';
  const clock = new TestClock();
  const alerts: AlertMessage[] = [];
  const fetcher = s.fetcher();

  /** An SES event fixture with its placeholders filled in. */
  const event = (name: string, ids: { ses: string; mid?: string }): string =>
    readFileSync(join(fixtures, name), 'utf8').replaceAll('__SES_MESSAGE_ID__', ids.ses).replaceAll('__MESSAGE_ID__', ids.mid ?? 'none@example');

  const post = (body: unknown, type = 'Notification') =>
    request(app)
      .post('/api/ses/sns')
      .set('content-type', 'text/plain; charset=UTF-8')
      .set('x-amz-sns-message-type', type)
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  /** Mail SES accepted: a delivered recipient whose attempt kept SES's `250 Ok <id>`. */
  async function sentViaSes(address: string): Promise<{ recipientId: string; ses: string; mid: string; id: string }> {
    const ses = `0100019a${randomUUID().replaceAll('-', '').slice(0, 24)}-${randomUUID()}-000000`;
    const mid = `${randomUUID()}@d3cloud.io`;
    const m = await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: 'matt@d3cloud.io',
        headerFrom: 'matt@d3cloud.io',
        messageId: `<${mid}>`,
        blobSha256: 'c'.repeat(64),
        size: 10,
        submittedVia: 'test',
        recipients: { create: [{ address, domain: address.split('@')[1] ?? '', state: RecipientState.delivered, deliveredAt: clock.now(), transport: 'ses' }] },
      },
      include: { recipients: true },
    });
    const recipientId = m.recipients[0]?.id ?? '';
    await db.deliveryAttempt.create({ data: { recipientId, transport: 'ses', outcome: 'delivered', remoteCode: 250, remoteText: `Ok ${ses}`, finishedAt: clock.now() } });
    return { recipientId, ses, mid, id: m.id };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1115_api');
    db = testDb.db;
    accountId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    app = createApp({
      db,
      env: { SES_SNS_TOPIC_ARNS: `arn:aws:sns:us-east-1:123456789012:unrelated, ${TOPIC}`, SES_SNS_REGION: 'us-east-1' },
      config: baseConfig(clock, { webOrigin: 'https://mail.d3cloud.io' }),
      sesSns: {
        fetch: fetcher.fetch,
        sendAlert: (m) => {
          alerts.push(m);
          return Promise.resolve({ sent: true });
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('confirms a SubscriptionConfirmation by fetching its SubscribeURL, audited (no session, no CSRF header)', async () => {
    const m = s.sign({ Type: 'SubscriptionConfirmation', MessageId: randomUUID(), TopicArn: TOPIC, Message: 'You have chosen to subscribe…', Timestamp: '2026-09-27T12:00:00.000Z', Token: 'abc', SubscribeURL: SUBSCRIBE_URL }, '1');
    const res = await post(m, 'SubscriptionConfirmation');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, confirmed: true });
    expect(fetcher.urls).toContain(SUBSCRIBE_URL);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await db.auditEvent.count({ where: { action: 'ses.sns.subscription-confirmed', requestId: String(res.headers['x-request-id']) } })).toBe(1);
  });

  it('refuses a SubscribeURL that is not SNS, fetching nothing', async () => {
    const before = fetcher.urls.length;
    const m = s.sign({ Type: 'SubscriptionConfirmation', MessageId: randomUUID(), TopicArn: TOPIC, Message: 'x', Timestamp: 't', Token: 'abc', SubscribeURL: 'https://attacker.example/confirm' });
    const res = await post(m, 'SubscriptionConfirmation');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'sns_subscribe_url_refused' });
    expect(fetcher.urls.slice(before)).toEqual([]);
  });

  it('a Permanent 5.1.1 bounce marks the delivered recipient bounced and suppresses the address — once', async () => {
    const out = await sentViaSes('nobody@example.net');
    const m = s.sign(notification(event('bounce-permanent.json', { ses: out.ses, mid: 'rewritten-by-ses@example' })));
    const res = await post(m);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: 'bounce', results: [{ address: 'nobody@example.net', action: 'bounced-suppressed', duplicate: false }] });

    const r = await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId }, include: { attemptsLog: { orderBy: { startedAt: 'asc' } } } });
    expect(r).toMatchObject({ state: 'bounced', lastCode: 550, lastEnhanced: '5.1.1', lastText: '[SES bounce notification] 550 5.1.1 user unknown' });
    expect(r.attemptsLog.map((a) => [a.transport, a.outcome])).toEqual([
      ['ses', 'delivered'],
      ['ses-notification', 'bounced'],
    ]);
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'nobody@example.net' } })).toMatchObject({ reason: 'hard-bounce', code: 550, enhanced: '5.1.1', sourceRecipientId: out.recipientId });
    const row = await db.deliveryFeedback.findFirstOrThrow({ where: { outboundRecipientId: out.recipientId } });
    expect(row).toMatchObject({ source: 'ses', kind: 'bounce', feedbackType: 'Permanent/General', action: 'bounced-suppressed' });

    // SNS redelivers the same message: nothing more happens.
    const again = await post(m);
    expect(again.body).toMatchObject({ results: [{ duplicate: true }] });
    expect((await db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nobody@example.net' } })).bounceCount).toBe(1);
  });

  it('correlates by the Message-ID header too, when SES left it alone', async () => {
    const out = await sentViaSes('gone@example.net');
    const payload = event('bounce-permanent.json', { ses: 'no-such-ses-id-0000000000', mid: out.mid }).replaceAll('nobody@example.net', 'gone@example.net');
    const res = await post(s.sign(notification(payload)));
    expect(res.body).toMatchObject({ results: [{ action: 'bounced-suppressed' }] });
    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).state).toBe('bounced');
  });

  it('a Transient bounce is recorded only', async () => {
    const out = await sentViaSes('full@example.net');
    const res = await post(s.sign(notification(event('bounce-transient.json', { ses: out.ses }))));
    expect(res.body).toMatchObject({ kind: 'bounce', results: [{ address: 'full@example.net', action: 'recorded' }] });
    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).state).toBe('delivered');
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'full@example.net' } })).toBeNull();
  });

  it('a complaint is recorded against its message and alerts once', async () => {
    const out = await sentViaSes('user@example.com');
    const before = alerts.length;
    const m = s.sign(notification(event('complaint.json', { ses: out.ses })));
    const res = await post(m);
    expect(res.body).toMatchObject({ kind: 'complaint', alerted: true });
    const row = await db.deliveryFeedback.findFirstOrThrow({ where: { kind: 'complaint', outboundRecipientId: out.recipientId } });
    expect(row).toMatchObject({ source: 'ses', feedbackType: 'abuse', outboundMessageId: out.id });
    expect(row.alertedAt).not.toBeNull();
    expect(alerts.slice(before)).toEqual([expect.objectContaining({ key: `complaint:${row.id}` })]);
    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).state).toBe('delivered');

    await post(m);
    expect(alerts.length).toBe(before + 1);
  });

  it('other SES events are acknowledged and ignored', async () => {
    const res = await post(s.sign(notification(event('delivery.json', { ses: 'x' }))));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'ignored', notificationType: 'Delivery' });
  });

  it('refuses a forged signature, an unlisted topic, a foreign certificate host and bad bodies — writing nothing', async () => {
    const out = await sentViaSes('target@example.net');
    const payload = event('bounce-permanent.json', { ses: out.ses }).replaceAll('nobody@example.net', 'target@example.net');
    const good = s.sign(notification(payload));

    const tampered: SnsMessage = { ...good, Message: good.Message.replace('Permanent', 'Permanent ') };
    expect((await post(tampered)).status).toBe(403);

    const other = makeKey();
    if (other !== undefined) {
      const res = await post(s.sign(notification(payload), '2', other.key));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'sns_signature_invalid' });
    }

    const before = fetcher.urls.length;
    const wrongTopic = await post(s.sign(notification(payload, { TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker' })));
    expect(wrongTopic.status).toBe(403);
    expect(wrongTopic.body).toEqual({ error: 'sns_topic_refused' });
    const wrongHost = await post(s.sign({ ...notification(payload), SigningCertURL: 'https://sns.us-east-1.amazonaws.com.attacker.example/c.pem' }));
    expect(wrongHost.body).toEqual({ error: 'sns_cert_url_refused' });
    const wrongRegion = await post(s.sign({ ...notification(payload), SigningCertURL: CERT_URL.replace('us-east-1', 'eu-west-1') }));
    expect(wrongRegion.body).toEqual({ error: 'sns_cert_url_refused' });
    expect(fetcher.urls.slice(before)).toEqual([]);

    expect((await post('{not json')).status).toBe(400);
    expect((await post({ Type: 'Notification' })).status).toBe(400);
    expect((await post(good, 'SubscriptionConfirmation')).status).toBe(400);
    const big = await post(JSON.stringify({ ...good, Message: 'x'.repeat(300 * 1024) }));
    expect(big.status).toBe(413);

    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).state).toBe('delivered');
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'target@example.net' } })).toBeNull();
    expect(await db.deliveryFeedback.count({ where: { address: 'target@example.net' } })).toBe(0);
  });

  it('refuses everything when no topic is configured', async () => {
    const closed = createApp({ db, env: {}, config: baseConfig(clock), sesSns: { fetch: fetcher.fetch } });
    const res = await request(closed).post('/api/ses/sns').set('content-type', 'text/plain').send(JSON.stringify(s.sign(notification('{}'))));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'sns_topic_refused' });
  });
});
