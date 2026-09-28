// PST-T-11.15 / PST-REQ-176: asynchronous bounces and complaints against a real database. Only a
// signed SES notification changes anything: a Permanent bounce moves a delivered recipient to
// bounced with a DeliveryAttempt row and suppresses the address for 5.1.x or no status, even with
// no queue row; Transient only records. An SMTP DSN — forgeable, unauthenticatable — is recorded
// against the recipient it names and changes nothing (the verifier's co-recipient attack is a
// regression test here). Complaints are recorded, with alerts capped per message and per hour; and
// every event is idempotent by its dedupe key.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecipientState } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { complaintAlert, markAlerted, recordAsyncBounce, recordComplaint, type AsyncBounceInput } from '../../src/feedback.js';
import { findSuppressed } from '../../src/suppression.js';

const baseUrl = process.env['DATABASE_URL'];
const NOW = new Date('2026-09-27T12:00:00Z');

describe.skipIf(baseUrl === undefined)('async feedback: DSN, ARF and SES (PST-T-11.15)', () => {
  let t: TestDatabase;
  let senderId = '';
  let otherId = '';

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1115_delivery');
    senderId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
    otherId = (await t.db.account.create({ data: { displayName: 'Other' } })).id;
  }, 120_000);
  afterAll(async () => {
    await t.drop();
  });

  /** An outbound message the remote already accepted: every recipient `delivered`. */
  async function sent(opts: { accountId?: string; addresses: string[]; envid?: string; state?: RecipientState }): Promise<{ id: string; mid: string; recipients: Record<string, string> }> {
    const mid = `${randomUUID()}@d3cloud.io`;
    const m = await t.db.outboundMessage.create({
      data: {
        accountId: opts.accountId ?? senderId,
        envelopeFrom: 'matt@d3cloud.io',
        headerFrom: 'matt@d3cloud.io',
        messageId: `<${mid}>`,
        blobSha256: 'a'.repeat(64),
        size: 10,
        submittedVia: 'test',
        ...(opts.envid === undefined ? {} : { dsnEnvid: opts.envid }),
        recipients: {
          create: opts.addresses.map((address) => ({ address, domain: address.split('@')[1] ?? '', state: opts.state ?? RecipientState.delivered, deliveredAt: NOW, transport: 'ses' })),
        },
      },
      include: { recipients: true },
    });
    return { id: m.id, mid, recipients: Object.fromEntries(m.recipients.map((r) => [r.address, r.id])) };
  }

  const bounce = (over: Partial<AsyncBounceInput> & Pick<AsyncBounceInput, 'address' | 'correlation'>): AsyncBounceInput => ({
    source: 'dsn',
    dedupeKey: `test:${randomUUID()}`,
    status: '5.1.1',
    code: 550,
    diagnostic: '550 5.1.1 User unknown',
    final: true,
    trusted: false,
    reportedAt: NOW,
    now: NOW,
    requestId: `test:${randomUUID()}`,
    ...over,
  });

  it('a signed SES 5.1.1 bounce marks the delivered recipient bounced, logs an attempt and suppresses — once', async () => {
    const out = await sent({ addresses: ['gone@example.net', 'fine@example.net'] });
    const input = bounce({ source: 'ses', trusted: true, address: 'Gone@Example.net', correlation: { messageIds: [out.mid] }, detail: { remoteMta: 'mx.example.net' } });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, input));
    expect(r).toMatchObject({ duplicate: false, action: 'bounced-suppressed', marked: true, suppressed: true, outboundMessageId: out.id, recipientId: out.recipients['gone@example.net'] });

    const rcpt = await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['gone@example.net'] ?? '' }, include: { attemptsLog: true } });
    expect(rcpt).toMatchObject({ state: 'bounced', lastCode: 550, lastEnhanced: '5.1.1', lastText: '[SES bounce notification] 550 5.1.1 User unknown' });
    expect(rcpt.deliveredAt).not.toBeNull();
    expect(rcpt.attemptsLog).toEqual([expect.objectContaining({ transport: 'ses-notification', outcome: 'bounced', remoteEnhanced: '5.1.1', mxHost: 'mx.example.net' })]);
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['fine@example.net'] ?? '' } })).state).toBe('delivered');

    expect(await findSuppressed(t.db, ['gone@example.net'])).toEqual([expect.objectContaining({ address: 'gone@example.net', reason: 'hard-bounce', code: 550, enhanced: '5.1.1' })]);
    const audits = await t.db.auditEvent.findMany({ where: { requestId: input.requestId }, orderBy: { at: 'asc' } });
    expect(audits.map((a) => a.action).sort()).toEqual(['delivery.async-bounce', 'suppression.add']);

    // The same event again (a redelivered notification): nothing more happens.
    const again = await t.db.$transaction((tx) => recordAsyncBounce(tx, input));
    expect(again).toMatchObject({ duplicate: true, feedbackId: r.feedbackId, marked: false, suppressed: false });
    expect((await t.db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'gone@example.net' } })).bounceCount).toBe(1);
    expect(await t.db.deliveryFeedback.count({ where: { dedupeKey: input.dedupeKey } })).toBe(1);
  });

  it('regression (verifier attack): a forged null-sender 5.1.1 DSN naming a co-recipient is recorded and changes nothing', async () => {
    // Account A mails the attacker and the victim together; the attacker now knows the Message-ID
    // and the victim's address, and mails back a DSN claiming the victim bounced.
    const out = await sent({ addresses: ['attacker@evil.example', 'victim@gmail.example'] });
    const r = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ address: 'victim@gmail.example', correlation: { messageIds: [out.mid], accountIds: [senderId] }, detail: { remoteMta: 'mx.evil.example' } })),
    );
    expect(r).toMatchObject({ action: 'recorded', marked: false, suppressed: false, outboundMessageId: out.id, recipientId: out.recipients['victim@gmail.example'] });
    expect(r.reasons.join(' ')).toMatch(/cannot be authenticated/);
    const victim = await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['victim@gmail.example'] ?? '' }, include: { attemptsLog: true } });
    expect(victim).toMatchObject({ state: 'delivered', lastEnhanced: null });
    expect(victim.attemptsLog).toEqual([]);
    expect(await findSuppressed(t.db, ['victim@gmail.example'])).toEqual([]);
    // What is recorded is there for the sender and the admin to read.
    expect(await t.db.deliveryFeedback.findUniqueOrThrow({ where: { id: r.feedbackId } })).toMatchObject({
      kind: 'bounce',
      source: 'dsn',
      address: 'victim@gmail.example',
      status: '5.1.1',
      diagnostic: '550 5.1.1 User unknown',
      outboundMessageId: out.id,
      outboundRecipientId: out.recipients['victim@gmail.example'],
      action: 'recorded',
    });
  });

  it("never marks another account's mail: the same Message-ID under the wrong account matches nothing", async () => {
    const out = await sent({ addresses: ['victim@example.net'] });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, bounce({ address: 'victim@example.net', correlation: { messageIds: [out.mid], accountIds: [otherId] } })));
    expect(r).toMatchObject({ action: 'recorded', marked: false, suppressed: false, outboundMessageId: null });
    expect(r.reasons.join(' ')).toMatch(/among mail the receiving account sent/);
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['victim@example.net'] ?? '' } })).state).toBe('delivered');
    expect(await findSuppressed(t.db, ['victim@example.net'])).toEqual([]);
  });

  it('a recipient the message was not sent to is not marked or suppressed', async () => {
    const out = await sent({ addresses: ['real@example.net'] });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, bounce({ address: 'stranger@example.net', correlation: { messageIds: [out.mid], accountIds: [senderId] } })));
    expect(r).toMatchObject({ action: 'recorded', marked: false, suppressed: false, outboundMessageId: out.id, recipientId: null });
    expect(await findSuppressed(t.db, ['stranger@example.net'])).toEqual([]);
  });

  it('a DSN correlated by ENVID (xtext) is recorded against its recipient, changing nothing', async () => {
    const out = await sent({ addresses: ['full@example.com'], envid: 'pst-env-0042' });
    const r = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ address: 'full@example.com', status: '5.2.2', code: 552, diagnostic: '552-5.2.2 over quota', correlation: { messageIds: [], envid: 'pst+2Denv+2D0042', accountIds: [senderId] } })),
    );
    expect(r).toMatchObject({ action: 'recorded', marked: false, suppressed: false, outboundMessageId: out.id, recipientId: out.recipients['full@example.com'] });
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['full@example.com'] ?? '' } })).state).toBe('delivered');
  });

  it('a signed SES bounce that is not 5.1.x bounces the recipient without suppressing', async () => {
    const out = await sent({ addresses: ['policy@example.com'] });
    const r = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ source: 'ses', trusted: true, address: 'policy@example.com', status: '5.7.1', code: 554, diagnostic: '554 5.7.1 rejected', correlation: { messageIds: [out.mid] } })),
    );
    expect(r).toMatchObject({ action: 'bounced', marked: true, suppressed: false });
    expect(r.reasons.join(' ')).toMatch(/5\.7\.1 is not 5\.1\.x/);
    expect(await findSuppressed(t.db, ['policy@example.com'])).toEqual([]);
  });

  it('a refused report (not from a null sender) is recorded as ignored and changes nothing', async () => {
    const out = await sent({ addresses: ['forged@example.net'] });
    const r = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ address: 'forged@example.net', correlation: { messageIds: [out.mid], accountIds: [senderId] }, refuse: ['not from a null reverse-path or MAILER-DAEMON/postmaster'] })),
    );
    expect(r).toMatchObject({ action: 'ignored', marked: false, suppressed: false });
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['forged@example.net'] ?? '' } })).state).toBe('delivered');
    expect(await findSuppressed(t.db, ['forged@example.net'])).toEqual([]);
  });

  it('a recipient the queue still owns is left alone by a signed bounce (the address is still suppressed)', async () => {
    const out = await sent({ addresses: ['wait@example.net'], state: RecipientState.deferred });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, bounce({ source: 'ses', trusted: true, address: 'wait@example.net', correlation: { messageIds: [out.mid] } })));
    // The queue keeps the recipient; the signed 5.1.1 is still evidence about the address.
    expect(r).toMatchObject({ action: 'suppressed', marked: false, suppressed: true });
    expect(r.reasons.join(' ')).toMatch(/deferred: the queue owns it/);
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['wait@example.net'] ?? '' } })).state).toBe('deferred');
  });

  it('a signed SES Permanent bounce suppresses even with no outbound row; Transient only records', async () => {
    const perm = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ source: 'ses', trusted: true, address: 'nobody@ses.example', status: null, code: null, diagnostic: null, feedbackType: 'Permanent/General', correlation: { messageIds: ['not-ours@example'] } })),
    );
    expect(perm).toMatchObject({ action: 'suppressed', suppressed: true, recipientId: null });
    const row = await t.db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nobody@ses.example' } });
    expect(row).toMatchObject({ code: null, enhanced: '', sourceRecipientId: null });

    const out = await sent({ addresses: ['busy@ses.example'] });
    const tr = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ source: 'ses', trusted: true, final: false, address: 'busy@ses.example', status: '4.2.2', code: null, feedbackType: 'Transient/MailboxFull', correlation: { messageIds: [out.mid] } })),
    );
    expect(tr).toMatchObject({ action: 'recorded', marked: false, suppressed: false, outboundMessageId: out.id });
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['busy@ses.example'] ?? '' } })).state).toBe('delivered');
  });

  it('a complaint is recorded against its message, with one alert due; an unsigned stranger gets none', async () => {
    const out = await sent({ addresses: ['user@example.com'] });
    const input = {
      source: 'arf' as const,
      dedupeKey: `arf:${randomUUID()}`,
      feedbackType: 'abuse',
      address: 'user@example.com',
      correlation: { messageIds: [out.mid] },
      trusted: false,
      reportedAt: NOW,
      now: NOW,
      alertsPerHour: 1000,
      requestId: `test:${randomUUID()}`,
    };
    const r = await t.db.$transaction((tx) => recordComplaint(tx, input));
    expect(r).toMatchObject({ duplicate: false, alertDue: true, outboundMessageId: out.id, accountId: senderId });
    const row = await t.db.deliveryFeedback.findUniqueOrThrow({ where: { id: r.feedbackId } });
    expect(row).toMatchObject({ kind: 'complaint', source: 'arf', feedbackType: 'abuse', outboundRecipientId: out.recipients['user@example.com'], action: 'recorded' });
    expect(await t.db.auditEvent.count({ where: { requestId: input.requestId, action: 'delivery.complaint' } })).toBe(1);
    expect((await t.db.$transaction((tx) => recordComplaint(tx, input))).alertDue).toBe(false);

    const alert = complaintAlert({ feedbackId: r.feedbackId, source: 'arf', feedbackType: 'abuse', address: 'user@example.com', outboundMessageId: out.id });
    expect(alert.key).toBe(`complaint:${r.feedbackId}`);
    expect(alert.subject).toMatch(/complaint \(abuse\)/);

    const stranger = await t.db.$transaction((tx) => recordComplaint(tx, { ...input, dedupeKey: `arf:${randomUUID()}`, correlation: { messageIds: ['nope@example.com'] } }));
    expect(stranger).toMatchObject({ alertDue: false, outboundMessageId: null });
    const ses = await t.db.$transaction((tx) => recordComplaint(tx, { ...input, source: 'ses', trusted: true, dedupeKey: `ses:${randomUUID()}`, correlation: { messageIds: ['nope@example.com'] } }));
    expect(ses.alertDue).toBe(true);
  });

  it('caps complaint alerts: one per outbound message ever for ARF, and a server-wide hourly cap', async () => {
    const at = new Date('2026-09-27T18:00:00Z');
    const arf = (mid: string, over: Partial<Parameters<typeof recordComplaint>[1]> = {}): Parameters<typeof recordComplaint>[1] => ({
      source: 'arf',
      dedupeKey: `arf:${randomUUID()}`,
      feedbackType: 'abuse',
      address: null,
      correlation: { messageIds: [mid] },
      trusted: false,
      reportedAt: at,
      now: at,
      alertsPerHour: 3,
      requestId: `test:${randomUUID()}`,
      ...over,
    });
    const alertOnce = async (input: Parameters<typeof recordComplaint>[1]): Promise<boolean> => {
      const r = await t.db.$transaction((tx) => recordComplaint(tx, input));
      if (r.alertDue) await markAlerted(t.db, r.feedbackId, input.now);
      return r.alertDue;
    };

    const one = await sent({ addresses: ['a@example.com'] });
    expect(await alertOnce(arf(one.mid))).toBe(true);
    // A second (possibly forged) report about the same message: recorded, no second alert, ever.
    expect(await alertOnce(arf(one.mid))).toBe(false);
    expect(await alertOnce(arf(one.mid, { now: new Date(at.getTime() + 7 * 86_400_000) }))).toBe(false);
    expect(await t.db.deliveryFeedback.count({ where: { outboundMessageId: one.id, kind: 'complaint' } })).toBe(3);

    // The hourly cap (3 here): two more messages fill it, the next is recorded without an alert,
    // signed SES complaints included; an hour later alerts flow again.
    expect(await alertOnce(arf((await sent({ addresses: ['b@example.com'] })).mid))).toBe(true);
    expect(await alertOnce(arf((await sent({ addresses: ['c@example.com'] })).mid))).toBe(true);
    const capped = await t.db.$transaction((tx) => recordComplaint(tx, arf(randomUUID(), { source: 'ses', trusted: true })));
    expect(capped.alertDue).toBe(false);
    expect(capped.reasons.join(' ')).toMatch(/3 complaint alerts in the last hour \(cap 3\)/);
    expect(await alertOnce(arf((await sent({ addresses: ['d@example.com'] })).mid, { now: new Date(at.getTime() + 3_600_001) }))).toBe(true);
  });
});
