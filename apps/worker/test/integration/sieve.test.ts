// PST-T-9.5 against a real database and blob store: the sieve stage runs each recipient account's
// active script (PST-REQ-148), and the file stage carries it out —
//   · fileinto "Receipts" + addflag "$Paid" files the copy there with the flag;
//   · vnd.postroom.bucket overrides the classifier's bucket;
//   · redirect to a foreign address is refused with its reason and the message is kept (no relay);
//     redirect to the account's own address delivers here and sends nothing;
//   · discard files to Trash with a reason — never a silent deletion;
//   · vacation answers once per sender per :days, through the submission path, and a replay of the
//     stage never sends a second reply.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { createInboundPipeline, type InboundPipeline } from '../../src/pipeline.js';
import { NO_SCRIPT_REASON } from '../../src/stages/file.js';
import { readPipeline } from '../../src/stages/state.js';
import type { SieveAccountOutcome } from '../../src/stages/types.js';
import { Clock, PASS_VERDICTS, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const DAY_MS = 86_400_000;

function message(opts: { from: string; to: string; subject: string; headers?: string[]; body?: string }): Buffer {
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${randomUUID()}@example.org>\r\n` +
      (opts.headers ?? []).map((h) => `${h}\r\n`).join('') +
      '\r\n' +
      `${opts.body ?? 'hello'}\r\n`,
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('Sieve in the inbound pipeline (PST-T-9.5, PST-REQ-148)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let kek: Kek;
  let blobRoot = '';
  const clock = new Clock();
  let pipeline: InboundPipeline;

  const makeAccount = async (login: string): Promise<{ id: string; address: string; rcpt: () => TestRecipient }> => {
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    const account = await db.account.create({ data: { displayName: login } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    for (const m of DEFAULT_MAILBOXES) {
      await db.mailbox.create({ data: { accountId: account.id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    const address = `${login}@d3cloud.io`;
    return { id: account.id, address, rcpt: () => ({ rcpt: address, address, accountIds: [account.id], kind: 'mailbox' }) };
  };

  const activate = async (accountId: string, content: string): Promise<void> => {
    await db.sieveScript.updateMany({ where: { accountId }, data: { active: false } });
    await db.sieveScript.upsert({
      where: { accountId_name: { accountId, name: 'rules' } },
      create: { accountId, name: 'rules', content, active: true },
      update: { content, active: true },
    });
  };

  const copiesOf = (inboundMessageId: string) =>
    db.message.findMany({
      where: { inboundMessageId },
      include: { mailbox: { select: { accountId: true, name: true, specialUse: true } }, verdict: true },
      orderBy: { id: 'asc' },
    });

  const deliver = async (opts: { message: Buffer; recipients: TestRecipient[]; envelopeFrom?: string }) => {
    const { id } = await spool(db, blobs, { ...opts, verdicts: PASS_VERDICTS });
    await pipeline.run(id);
    return { id, copies: await copiesOf(id) };
  };

  const sieveOutcome = async (inboundMessageId: string, accountId: string): Promise<SieveAccountOutcome> => {
    const row = await db.inboundMessage.findUniqueOrThrow({ where: { id: inboundMessageId } });
    const result = readPipeline(row.verdicts).stages.sieve?.result as unknown as { accounts: Record<string, SieveAccountOutcome> };
    const o = result.accounts[accountId];
    if (o === undefined) throw new Error('no sieve outcome for the account');
    return o;
  };

  const vacationReplies = (accountId: string) =>
    db.outboundMessage.findMany({ where: { accountId, submittedVia: 'sieve-vacation' }, include: { recipients: true }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t95_sieve');
    db = t.db;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t95-blobs-'));
    kek = generateKek();
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    pipeline = createInboundPipeline({ db, blobs, now: clock.now, kek: () => kek });
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('without a script, filing is exactly what the classifier decided, and the verdict says there was no script', async () => {
    const me = await makeAccount('noscript');
    const { copies } = await deliver({ message: message({ from: 'Alice <alice@example.org>', to: me.address, subject: 'Lunch' }), recipients: [me.rcpt()] });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mailbox.name).toBe('INBOX');
    expect(copies[0]?.verdict?.reasons).toContain(NO_SCRIPT_REASON);
  });

  it('fileinto "Receipts" with addflag "$Paid" files there with the flag; a message the rule misses is kept in INBOX', async () => {
    const me = await makeAccount('receipts');
    await activate(me.id, ['require ["fileinto", "imap4flags"];', 'if header :contains "subject" "invoice" {', '  addflag "$Paid";', '  fileinto "Receipts";', '}', ''].join('\r\n'));

    const hit = await deliver({ message: message({ from: 'Shop <billing@shop.example>', to: me.address, subject: 'Your invoice #42' }), recipients: [me.rcpt()] });
    expect(hit.copies).toHaveLength(1);
    expect(hit.copies[0]?.mailbox.name).toBe('Receipts');
    expect(hit.copies[0]?.flags).toContain('$Paid');
    expect(hit.copies[0]?.verdict?.bucket).toBe('receipts');
    expect(hit.copies[0]?.verdict?.reasons).toEqual(expect.arrayContaining(['sieve: ran "rules"', 'sieve fileinto "Receipts"', 'filed to Receipts']));
    const outcome = await sieveOutcome(hit.id, me.id);
    expect(outcome.deliveries).toEqual([expect.objectContaining({ kind: 'fileinto', mailbox: 'Receipts', flags: ['$Paid'], line: 4 })]);
    expect(outcome.trace.length).toBeGreaterThan(0);

    const miss = await deliver({ message: message({ from: 'Alice <alice@example.org>', to: me.address, subject: 'Lunch?' }), recipients: [me.rcpt()] });
    expect(miss.copies).toHaveLength(1);
    expect(miss.copies[0]?.mailbox.name).toBe('INBOX');
    expect(miss.copies[0]?.flags).not.toContain('$Paid');
  });

  it('fileinto a missing folder keeps the message unless :create is given', async () => {
    const me = await makeAccount('create');
    await activate(me.id, ['require ["fileinto", "mailbox"];', 'if header :is "subject" "a" { fileinto "Nowhere"; }', 'if header :is "subject" "b" { fileinto :create "Projects/New"; }', ''].join('\r\n'));
    const a = await deliver({ message: message({ from: 'x@example.org', to: me.address, subject: 'a' }), recipients: [me.rcpt()] });
    expect(a.copies.map((c) => c.mailbox.name)).toEqual(['INBOX']);
    expect(a.copies[0]?.verdict?.reasons.some((r) => r.includes('there is no such mailbox and no :create'))).toBe(true);
    const b = await deliver({ message: message({ from: 'x@example.org', to: me.address, subject: 'b' }), recipients: [me.rcpt()] });
    expect(b.copies.map((c) => c.mailbox.name)).toEqual(['Projects/New']);
  });

  it('vnd.postroom.bucket overrides the classifier', async () => {
    const me = await makeAccount('bucket');
    await activate(me.id, ['require "vnd.postroom.bucket";', 'if address :is "from" "friend@example.org" { bucket "newsletters"; }', ''].join('\r\n'));
    // A personal, directly-addressed message the classifier would keep in INBOX.
    const { copies } = await deliver({ message: message({ from: 'Friend <friend@example.org>', to: me.address, subject: 'Dinner tonight?' }), recipients: [me.rcpt()] });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mailbox.name).toBe('Newsletters');
    expect(copies[0]?.verdict?.bucket).toBe('newsletters');
    expect(copies[0]?.verdict?.reasons.some((r) => /sieve bucket "newsletters" overrides the classifier's (people|priority)/.test(r))).toBe(true);
  });

  it('refuses a redirect to a foreign address and keeps the message; a redirect to its own address delivers here — never relayed', async () => {
    const me = await makeAccount('redirect');
    const d = await db.domain.findUniqueOrThrow({ where: { name: 'd3cloud.io' } });
    await db.address.create({ data: { localPart: 'redirect-alt', domainId: d.id, kind: AddressKind.masked, accountId: me.id, siteTag: 'alt' } });
    await activate(me.id, ['if header :is "subject" "out" { redirect "someone@example.net"; }', 'if header :is "subject" "own" { redirect "redirect-alt@d3cloud.io"; }', ''].join('\r\n'));

    const out = await deliver({ message: message({ from: 'x@example.org', to: me.address, subject: 'out' }), recipients: [me.rcpt()] });
    expect(out.copies.map((c) => c.mailbox.name)).toEqual(['INBOX']);
    expect(out.copies[0]?.verdict?.reasons.some((r) => r.startsWith('sieve "rules" line 1: redirect to someone@example.net refused'))).toBe(true);
    const outOutcome = await sieveOutcome(out.id, me.id);
    expect(outOutcome.redirects).toEqual([expect.objectContaining({ address: 'someone@example.net', allowed: false })]);

    const own = await deliver({ message: message({ from: 'x@example.org', to: me.address, subject: 'own' }), recipients: [me.rcpt()] });
    expect(own.copies.map((c) => c.mailbox.name)).toEqual(['INBOX']);
    expect(own.copies[0]?.verdict?.reasons.some((r) => r.includes('never relayed'))).toBe(true);

    // Nothing left the building.
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(0);
  });

  it('discard files to Trash with its reason instead of deleting', async () => {
    const me = await makeAccount('discard');
    await activate(me.id, 'if header :contains "subject" "spam" { discard; }\r\n');
    const { copies } = await deliver({ message: message({ from: 'x@example.org', to: me.address, subject: 'more spam' }), recipients: [me.rcpt()] });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mailbox.specialUse).toBe('trash');
    expect(copies[0]?.verdict?.reasons.some((r) => r.includes('Postroom never deletes mail silently'))).toBe(true);
  });

  it('two recipient accounts each run their own script', async () => {
    const a = await makeAccount('multia');
    const b = await makeAccount('multib');
    await activate(a.id, 'require "fileinto";\r\nfileinto "Archive";\r\n');
    const { copies } = await deliver({ message: message({ from: 'x@example.org', to: `${a.address}, ${b.address}`, subject: 'both' }), recipients: [a.rcpt(), b.rcpt()] });
    const where = Object.fromEntries(copies.map((c) => [c.mailbox.accountId, c.mailbox.name]));
    expect(where[a.id]).toBe('Archive');
    expect(where[b.id]).toBe('INBOX');
  });

  it('vacation replies once per sender per :days through the submission path, never to a list, and never twice on a replay', async () => {
    const me = await makeAccount('away');
    await activate(me.id, ['require "vacation";', 'vacation :days 3 :subject "Away until Monday" "I am away; back on Monday.";', ''].join('\r\n'));
    const fromAlice = () => message({ from: 'Alice <alice@example.org>', to: me.address, subject: 'Question' });

    const first = await deliver({ message: fromAlice(), recipients: [me.rcpt()], envelopeFrom: 'alice@example.org' });
    expect(first.copies.map((c) => c.mailbox.name)).toEqual(['INBOX']);
    let replies = await vacationReplies(me.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.envelopeFrom).toBe('');
    expect(replies[0]?.headerFrom).toBe(me.address);
    expect(replies[0]?.subject).toBe('Away until Monday');
    expect(replies[0]?.recipients.map((r) => r.address)).toEqual(['alice@example.org']);
    expect((await sieveOutcome(first.id, me.id)).vacation).toMatchObject({ respond: true, sent: true });
    const raw = (await blobs.getBuffer(replies[0]?.blobSha256 ?? '')).toString('utf8');
    expect(raw).toMatch(/^Auto-Submitted: auto-replied/m);
    expect(raw).toMatch(/^In-Reply-To: <[^>]+@example\.org>/m);
    expect(raw).toMatch(/^DKIM-Signature:/m);

    // A replay of the sieve stage re-runs the script but sends nothing new.
    await pipeline.run(first.id, { replayFrom: 'sieve' });
    expect(await vacationReplies(me.id)).toHaveLength(1);
    expect((await sieveOutcome(first.id, me.id)).vacation).toMatchObject({ sent: true, reason: 'already sent for this message (a replay sends nothing new)' });
    expect(await copiesOf(first.id)).toHaveLength(1);

    // The same sender within :days: suppressed, and the verdict says why.
    const second = await deliver({ message: fromAlice(), recipients: [me.rcpt()], envelopeFrom: 'alice@example.org' });
    expect(await vacationReplies(me.id)).toHaveLength(1);
    expect((await sieveOutcome(second.id, me.id)).vacation).toMatchObject({ respond: false, sent: false });

    // A mailing list never gets one.
    await deliver({
      message: message({ from: 'List <list@lists.example.org>', to: me.address, subject: 'Digest', headers: ['List-Id: <digest.lists.example.org>'] }),
      recipients: [me.rcpt()],
      envelopeFrom: 'list-bounces@lists.example.org',
    });
    expect(await vacationReplies(me.id)).toHaveLength(1);

    // After :days, the same sender gets another.
    clock.advance(3 * DAY_MS + 60_000);
    await deliver({ message: fromAlice(), recipients: [me.rcpt()], envelopeFrom: 'alice@example.org' });
    replies = await vacationReplies(me.id);
    expect(replies).toHaveLength(2);
    expect(await db.sieveVacationReply.count({ where: { accountId: me.id } })).toBe(2);
    // Every reply is audited as a submission.
    expect(await db.auditEvent.count({ where: { action: 'submission.accept', actorAccountId: me.id } })).toBe(2);
  });

  it('no vacation reply to mail the classifier put in Junk', async () => {
    const me = await makeAccount('awayjunk');
    await activate(me.id, 'require "vacation";\r\nvacation "away";\r\n');
    const { id, copies } = await (async () => {
      const { id: spooled } = await spool(db, blobs, {
        message: message({ from: 'Bob <bob@example.org>', to: me.address, subject: 'hi' }),
        recipients: [me.rcpt()],
        envelopeFrom: 'bob@example.org',
        disposition: 'quarantine',
      });
      await pipeline.run(spooled);
      return { id: spooled, copies: await copiesOf(spooled) };
    })();
    expect(copies[0]?.mailbox.specialUse).toBe('junk');
    expect(await vacationReplies(me.id)).toHaveLength(0);
    expect((await sieveOutcome(id, me.id)).vacation?.reason).toMatch(/^suppressed: the message was (filed as junk|quarantined)/);
  });
});
