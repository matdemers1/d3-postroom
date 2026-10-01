// PST-T-16.12 (PST-REQ-199, closes PST-DA-020): every list summary carries `to` — the first
// recipient's display name (else its address) and how many recipients — so Sent and Drafts can name
// who a message went to instead of the operator. It is STORED on the row: the worker's file stage
// writes it at filing time (driven here through the real inbound pipeline), and the to-summary
// sweep backfills every row filed without it — mail from before the columns existed and the paths
// that leave it NULL — reading headers only, in audited batches. Every response is checked against
// the zod schema the OpenAPI document is generated from.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { InboundState, randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { parseMailboxes } from '@postroom/mime';
import { enqueue, startWorker, type RunningWorker } from '@postroom/queue';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MessageDetail, MessageList, SearchResponse } from '../../src/mail/schemas.js';
import { toSummaryColumns } from '../../src/mail/to-summary.js';
import { createInboundPipeline, INBOUND_QUEUE } from '../../../worker/src/pipeline.js';
import { recipientSummary, toSummaryOfHeaders } from '../../../worker/src/stages/recipients.js';
import { createToSummarySweeper, drainToSummaries, sweepToSummaries, type ToSummarySweepDeps } from '../../../worker/src/stages/to-summary.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const CSRF = { 'x-postroom-csrf': '1' };

const PASS_VERDICTS = {
  spf: { result: 'pass', domain: 'example.org', scope: 'mfrom', reasons: ['spf pass'] },
  dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', testing: false, reasons: ['body hash ok'] }],
  dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', sampled: true, reasons: ['aligned dkim pass'] },
  arc: { result: 'none', instances: 0, sealerDomains: [], temporary: false, reasons: [] },
  dnsbl: null,
  decision: { action: 'accept', rule: 'dmarc-pass', disposition: 'accept', reasons: ['DMARC pass'] },
};

function raw(headers: Record<string, string>, body = 'Hello.'): Buffer {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  lines.push('Date: Tue, 29 Sep 2026 12:00:00 +0000', `Message-ID: <${randomUUID()}@example.org>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}

describe('the to-summary is the same answer from headers and from parsed recipients', () => {
  const cases: { headers: { name: string; value: string }[]; toName: string | null; toCount: number }[] = [
    { headers: [{ name: 'To', value: '"Alice Ng" <alice@example.org>, bob@example.org' }], toName: 'Alice Ng', toCount: 2 },
    { headers: [{ name: 'To', value: 'bob@example.org' }], toName: 'bob@example.org', toCount: 1 },
    // To, then Cc, then Bcc — the first recipient leads; Bcc counts (our own Sent copy keeps it).
    {
      headers: [
        { name: 'Bcc', value: 'Hidden <h@example.org>' },
        { name: 'Cc', value: '=?UTF-8?Q?Ren=C3=A9e?= <renee@example.org>' },
        { name: 'To', value: 'Alice <alice@example.org>' },
      ],
      toName: 'Alice',
      toCount: 3,
    },
    { headers: [{ name: 'Cc', value: '=?UTF-8?Q?Ren=C3=A9e_L=C3=A9vesque?= <renee@example.org>' }], toName: 'Renée Lévesque', toCount: 1 },
    // The same address twice is one recipient; a group is flattened; an empty group is nobody.
    { headers: [{ name: 'To', value: 'Team: a@example.org, b@example.org;, A@EXAMPLE.ORG' }], toName: 'a@example.org', toCount: 2 },
    { headers: [{ name: 'To', value: 'undisclosed-recipients:;' }], toName: null, toCount: 0 },
    { headers: [{ name: 'Subject', value: 'no recipients at all' }], toName: null, toCount: 0 },
    // Controls an encoded-word decodes to are dropped from the name.
    { headers: [{ name: 'To', value: '=?UTF-8?Q?Ev=07il?= <e@example.org>' }], toName: 'Evil', toCount: 1 },
  ];

  it.each(cases)('$headers.0.value', ({ headers, toName, toCount }) => {
    expect(toSummaryOfHeaders(headers)).toEqual({ toName, toCount });
    // The API's twin, given the same recipients in the same order, agrees.
    const order = ['to', 'cc', 'bcc'];
    const recipients = order.flatMap((f) => headers.filter((h) => h.name.toLowerCase() === f).flatMap((h) => parseMailboxes(h.value)));
    expect(toSummaryColumns(recipients)).toEqual({ toName, toCount });
    expect(recipientSummary(recipients)).toEqual({ toName, toCount });
  });
});

interface Person {
  id: string;
  address: string;
  cookie: string;
  inbox: string;
  sent: string;
  drafts: string;
  archive: string;
}

describe.skipIf(!baseUrl)('Sent and Drafts name the recipients: a stored to-summary (PST-T-16.12)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  let worker: RunningWorker;
  const clock = new TestClock();
  const sweepDeps = (over: Partial<ToSummarySweepDeps> = {}): ToSummarySweepDeps => ({ db, blobs, log: () => undefined, now: () => new Date(), ...over });

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    const drafts = await mk('Drafts', SpecialUse.drafts);
    const archive = await mk('Archive', SpecialUse.archive);
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret), inbox: inbox.id, sent: sent.id, drafts: drafts.id, archive: archive.id };
  };

  /** A row filed the way every path filed mail before PST-T-16.12 (and compose/IMAP still may): headers denormalised, no to-summary. */
  const fileWithoutSummary = async (me: Person, mailbox: 'Sent' | 'Drafts' | 'INBOX', message: Buffer, subject: string): Promise<string> => {
    const blob = await db.$transaction((tx) => blobs.put(message, { tx }));
    const filed = await db.$transaction(async (tx) => {
      const m = await fileLocalMessage(tx, { accountId: me.id, mailbox, blobSha256: blob.sha256, size: blob.size, internalDate: new Date(), flags: mailbox === 'Drafts' ? ['\\Draft', '\\Seen'] : ['\\Seen'] });
      await tx.message.update({ where: { id: m.id }, data: { subject, fromAddress: me.address, fromName: 'The Operator', snippet: 'Hello.' } });
      return m;
    });
    return filed.id;
  };

  /** Spool one inbound message for `me`, exactly as smtp-in commits an accepted one. */
  const spool = async (me: Person, message: Buffer): Promise<string> => {
    const id = randomUUID();
    await db.$transaction(async (tx) => {
      const blob = await blobs.put(message, { tx });
      await tx.inboundMessage.create({
        data: {
          id,
          envelopeFrom: 'alice@example.org',
          recipients: [{ rcpt: me.address, address: me.address, accountIds: [me.id], kind: 'mailbox' }],
          blobSha256: blob.sha256,
          size: blob.size,
          state: InboundState.spooled,
          verdicts: PASS_VERDICTS,
          disposition: 'accept',
          dispositionReason: 'DMARC pass',
          smtpReply: `250 2.0.0 Queued as ${id}`,
        },
      });
      await enqueue(tx, INBOUND_QUEUE, { inboundMessageId: id }, { idempotencyKey: `inbound:${id}` });
    });
    return id;
  };

  const page = async (me: Person, mailboxId: string) => MessageList.parse((await request(app).get(`/api/mailboxes/${mailboxId}/messages`).set('cookie', me.cookie)).body);

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1612_to_summary');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t1612-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    const now = (): Date => new Date();
    worker = await startWorker({ db, databaseUrl: testDb.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now }).handle }, manual: true, now });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('the file stage stores the to-summary when the message is filed, and every list carries it', async () => {
    const me = await person();
    const inbound = await spool(
      me,
      raw({ From: 'Priya Shah <priya@example.org>', To: `"Matt Demers" <${me.address}>, bob@example.org`, Cc: '=?UTF-8?Q?Ren=C3=A9e?= <renee@example.org>', Subject: 'Lunch platypus' }),
    );
    await worker.drain();
    const row = await db.message.findFirstOrThrow({ where: { inboundMessageId: inbound } });
    expect(row).toMatchObject({ toName: 'Matt Demers', toCount: 3 });

    const listed = (await page(me, row.mailboxId)).messages.find((m) => m.id === row.id);
    expect(listed?.to).toEqual({ name: 'Matt Demers', count: 3 });
    const search = SearchResponse.parse((await request(app).get('/api/search?q=platypus').set('cookie', me.cookie)).body);
    expect(search.messages.map((m) => m.to)).toEqual([{ name: 'Matt Demers', count: 3 }]);
  });

  it('the sweep backfills Sent and Drafts rows filed without one, reading headers only, audited once per batch, then never again', async () => {
    const me = await person();
    // A 3 MiB body: the sweep must stop at the blank line, never read the message (PST-REQ-050).
    const sent = await fileWithoutSummary(me, 'Sent', raw({ From: `The Operator <${me.address}>`, To: '"Alice Ng" <alice@example.org>', Cc: 'bob@example.org', Subject: 'Sent one' }, 'x'.repeat(3 * 1024 * 1024)), 'Sent one');
    const draft = await fileWithoutSummary(me, 'Drafts', raw({ From: `The Operator <${me.address}>`, Subject: 'Draft with nobody yet' }), 'Draft with nobody yet');

    const before = await page(me, me.sent);
    expect(before.messages.find((m) => m.id === sent)?.to).toBeNull();

    let bytes = 0;
    const counting: BlobStore = {
      ...blobs,
      get: async (sha) => {
        const inner = await blobs.get(sha);
        return Readable.from(
          (async function* count() {
            for await (const chunk of inner as AsyncIterable<Uint8Array>) {
              bytes += chunk.length;
              yield chunk;
            }
          })(),
        );
      },
    };
    const first = await sweepToSummaries(sweepDeps({ blobs: counting }), { graceMs: 0 });
    expect(first).toMatchObject({ summarised: 2, failed: 0, unavailable: 0 });
    expect(bytes).toBeLessThan(1024 * 1024);

    expect(await db.message.findUniqueOrThrow({ where: { id: sent } })).toMatchObject({ toName: 'Alice Ng', toCount: 2 });
    expect(await db.message.findUniqueOrThrow({ where: { id: draft } })).toMatchObject({ toName: null, toCount: 0 });

    const audit = await db.auditEvent.findMany({ where: { action: 'message.to-summary-backfill' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorKind).toBe('system');
    expect((audit[0]?.after as { messageIds: string[] }).messageIds).toEqual(expect.arrayContaining([sent, draft]));

    // Summarised rows leave the candidate set (to_count is never NULL again): nothing to do, nothing audited.
    const second = await sweepToSummaries(sweepDeps(), { graceMs: 0 });
    expect(second.scanned).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'message.to-summary-backfill' } })).toBe(1);

    const after = await page(me, me.sent);
    expect(after.messages.find((m) => m.id === sent)?.to).toEqual({ name: 'Alice Ng', count: 2 });
    const drafts = await page(me, me.drafts);
    expect(drafts.messages.find((m) => m.id === draft)?.to).toEqual({ name: null, count: 0 });
  });

  it('never overwrites a summary a filing path wrote, and leaves rows inside the grace period', async () => {
    const me = await person();
    const id = await fileWithoutSummary(me, 'Sent', raw({ To: 'Late <late@example.org>', Subject: 'Grace' }), 'Grace');
    expect((await sweepToSummaries(sweepDeps(), { graceMs: 3_600_000 })).scanned).toBe(0);
    await db.message.update({ where: { id }, data: { toName: 'Written live', toCount: 5 } });
    expect((await sweepToSummaries(sweepDeps(), { graceMs: 0 })).scanned).toBe(0);
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject({ toName: 'Written live', toCount: 5 });
  });

  it('a row whose blob is gone is given count 0, audited, and not read again; a transient failure waits for the next pass', async () => {
    const me = await person();
    const gone = await fileWithoutSummary(me, 'Sent', raw({ To: 'Gone <gone@example.org>', Subject: 'Gone' }), 'Gone');
    const row = await db.message.findUniqueOrThrow({ where: { id: gone } });
    await unlink(join(blobRoot, row.blobSha256.slice(0, 2), row.blobSha256.slice(2, 4), row.blobSha256));
    const r1 = await sweepToSummaries(sweepDeps(), { graceMs: 0 });
    expect(r1).toMatchObject({ unavailable: 1 });
    expect(await db.message.findUniqueOrThrow({ where: { id: gone } })).toMatchObject({ toName: null, toCount: 0 });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'message.to-summary-unavailable' } });
    expect(audit.after).toEqual({ count: 1, messages: [{ messageId: gone, reason: 'ENOENT' }] });

    const flakyId = await fileWithoutSummary(me, 'Sent', raw({ To: 'Flaky <flaky@example.org>', Subject: 'Flaky' }), 'Flaky');
    let calls = 0;
    const flaky: BlobStore = { ...blobs, get: (sha) => (++calls === 1 ? Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })) : blobs.get(sha)) };
    expect(await sweepToSummaries(sweepDeps({ blobs: flaky }), { graceMs: 0 })).toMatchObject({ scanned: 1, failed: 1 });
    expect((await db.message.findUniqueOrThrow({ where: { id: flakyId } })).toCount).toBeNull();
    expect(await sweepToSummaries(sweepDeps({ blobs: flaky }), { graceMs: 0 })).toMatchObject({ scanned: 1, summarised: 1 });
    expect(await db.message.findUniqueOrThrow({ where: { id: flakyId } })).toMatchObject({ toName: 'Flaky', toCount: 1 });
  });

  it('drains a backlog larger than one batch', async () => {
    const me = await person();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await fileWithoutSummary(me, 'Sent', raw({ To: `Person ${String(i)} <p${String(i)}@example.org>`, Subject: `Batch ${String(i)}` }), `Batch ${String(i)}`));
    const sweep = createToSummarySweeper(sweepDeps(), { graceMs: 0, limit: 2 });
    expect(await drainToSummaries(sweep, 2)).toBe(5);
    const rows = await db.message.findMany({ where: { id: { in: ids } }, orderBy: { subject: 'asc' } });
    expect(rows.map((r) => [r.toName, r.toCount])).toEqual([0, 1, 2, 3, 4].map((i) => [`Person ${String(i)}`, 1]));
  });

  it('a move keeps the to-summary', async () => {
    const me = await person();
    const id = await fileWithoutSummary(me, 'Sent', raw({ To: 'Alice <alice@example.org>, bob@example.org', Subject: 'Keep it' }), 'Keep it');
    await db.message.update({ where: { id }, data: { toName: 'Alice', toCount: 2 } });
    const got = await request(app).get(`/api/messages/${id}`).set('cookie', me.cookie);
    const moved = await request(app).patch(`/api/messages/${id}`).set(CSRF).set('cookie', me.cookie).set('if-match', got.get('etag') ?? '').send({ mailboxId: me.archive });
    expect(moved.status).toBe(200);
    expect(MessageDetail.parse(moved.body)).toMatchObject({ mailboxId: me.archive, to: { name: 'Alice', count: 2 } });
  });
});
