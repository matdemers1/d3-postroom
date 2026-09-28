// PST-T-11.15 / PST-REQ-176: asynchronous bounces and complaints against a real database. A
// correlated DSN failure moves a delivered recipient to bounced with the remote status and a
// DeliveryAttempt row, and suppresses the address only for 5.1.x; one account's DSN never touches
// another account's mail; a refused (unauthenticated) report changes nothing; a signed SES
// Permanent bounce suppresses even with no queue row, a Transient one only records; complaints are
// recorded with an alert due once; and every event is idempotent by its dedupe key.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecipientState } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { complaintAlert, recordAsyncBounce, recordComplaint, type AsyncBounceInput } from '../../src/feedback.js';
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

  it('a correlated 5.1.1 DSN marks the delivered recipient bounced, logs an attempt and suppresses — once', async () => {
    const out = await sent({ addresses: ['gone@example.net', 'fine@example.net'] });
    const input = bounce({ address: 'Gone@Example.net', correlation: { messageIds: [out.mid], accountIds: [senderId] }, detail: { remoteMta: 'mx.example.net' } });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, input));
    expect(r).toMatchObject({ duplicate: false, action: 'bounced-suppressed', marked: true, suppressed: true, outboundMessageId: out.id, recipientId: out.recipients['gone@example.net'] });

    const rcpt = await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['gone@example.net'] ?? '' }, include: { attemptsLog: true } });
    expect(rcpt).toMatchObject({ state: 'bounced', lastCode: 550, lastEnhanced: '5.1.1', lastText: '[async DSN] 550 5.1.1 User unknown' });
    expect(rcpt.deliveredAt).not.toBeNull();
    expect(rcpt.attemptsLog).toEqual([expect.objectContaining({ transport: 'async-dsn', outcome: 'bounced', remoteEnhanced: '5.1.1', mxHost: 'mx.example.net' })]);
    expect((await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: out.recipients['fine@example.net'] ?? '' } })).state).toBe('delivered');

    expect(await findSuppressed(t.db, ['gone@example.net'])).toEqual([expect.objectContaining({ address: 'gone@example.net', reason: 'hard-bounce', code: 550, enhanced: '5.1.1' })]);
    const audits = await t.db.auditEvent.findMany({ where: { requestId: input.requestId }, orderBy: { at: 'asc' } });
    expect(audits.map((a) => a.action).sort()).toEqual(['delivery.async-bounce', 'suppression.add']);

    // The same event again (a replayed job): nothing more happens.
    const again = await t.db.$transaction((tx) => recordAsyncBounce(tx, input));
    expect(again).toMatchObject({ duplicate: true, feedbackId: r.feedbackId, marked: false, suppressed: false });
    expect((await t.db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'gone@example.net' } })).bounceCount).toBe(1);
    expect(await t.db.deliveryFeedback.count({ where: { dedupeKey: input.dedupeKey } })).toBe(1);
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

  it('a 5.2.2 DSN correlated by ENVID (xtext) bounces the recipient without suppressing', async () => {
    const out = await sent({ addresses: ['full@example.com'], envid: 'pst-env-0042' });
    const r = await t.db.$transaction((tx) =>
      recordAsyncBounce(tx, bounce({ address: 'full@example.com', status: '5.2.2', code: 552, diagnostic: '552-5.2.2 over quota', correlation: { messageIds: [], envid: 'pst+2Denv+2D0042', accountIds: [senderId] } })),
    );
    expect(r).toMatchObject({ action: 'bounced', marked: true, suppressed: false, outboundMessageId: out.id });
    expect(r.reasons.join(' ')).toMatch(/5\.2\.2 is not 5\.1\.x/);
    expect(await findSuppressed(t.db, ['full@example.com'])).toEqual([]);
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

  it('a recipient the queue still owns is left alone', async () => {
    const out = await sent({ addresses: ['wait@example.net'], state: RecipientState.deferred });
    const r = await t.db.$transaction((tx) => recordAsyncBounce(tx, bounce({ address: 'wait@example.net', correlation: { messageIds: [out.mid], accountIds: [senderId] } })));
    expect(r).toMatchObject({ action: 'recorded', marked: false, suppressed: false });
    expect(r.reasons.join(' ')).toMatch(/deferred: the queue owns it/);
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
});
