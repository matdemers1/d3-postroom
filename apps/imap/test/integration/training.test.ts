// PST-T-5.3 doneWhen, over a real IMAP session against a real database: "An IMAP MOVE updates token
// counts" (PST-REQ-104). A move between two buckets — MOVE, UID MOVE, or COPY then EXPUNGE — writes
// a bayes_training_event in the move's transaction; the worker's training consumer (run here
// in-process) turns it into token counts; a move back retrains (the counts move with it); running
// the consumer again, or replaying every event from scratch, leaves the counts where they were.
// Moves that are not between two buckets (to Archive, a COPY alone, a plain delete) teach nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The consumer lives in the worker; the test drives it directly, as the worker's loop would.
import { blobHeaderReader, createTrainingConsumer, type TrainingConsumer } from '../../../worker/src/training/index.js';
import { ImapClient } from './client.js';
import { hasOpenssl, makeAccount, seedMessage, startHarness, type Account, type Harness } from './harness.js';

const canRun = process.env['DATABASE_URL'] !== undefined && (await hasOpenssl());

function newsletter(n: string): Buffer {
  return Buffer.from(
    [
      'From: Shop Weekly <news@mail.shop.example>',
      'To: alice@d3cloud.io',
      `Subject: Weekly digest ${n}`,
      'Date: Wed, 23 Sep 2026 12:30:00 +0000',
      `Message-ID: <digest-${n}@shop.example>`,
      'List-Unsubscribe: <mailto:unsubscribe@shop.example>',
      'List-Id: Shop Weekly <weekly.shop.example>',
      '',
      'This week: a sale on everything.',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe.skipIf(!canRun)('Bayes training on moves from any client (PST-T-5.3, PST-REQ-104)', () => {
  let h: Harness;
  let consumer: TrainingConsumer;
  const open: ImapClient[] = [];

  beforeAll(async () => {
    h = await startHarness('pst_t53');
    consumer = createTrainingConsumer({ db: h.db, readHeaders: blobHeaderReader(h.blobs) });
  }, 120_000);

  afterAll(async () => {
    for (const c of open) c.close();
    await h.close();
  });

  async function login(account: Account): Promise<ImapClient> {
    const c = await ImapClient.tls(h.tlsPort);
    open.push(c);
    expect(await c.next()).toMatch(/^\* OK /);
    expect((await c.command(`LOGIN ${account.address} ${account.appPassword}`)).tagged).toMatch(/^A\d+ OK /);
    // Newsletters is a default mailbox since PST-T-5.1.
    return c;
  }

  /** Seed a newsletter into INBOX, with the search row the parse stage would have written. */
  async function deliver(account: Account, n: string): Promise<{ uid: number; id: string }> {
    const uid = await seedMessage(h, account.id, 'INBOX', newsletter(n));
    const row = await h.db.message.findFirstOrThrow({ where: { uid, mailbox: { accountId: account.id, name: 'INBOX' } } });
    await h.db.messageSearch.create({
      data: { messageId: row.id, accountId: account.id, subject: `Weekly digest ${n}`, fromText: 'Shop Weekly news@mail.shop.example', bodyText: 'This week: a sale on everything.' },
    });
    return { uid, id: row.id };
  }

  async function events(account: Account) {
    return h.db.bayesTrainingEvent.findMany({ where: { accountId: account.id }, orderBy: { id: 'asc' } });
  }

  async function counts(account: Account): Promise<Record<string, number>> {
    const rows = await h.db.bayesToken.findMany({ where: { accountId: account.id }, orderBy: [{ bucket: 'asc' }, { token: 'asc' }] });
    return Object.fromEntries(rows.map((r) => [`${r.bucket}/${r.token}`, r.count]));
  }

  async function totals(account: Account): Promise<Record<string, { docs: number; tokens: number }>> {
    const rows = await h.db.bayesBucketTotal.findMany({ where: { accountId: account.id } });
    return Object.fromEntries(rows.map((r) => [r.bucket, { docs: r.docs, tokens: r.tokens }]));
  }

  const bucketTokens = (c: Record<string, number>, bucket: string): string[] =>
    Object.keys(c)
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1));

  it('MOVE INBOX → Newsletters writes an event, and the consumer trains the counts', async () => {
    const account = await makeAccount(h);
    const c = await login(account);
    const msg = await deliver(account, 'a');
    expect((await c.command('SELECT INBOX')).tagged).toMatch(/ OK /);
    expect((await c.command('MOVE 1 Newsletters')).tagged).toMatch(/ OK /);

    const [e, ...rest] = await events(account);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ messageId: msg.id, fromBucket: 'inbox', toBucket: 'newsletters', via: 'imap-move', processedAt: null });
    expect(await counts(account)).toEqual({});

    expect(await consumer.drain()).toBeGreaterThanOrEqual(1);
    const trained = await counts(account);
    const tokens = bucketTokens(trained, 'newsletters');
    // Header tokens (read from the blob), the sender's domain, the subject and the body.
    expect(tokens).toEqual(expect.arrayContaining(['h:list-unsubscribe', 'list:weekly.shop.example', 'from:mail.shop.example', 's:weekly', 's:digest', 'sale']));
    expect(trained['newsletters/s:weekly']).toBe(1);
    expect(bucketTokens(trained, 'inbox')).toEqual([]);
    expect((await totals(account))['newsletters']).toEqual({ docs: 1, tokens: Object.values(trained).reduce((s, n) => s + n, 0) });
    expect((await events(account))[0]).toMatchObject({ outcome: 'trained' });
    expect((await events(account))[0]?.processedAt).not.toBeNull();

    // A move back retrains: the same tokens leave Newsletters and arrive in INBOX.
    expect((await c.command('SELECT Newsletters')).tagged).toMatch(/ OK /);
    expect((await c.command('MOVE 1 INBOX')).tagged).toMatch(/ OK /);
    expect(await consumer.drain()).toBeGreaterThanOrEqual(1);
    const back = await counts(account);
    expect(bucketTokens(back, 'newsletters')).toEqual([]);
    expect(bucketTokens(back, 'inbox').sort()).toEqual(tokens.sort());
    expect(back['inbox/s:weekly']).toBe(1);
    const t = await totals(account);
    expect(t['newsletters']?.docs).toBe(0);
    expect(t['inbox']?.docs).toBe(1);
    expect((await events(account)).map((x) => x.outcome)).toEqual(['trained', 'retrained']);

    // Running the consumer again changes nothing.
    expect(await consumer.drain()).toBe(0);
    expect(await counts(account)).toEqual(back);

    // Nor does replaying every event from the start: the per-document record makes it idempotent.
    await h.db.bayesTrainingEvent.updateMany({ where: { accountId: account.id }, data: { processedAt: null, outcome: null } });
    expect(await consumer.drain()).toBeGreaterThanOrEqual(2);
    expect(await counts(account)).toEqual(back);
    expect(await totals(account)).toEqual(t);
  });

  it('UID MOVE writes the same event', async () => {
    const account = await makeAccount(h);
    const c = await login(account);
    const msg = await deliver(account, 'b');
    expect((await c.command('SELECT INBOX')).tagged).toMatch(/ OK /);
    expect((await c.command(`UID MOVE ${msg.uid} Newsletters`)).tagged).toMatch(/ OK /);
    expect(await events(account)).toEqual([expect.objectContaining({ messageId: msg.id, fromBucket: 'inbox', toBucket: 'newsletters', via: 'imap-move' })]);
    await consumer.drain();
    expect((await counts(account))['newsletters/h:list-unsubscribe']).toBe(1);
  });

  it('COPY then EXPUNGE is a move: the copy is trained', async () => {
    const account = await makeAccount(h);
    const c = await login(account);
    await deliver(account, 'c');
    expect((await c.command('SELECT INBOX')).tagged).toMatch(/ OK /);
    expect((await c.command('COPY 1 Newsletters')).tagged).toMatch(/ OK /);
    // A COPY alone is not a move.
    expect(await events(account)).toEqual([]);
    expect((await c.command('STORE 1 +FLAGS.SILENT (\\Deleted)')).tagged).toMatch(/ OK /);
    expect((await c.command('EXPUNGE')).tagged).toMatch(/ OK /);

    const copy = await h.db.message.findFirstOrThrow({ where: { mailbox: { accountId: account.id, name: 'Newsletters' } } });
    expect(await events(account)).toEqual([expect.objectContaining({ messageId: copy.id, fromBucket: 'inbox', toBucket: 'newsletters', via: 'imap-copy-expunge' })]);
    await consumer.drain();
    const trained = await counts(account);
    expect(trained['newsletters/s:digest']).toBe(1);
    expect(trained['newsletters/sale']).toBe(1);
  });

  it('moves that are not between two buckets teach nothing', async () => {
    const account = await makeAccount(h);
    const c = await login(account);
    await deliver(account, 'd');
    await deliver(account, 'e');
    expect((await c.command('SELECT INBOX')).tagged).toMatch(/ OK /);
    expect((await c.command('MOVE 1 Archive')).tagged).toMatch(/ OK /);
    // Deleted outright: no copy anywhere.
    expect((await c.command('STORE 1 +FLAGS.SILENT (\\Deleted)')).tagged).toMatch(/ OK /);
    expect((await c.command('EXPUNGE')).tagged).toMatch(/ OK /);
    expect(await events(account)).toEqual([]);
    await consumer.drain();
    expect(await counts(account)).toEqual({});
  });
});
