// PST-T-11.17 / PST-REQ-176: the SES feedback poller, wired as the worker wires it, against a real
// database and a fake SQS on loopback (SigV4 checked). A Permanent 5.1.1 bounce arriving as a
// signed SNS envelope in an SQS message marks the delivered recipient bounced, puts the address on
// the suppression list with the remote's reply, and is deleted from the queue after the commit; the
// same SNS MessageId delivered again does nothing more; a complaint is recorded and alerts, within
// the hourly cap; a forged signature is audited as ses.feedback.refused and deleted with nothing
// else written; a certificate that cannot be fetched leaves the message on the queue.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AlertMessage } from '@postroom/alerts';
import { RecipientState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { COMPLAINT_ALERTS_PER_HOUR } from '@postroom/delivery';
import { TOPIC, makeKey, makeSnsSigner, notification } from '@postroom/delivery/ses-feedback/testing';
import { startSesFeedback } from '../../src/ses-feedback/index.js';
import { QUEUE_URL, startFakeSqs, type FakeSqs } from '../ses-feedback-fake-sqs.js';

const baseUrl = process.env['DATABASE_URL'];
const signer = makeSnsSigner();

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const bounce = (ses: string, address: string): string =>
  JSON.stringify({
    eventType: 'Bounce',
    bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: address, action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }], timestamp: new Date().toISOString(), feedbackId: 'fb-1' },
    mail: { messageId: ses, headers: [], commonHeaders: { messageId: ses } },
  });

const complaint = (ses: string, address: string): string =>
  JSON.stringify({
    eventType: 'Complaint',
    complaint: { complainedRecipients: [{ emailAddress: address }], timestamp: new Date().toISOString(), feedbackId: 'fb-c', complaintFeedbackType: 'abuse' },
    mail: { messageId: ses, commonHeaders: { messageId: ses } },
  });

describe.skipIf(baseUrl === undefined || signer === undefined)('SES feedback through SQS (PST-T-11.17)', () => {
  const s = signer as NonNullable<typeof signer>;
  let t: TestDatabase;
  let db: Db;
  let accountId = '';
  let sqs: FakeSqs;
  let poller: { stop: () => Promise<void> } | undefined;
  const alerts: AlertMessage[] = [];
  const logs: string[] = [];

  function start(certFetch = s.fetcher().fetch): void {
    poller = startSesFeedback({
      env: { SES_FEEDBACK_SQS_URL: QUEUE_URL, SES_FEEDBACK_AWS_ACCESS_KEY_ID: sqs.accessKeyId, SES_FEEDBACK_AWS_SECRET_ACCESS_KEY: sqs.secretAccessKey, SES_SNS_TOPIC_ARNS: TOPIC },
      db,
      log: (event) => { logs.push(event); },
      sendAlert: (m) => {
        alerts.push(m);
        return Promise.resolve({ sent: true });
      },
      certFetch,
      endpoint: sqs.endpoint,
    });
  }

  /** Mail SES accepted: a delivered recipient whose attempt kept SES's `250 Ok <id>`. */
  async function sentViaSes(address: string): Promise<{ recipientId: string; ses: string; id: string }> {
    const ses = `0100019a${randomUUID().replaceAll('-', '').slice(0, 24)}-${randomUUID()}-000000`;
    const m = await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: 'matt@d3cloud.io',
        headerFrom: 'matt@d3cloud.io',
        messageId: `<${randomUUID()}@d3cloud.io>`,
        blobSha256: 'c'.repeat(64),
        size: 10,
        submittedVia: 'test',
        recipients: { create: [{ address, domain: address.split('@')[1] ?? '', state: RecipientState.delivered, deliveredAt: new Date(), transport: 'ses' }] },
      },
      include: { recipients: true },
    });
    const recipientId = m.recipients[0]?.id ?? '';
    await db.deliveryAttempt.create({ data: { recipientId, transport: 'ses', outcome: 'delivered', remoteCode: 250, remoteText: `Ok ${ses}`, finishedAt: new Date() } });
    return { recipientId, ses, id: m.id };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1117_sqs');
    db = t.db;
    accountId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
  }, 120_000);

  afterEach(async () => {
    await poller?.stop();
    poller = undefined;
    await sqs.close();
  });

  afterAll(async () => {
    await t.drop();
  });

  it('a Permanent 5.1.1 bounce: recipient bounced, address suppressed with the reply, message deleted after commit — once', async () => {
    sqs = await startFakeSqs({ waitMs: 50 });
    start();
    const out = await sentViaSes('nobody@example.net');
    const envelope = JSON.stringify(s.sign(notification(bounce(out.ses, 'nobody@example.net'))));
    const first = sqs.push(envelope);
    await until(() => sqs.deleted.includes(first));

    expect(await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).toMatchObject({ state: 'bounced', lastEnhanced: '5.1.1', lastText: '[SES bounce notification] 550 5.1.1 user unknown' });
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'nobody@example.net' } })).toMatchObject({ reason: 'hard-bounce', code: 550, enhanced: '5.1.1', sourceRecipientId: out.recipientId });
    const row = await db.deliveryFeedback.findFirstOrThrow({ where: { outboundRecipientId: out.recipientId } });
    expect(row).toMatchObject({ source: 'ses', kind: 'bounce', action: 'bounced-suppressed' });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'delivery.async-bounce', entityId: row.id } });
    expect(audit.requestId).toBe(`sqs:${first}`);

    // SNS (or SQS) delivers the same notification again: deleted, nothing done twice.
    const again = sqs.push(envelope);
    await until(() => sqs.deleted.includes(again));
    expect(await db.deliveryFeedback.count({ where: { outboundRecipientId: out.recipientId } })).toBe(1);
    expect((await db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nobody@example.net' } })).bounceCount).toBe(1);
  });

  it('a complaint is recorded and alerts, and the hourly alert cap holds', async () => {
    sqs = await startFakeSqs({ waitMs: 50 });
    start();
    const before = alerts.length;
    const ids: string[] = [];
    for (let i = 0; i < COMPLAINT_ALERTS_PER_HOUR + 2; i++) {
      const out = await sentViaSes(`user${String(i)}@example.com`);
      ids.push(sqs.push(JSON.stringify(s.sign(notification(complaint(out.ses, `user${String(i)}@example.com`))))));
    }
    await until(() => ids.every((id) => sqs.deleted.includes(id)));
    expect(await db.deliveryFeedback.count({ where: { kind: 'complaint', source: 'ses' } })).toBe(COMPLAINT_ALERTS_PER_HOUR + 2);
    expect(alerts.length - before).toBe(COMPLAINT_ALERTS_PER_HOUR);
    expect(await db.deliveryFeedback.count({ where: { kind: 'complaint', alertedAt: { not: null } } })).toBe(COMPLAINT_ALERTS_PER_HOUR);
    // Complaints change no mail.
    expect(await db.suppressedRecipient.count({ where: { address: { startsWith: 'user' } } })).toBe(0);
  });

  it('a forged signature is refused, audited and deleted — nothing else written', async () => {
    sqs = await startFakeSqs({ waitMs: 50 });
    start();
    const out = await sentViaSes('target@example.net');
    const other = makeKey();
    const good = s.sign(notification(bounce(out.ses, 'target@example.net')));
    const forged = other === undefined ? { ...good, Message: good.Message.replace('Permanent', 'Permanent ') } : s.sign(notification(bounce(out.ses, 'target@example.net')), '2', other.key);
    const id = sqs.push(JSON.stringify(forged));
    await until(() => sqs.deleted.includes(id));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'ses.feedback.refused', requestId: `sqs:${id}` } });
    expect(audit.after).toMatchObject({ sqsMessageId: id, snsMessageId: forged.MessageId, code: 'sns_signature_invalid' });
    expect(JSON.stringify(audit.after)).not.toContain(forged.Signature);
    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipientId } })).state).toBe('delivered');
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'target@example.net' } })).toBeNull();
    expect(await db.deliveryFeedback.count({ where: { address: 'target@example.net' } })).toBe(0);
  });

  it('a certificate that cannot be fetched leaves the message on the queue; it is processed once the certificate comes back', async () => {
    sqs = await startFakeSqs({ waitMs: 50 });
    start(() => Promise.reject(new Error('offline')));
    const out = await sentViaSes('later@example.net');
    const id = sqs.push(JSON.stringify(s.sign(notification(bounce(out.ses, 'later@example.net')))));
    await until(() => sqs.visibility.some((v) => v.id === id));
    expect(sqs.deleted).not.toContain(id);
    expect(sqs.remaining()).toContain(id);
    expect(await db.deliveryFeedback.count({ where: { address: 'later@example.net' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { requestId: `sqs:${id}` } })).toBe(0);

    // A restarted worker with the certificate reachable picks it up when it becomes visible again.
    await poller?.stop();
    // Once the aborted long poll is gone (as with real SQS, a poll that ends while a message
    // arrives could otherwise take it, and hide it until its visibility timeout).
    await until(() => sqs.pending() === 0);
    sqs.expireAll();
    start();
    await until(() => sqs.deleted.includes(id));
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'later@example.net' } })).not.toBeNull();
    expect(logs).toContain('ses-feedback-transient');
  });
});
