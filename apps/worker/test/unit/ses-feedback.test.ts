// PST-T-11.17 / PST-REQ-176: the SES feedback poller against a fake SQS on loopback that checks every
// request's SigV4 signature. Signed SNS envelopes (a runtime self-signed certificate served by an
// injected fetcher — no network) go through the shared verifier; processing and audit are fakes
// here (the database effects are in test/integration/ses-feedback.test.ts). Covered: a verified
// notification is processed then deleted; a forged signature, a foreign topic, a non-JSON body and a
// SubscriptionConfirmation are refused, audited and deleted; a certificate that cannot be fetched
// and a processing (database) error leave the message on the queue with its visibility stretched; a
// poison message is audited, alerted once and deleted; SQS refusing the credentials alerts once
// and recovers; a 5xx backs off; stop() aborts the long poll in flight.
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditInput } from '@postroom/audit';
import { createAlertSender } from '@postroom/alerts';
import { CertCache, type SnsMessage } from '@postroom/delivery/ses-feedback';
import { TOPIC, makeKey, makeSnsSigner, notification } from '@postroom/delivery/ses-feedback/testing';
import {
  classifySqsError,
  createSqsClient,
  createSqsMessageHandler,
  defaultRetryVisibility,
  parseQueueUrl,
  sesFeedbackConfig,
  startSesFeedbackLoop,
  type SesFeedbackLoop,
} from '../../src/ses-feedback/index.js';
import { QUEUE_URL, REGION, startFakeSqs, type FakeSqs } from '../ses-feedback-fake-sqs.js';

const signer = makeSnsSigner();
const BOUNCE = JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@example.net', status: '5.1.1' }] }, mail: { messageId: 'x' } });

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('configuration', () => {
  it('is off unless the queue, both keys and a topic are set', () => {
    const full = { SES_FEEDBACK_SQS_URL: QUEUE_URL, SES_FEEDBACK_AWS_ACCESS_KEY_ID: 'AKIA', SES_FEEDBACK_AWS_SECRET_ACCESS_KEY: 's', SES_SNS_TOPIC_ARNS: TOPIC };
    expect(sesFeedbackConfig(full)).toMatchObject({ enabled: true, region: 'us-east-1', queueName: 'postroom-ses-feedback' });
    expect(sesFeedbackConfig({})).toEqual({ enabled: false, missing: ['SES_FEEDBACK_SQS_URL', 'SES_FEEDBACK_AWS_ACCESS_KEY_ID', 'SES_FEEDBACK_AWS_SECRET_ACCESS_KEY', 'SES_SNS_TOPIC_ARNS'] });
    expect(sesFeedbackConfig({ ...full, SES_FEEDBACK_AWS_SECRET_ACCESS_KEY: '' })).toMatchObject({ enabled: false, missing: ['SES_FEEDBACK_AWS_SECRET_ACCESS_KEY'] });
    // No topic: every message would be refused and deleted, so the poller does not start.
    expect(sesFeedbackConfig({ ...full, SES_SNS_TOPIC_ARNS: '' })).toMatchObject({ enabled: false, missing: ['SES_SNS_TOPIC_ARNS'] });
    expect(sesFeedbackConfig({ ...full, SES_FEEDBACK_SQS_URL: 'https://evil.example/123456789012/q' }).enabled).toBe(false);
  });

  it('takes the region from the queue host, and only from an amazonaws.com SQS host', () => {
    expect(parseQueueUrl('https://sqs.us-east-1.amazonaws.com/150056528345/postroom-ses-feedback')).toEqual({ region: 'us-east-1', account: '150056528345', name: 'postroom-ses-feedback' });
    expect(parseQueueUrl('https://sqs.eu-west-2.amazonaws.com/150056528345/q')?.region).toBe('eu-west-2');
    expect(parseQueueUrl('http://sqs.us-east-1.amazonaws.com/150056528345/q')).toBeNull();
    expect(parseQueueUrl('https://sqs.us-east-1.amazonaws.com.evil.example/150056528345/q')).toBeNull();
    expect(parseQueueUrl('https://queue.amazonaws.com/150056528345/q')).toBeNull();
  });

  it('stretches a retried message\'s visibility: 2, 4, 8, then 15 minutes', () => {
    expect([1, 2, 3, 4, 10].map(defaultRetryVisibility)).toEqual([120, 240, 480, 900, 900]);
  });
});

describe('SQS errors', () => {
  it('separates what waits out from what a person must fix', () => {
    expect(classifySqsError(400, 'ThrottlingException')).toBe('transient');
    expect(classifySqsError(503, 'ServiceUnavailable')).toBe('transient');
    expect(classifySqsError(500, 'Whatever')).toBe('transient');
    expect(classifySqsError(403, 'InvalidClientTokenId')).toBe('refused');
    expect(classifySqsError(400, 'AccessDenied')).toBe('refused');
    expect(classifySqsError(400, 'QueueDoesNotExist')).toBe('refused');
    expect(classifySqsError(400, 'InvalidParameterValue')).toBe('refused');
  });
});

describe('the SQS client', () => {
  let sqs: FakeSqs;
  afterEach(async () => {
    await sqs.close();
  });

  it('signs JSON-protocol calls with SigV4 for sqs and reads messages with their receive count', async () => {
    sqs = await startFakeSqs({ waitMs: 20 });
    const client = createSqsClient({ queueUrl: QUEUE_URL, region: REGION, endpoint: sqs.endpoint, credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: sqs.secretAccessKey } });
    const id = sqs.push('{"hello":1}', 2);
    const got = await client.receive();
    expect(got).toEqual([{ messageId: id, receiptHandle: `rh-${id}-3`, body: '{"hello":1}', receiveCount: 3 }]);
    await client.changeVisibility(got[0]?.receiptHandle ?? '', 240);
    await client.delete(got[0]?.receiptHandle ?? '');
    expect(sqs.deleted).toEqual([id]);
    expect(sqs.visibility).toEqual([{ id, seconds: 240 }]);
    expect(sqs.calls.map((c) => [c.target, c.status])).toEqual([
      ['AmazonSQS.ReceiveMessage', 200],
      ['AmazonSQS.ChangeMessageVisibility', 200],
      ['AmazonSQS.DeleteMessage', 200],
    ]);
  });

  it('a wrong secret is SignatureDoesNotMatch, classified refused', async () => {
    sqs = await startFakeSqs({ waitMs: 20 });
    const client = createSqsClient({ queueUrl: QUEUE_URL, region: REGION, endpoint: sqs.endpoint, credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: 'wrong' } });
    await expect(client.receive()).rejects.toMatchObject({ kind: 'refused', code: 'SignatureDoesNotMatch', status: 403 });
  });
});

describe.skipIf(signer === undefined)('the poller', () => {
  const s = signer as NonNullable<typeof signer>;
  let sqs: FakeSqs;
  let loop: SesFeedbackLoop | undefined;
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];

  afterEach(async () => {
    await loop?.stop();
    loop = undefined;
    await sqs.close();
    logs.length = 0;
  });

  interface Harness {
    audits: AuditInput[];
    processed: string[];
    relayed: string[];
    certCalls: string[];
  }

  /** A loop over the fake SQS with the real handler; processing and audit recorded in memory. */
  async function start(opts: { certFails?: boolean; processFails?: boolean; waitMs?: number; refusedRetryMs?: number } = {}): Promise<Harness> {
    sqs = await startFakeSqs({ waitMs: opts.waitMs ?? 30 });
    const h: Harness = { audits: [], processed: [], relayed: [], certCalls: [] };
    const fetcher = s.fetcher();
    const certFetch = opts.certFails === true ? (url: string): Promise<Response> => { h.certCalls.push(url); return Promise.reject(new Error('offline')); } : fetcher.fetch;
    // The real alert sender, over a fake relay: its hourly dedupe by key is part of "alert once".
    const sendAlert = createAlertSender({ url: 'https://relay.test/send', token: 't', to: 'ops@d3cloud.io', fetch: (_u, init) => { h.relayed.push((JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { subject?: string }).subject ?? ''); return Promise.resolve(new Response('{}', { status: 200 })); } });
    const log = (event: string, fields?: Record<string, unknown>): void => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); };
    const handle = createSqsMessageHandler({
      certs: new CertCache(certFetch),
      topics: new Set([TOPIC]),
      now: () => new Date(),
      log,
      sendAlert,
      audit: (e) => { h.audits.push(e); return Promise.resolve(); },
      process: (m: SnsMessage) => {
        if (opts.processFails === true) return Promise.reject(new Error('connection terminated'));
        h.processed.push(m.MessageId);
        return Promise.resolve();
      },
    });
    const client = createSqsClient({ queueUrl: QUEUE_URL, region: REGION, endpoint: sqs.endpoint, credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: sqs.secretAccessKey } });
    loop = startSesFeedbackLoop({ sqs: client, queue: 'postroom-ses-feedback', handle, log, sendAlert, backoffMinMs: 5, backoffMaxMs: 20, refusedRetryMs: opts.refusedRetryMs ?? 20 });
    return h;
  }

  it('processes a verified notification, then deletes it', async () => {
    const h = await start();
    const m = s.sign(notification(BOUNCE));
    const id = sqs.push(JSON.stringify(m));
    await until(() => sqs.deleted.includes(id));
    expect(h.processed).toEqual([m.MessageId]);
    expect(h.audits).toEqual([]);
    expect(loop?.status()).toMatchObject({ enabled: true, queue: 'postroom-ses-feedback', processed: 1, deleted: 1, lastError: null });
    expect(loop?.status().lastPollAt).not.toBeNull();
    // The body and the signature are never logged.
    expect(JSON.stringify(logs)).not.toContain(m.Signature);
    expect(JSON.stringify(logs)).not.toContain('a@example.net');
  });

  it('refuses a forged signature, a foreign topic, a non-JSON body and a SubscriptionConfirmation: audited and deleted, never processed', async () => {
    const h = await start();
    const other = makeKey();
    const forged = other === undefined ? { ...s.sign(notification(BOUNCE)), Message: '{}' } : s.sign(notification(BOUNCE), '2', other.key);
    const ids = [
      sqs.push(JSON.stringify(forged)),
      sqs.push(JSON.stringify({ ...s.sign(notification(BOUNCE, { TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker' })) })),
      sqs.push(BOUNCE.slice(0, 20)),
      sqs.push(JSON.stringify(s.sign({ Type: 'SubscriptionConfirmation', MessageId: 'sc-1', TopicArn: TOPIC, Message: 'x', Timestamp: new Date().toISOString(), Token: 't', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription' }))),
    ];
    await until(() => ids.every((id) => sqs.deleted.includes(id)));
    expect(h.processed).toEqual([]);
    expect(h.audits.map((a) => [a.action, (a.after as Record<string, unknown>)['code']])).toEqual([
      ['ses.feedback.refused', 'sns_signature_invalid'],
      ['ses.feedback.refused', 'sns_topic_refused'],
      ['ses.feedback.refused', 'invalid_sns_message'],
      ['ses.feedback.refused', 'sns_type_refused'],
    ]);
    expect(h.audits[0]?.context?.requestId).toBe(`sqs:${ids[0] ?? ''}`);
    expect(loop?.status().refused).toBe(4);
  });

  it('leaves a message whose certificate cannot be fetched on the queue, with its visibility stretched', async () => {
    const h = await start({ certFails: true });
    const id = sqs.push(JSON.stringify(s.sign(notification(BOUNCE))));
    await until(() => sqs.visibility.length > 0);
    expect(sqs.deleted).toEqual([]);
    expect(sqs.remaining()).toEqual([id]);
    expect(sqs.visibility).toEqual([{ id, seconds: 120 }]);
    expect(h.processed).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.certCalls.length).toBe(1);
    expect(logs.find((l) => l.event === 'ses-feedback-transient')?.fields).toMatchObject({ code: 'sns_cert_unavailable' });
  });

  it('leaves a message whose processing failed (a database error) for redelivery', async () => {
    await start({ processFails: true });
    const id = sqs.push(JSON.stringify(s.sign(notification(BOUNCE))));
    await until(() => sqs.visibility.length > 0);
    expect(sqs.deleted).toEqual([]);
    expect(sqs.remaining()).toEqual([id]);
    expect(loop?.status()).toMatchObject({ retried: 1, deleted: 0, lastError: { kind: 'process' } });
  });

  it('drops a poison message after ten receives: audited, alerted once, deleted', async () => {
    const h = await start({ processFails: true });
    const a = sqs.push(JSON.stringify(s.sign(notification(BOUNCE))), 10);
    const b = sqs.push(JSON.stringify(s.sign(notification(BOUNCE))), 12);
    await until(() => sqs.deleted.length === 2);
    expect(sqs.deleted.sort()).toEqual([a, b].sort());
    expect(h.audits.map((x) => x.action)).toEqual(['ses.feedback.poison', 'ses.feedback.poison']);
    expect(h.relayed).toEqual(['Postroom: an SES feedback message was dropped after repeated failures']);
    expect(loop?.status().poison).toBe(2);
  });

  it('alerts once when SQS refuses the credentials, keeps retrying, and recovers', async () => {
    const h = await start();
    sqs.failReceive(403, 'InvalidClientTokenId', 4);
    await until(() => sqs.calls.filter((c) => c.status === 403).length === 4 && sqs.calls.some((c) => c.status === 200));
    expect(h.relayed).toEqual(['Postroom: the SES feedback queue refuses the worker']);
    expect(logs.filter((l) => l.event === 'ses-feedback-sqs-refused')).toHaveLength(1);
    await until(() => logs.some((l) => l.event === 'ses-feedback-sqs-recovered'));
    expect(loop?.status().lastError).toMatchObject({ kind: 'refused', code: 'InvalidClientTokenId' });
    // Messages flow again afterwards.
    const id = sqs.push(JSON.stringify(s.sign(notification(BOUNCE))));
    await until(() => sqs.deleted.includes(id));
  });

  it('backs off on a 5xx without alerting', async () => {
    const h = await start();
    sqs.failReceive(500, 'InternalError', 2);
    await until(() => sqs.calls.filter((c) => c.status === 200).length > 0);
    expect(h.relayed).toEqual([]);
    expect(logs.filter((l) => l.event === 'ses-feedback-sqs-error')).toHaveLength(2);
  });

  it('stop() aborts the long poll in flight', async () => {
    await start({ waitMs: 60_000 });
    await until(() => sqs.pending() === 1);
    const t0 = Date.now();
    await loop?.stop();
    loop = undefined;
    expect(Date.now() - t0).toBeLessThan(2_000);
    await until(() => sqs.pending() === 0);
  });
});
