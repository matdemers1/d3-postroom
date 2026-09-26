// PST-T-9.1 against a real database and a real (encrypted) blob store, with a controllable clock:
//   PST-REQ-140  undo send — held for the window, nothing queued; after it, exactly one outbound
//                message, the Drafts copy gone and the Sent copy filed; an undone send never goes.
//   PST-REQ-141  scheduled send — released between T and T + 60 s, never before T; a crash inside the
//                accepting transaction, a retry and two racing releases still make exactly one send.
//   PST-REQ-142  snooze — the snoozed fixture comes back to INBOX at `until`, unread, IMAP-visibly
//                (expunged_message in Snoozed, new UIDs in INBOX, pg_notify on both).
//   PST-REQ-143  remind-if-no-reply — resurfaced only when nobody replied, never when a reply arrived;
//                never a second delivery.
import { randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { CapExceededError } from '@postroom/submission';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { assignThread } from '@postroom/threading';
import { checkDue, releaseDue, releaseOne, returnDue, REMIND_FLAGS, type ReleaseDeps } from '../../src/scheduled/index.js';
import { ensureMailbox, MAILBOX_CHANNEL, moveMessages, SNOOZED_MAILBOX } from '../../src/scheduled/mailbox.js';
import { Clock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', fn: (n: { channel: string; payload?: string }) => void): unknown;
  end(): Promise<unknown>;
}
const requireFromDb = createRequire(import.meta.resolve('@postroom/db/testing'));
const { Client } = requireFromDb('pg') as { Client: new (opts: { connectionString: string }) => ListenClient };

const hasBareLf = (b: Buffer): boolean => /(?<!\r)\n/.test(b.toString('latin1'));

describe.skipIf(baseUrl === undefined)('scheduled loop (PST-T-9.1)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let kek: Kek;
  let blobRoot = '';
  const clock = new Clock();
  let listener: ListenClient;
  const notified: string[] = [];
  let deps: ReleaseDeps;

  interface Person {
    id: string;
    address: string;
    box: Record<'INBOX' | 'Sent' | 'Drafts', string>;
  }

  const person = async (): Promise<Person> => {
    const login = `u${randomUUID().slice(0, 8)}`;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    const account = await db.account.create({ data: { displayName: login } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    const box: Record<string, string> = {};
    for (const m of DEFAULT_MAILBOXES) {
      box[m.name] = (await db.mailbox.create({ data: { accountId: account.id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } })).id;
    }
    return { id: account.id, address: `${login}@d3cloud.io`, box };
  };

  const rawMessage = (o: { from: string; to: string; subject: string; messageId: string; bcc?: string; inReplyTo?: string }): Buffer =>
    Buffer.from(
      [
        `From: ${o.from}`,
        `To: ${o.to}`,
        ...(o.bcc === undefined ? [] : [`Bcc: ${o.bcc}`]),
        `Subject: ${o.subject}`,
        'Date: Sat, 26 Sep 2026 10:00:00 +0000',
        `Message-ID: ${o.messageId}`,
        ...(o.inReplyTo === undefined ? [] : [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`]),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Body of ${o.subject}`,
        '',
      ].join('\r\n'),
    );

  /** What POST /api/compose/send with undoSeconds/sendAt writes: the held blob, a Drafts copy, the row. */
  const hold = async (me: Person, o: { releaseAt: Date; kind?: 'undo' | 'scheduled'; subject?: string; remindAfterSeconds?: number; inReplyTo?: string }) => {
    const subject = o.subject ?? `Held ${randomUUID().slice(0, 6)}`;
    const messageId = `<${randomUUID()}@d3cloud.io>`;
    const base = { from: me.address, to: 'alice@example.org', subject, messageId, ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo }) };
    const held = await blobs.put(rawMessage(base));
    const draftBlob = await blobs.put(rawMessage({ ...base, bcc: 'secret@example.org' }));
    const draft = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'Drafts', blobSha256: draftBlob.sha256, size: draftBlob.size, internalDate: clock.now(), flags: ['\\Draft', '\\Seen'] }));
    await db.messageSearch.create({ data: { messageId: draft.id, accountId: me.id, subject, bodyText: `Body of ${subject}` } });
    return db.pendingSend.create({
      data: {
        accountId: me.id,
        kind: o.kind ?? 'undo',
        releaseAt: o.releaseAt,
        envelopeFrom: me.address,
        recipients: ['alice@example.org', 'secret@example.org'],
        heldBlobSha256: held.sha256,
        size: held.size,
        draftMessageId: draft.id,
        messageIdHeader: messageId,
        subject,
        toText: 'alice@example.org',
        ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo, references: [o.inReplyTo] }),
        ...(o.remindAfterSeconds === undefined ? {} : { remindAfterSeconds: o.remindAfterSeconds }),
      },
    });
  };

  const outboundFor = (me: Person, messageId: string) => db.outboundMessage.findMany({ where: { accountId: me.id, messageId }, include: { recipients: true } });

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t91_worker');
    db = t.db;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t91-blobs-'));
    kek = generateKek();
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    deps = { db, blobs, kek: () => kek, caps: () => Promise.resolve(), now: clock.now };
    listener = new Client({ connectionString: t.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === MAILBOX_CHANNEL && n.payload !== undefined) notified.push(n.payload);
    });
    await listener.query(`LISTEN ${MAILBOX_CHANNEL}`);
  }, 120_000);

  afterAll(async () => {
    await listener.end();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  // --- PST-REQ-140 ----------------------------------------------------------------------------------

  it('undo send: inside the window nothing is queued and the message is in Drafts; after it, exactly one outbound message', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: new Date(clock.now().getTime() + 10_000) });

    await releaseDue(deps);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);

    clock.advance(10_000);
    const counts = await releaseDue(deps);
    expect(counts.released).toBe(1);
    const out = await outboundFor(me, pending.messageIdHeader);
    expect(out).toHaveLength(1);
    // Bcc is an envelope recipient, never a header.
    expect(out[0]?.recipients.map((r) => r.address).sort()).toEqual(['alice@example.org', 'secret@example.org']);
    const queued = await blobs.getBuffer(out[0]?.blobSha256 ?? '');
    expect(queued.toString('latin1')).toMatch(/^DKIM-Signature:/);
    expect(queued.toString('latin1')).not.toContain('Bcc:');
    expect(hasBareLf(queued)).toBe(false);

    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.state).toBe('released');
    expect(row.outboundId).toBe(out[0]?.id);
    // The Drafts copy is gone (IMAP-visibly), the Sent copy is filed from the queued blob.
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '' } })).toBe(0);
    expect(await db.expungedMessage.count({ where: { mailboxId: me.box.Drafts } })).toBe(1);
    const sent = await db.message.findUniqueOrThrow({ where: { id: row.sentMessageId ?? '' } });
    expect(sent.mailboxId).toBe(me.box.Sent);
    expect(sent.blobSha256).toBe(out[0]?.blobSha256);
    expect(sent.threadId).not.toBeNull();
    // The held blob's only reference went with the release.
    expect(await db.blob.findUnique({ where: { sha256: pending.heldBlobSha256 } })).toBeNull();
    const audits = await db.auditEvent.findMany({ where: { entityId: pending.id, action: 'compose.release' } });
    expect(audits).toHaveLength(1);

    // Running again changes nothing.
    await releaseDue(deps);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(1);
  });

  it('an undone send (cancelled while held) is never released, and its draft stays in Drafts', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: new Date(clock.now().getTime() + 5_000) });
    await db.pendingSend.update({ where: { id: pending.id }, data: { state: 'cancelled', reason: 'undone' } });
    clock.advance(60_000);
    await releaseDue(deps);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
  });

  it('removing the Drafts copy from any client cancels the send', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: new Date(clock.now().getTime() + 5_000) });
    await db.message.delete({ where: { id: pending.draftMessageId ?? '' } });
    clock.advance(5_000);
    const counts = await releaseDue(deps);
    expect(counts.cancelled).toBe(1);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.state).toBe('cancelled');
    expect(row.reason).toMatch(/draft/);
  });

  // --- PST-REQ-141 ----------------------------------------------------------------------------------

  it('scheduled send: not before T; released between T and T + 60 s by the 15 s tick', async () => {
    const me = await person();
    const T = new Date(clock.now().getTime() + 3_600_000);
    const pending = await hold(me, { releaseAt: T, kind: 'scheduled' });
    clock.offsetMs = T.getTime() - Date.now() - 1_000;
    await releaseDue(deps);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    // The next tick, 15 s later, is the first one at or after T.
    clock.advance(15_000);
    await releaseDue(deps);
    const out = await outboundFor(me, pending.messageIdHeader);
    expect(out).toHaveLength(1);
    const created = out[0]?.createdAt.getTime() ?? 0;
    const released = (await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).finishedAt?.getTime() ?? 0;
    expect(released).toBeGreaterThanOrEqual(T.getTime());
    expect(released).toBeLessThanOrEqual(T.getTime() + 60_000);
    expect(created).toBeGreaterThan(0);
  });

  it('crash-safe: a crash inside the accepting transaction sends nothing, the retry sends once, and two racing releases send once', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now() });
    await expect(
      releaseOne(
        {
          ...deps,
          beforeCommit: () => {
            throw new Error('kill -9');
          },
        },
        pending.id,
      ),
    ).rejects.toThrow('kill -9');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect((await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('held');
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '' } })).toBe(1);

    const outcomes = await Promise.all([releaseOne(deps, pending.id), releaseOne(deps, pending.id), releaseOne(deps, pending.id)]);
    expect(outcomes.filter((o) => o === 'released')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(1);
    expect(await releaseOne(deps, pending.id)).toBe('skipped');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(1);
    expect(await db.message.count({ where: { mailboxId: me.box.Sent, messageIdHeader: pending.messageIdHeader.slice(1, -1) } })).toBe(1);
  });

  it('a refusal at release time (the recipient cap) fails it visibly and keeps the draft', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now() });
    const capped: ReleaseDeps = {
      ...deps,
      caps: () => {
        throw new CapExceededError({ code: 452, enhanced: '4.5.3', lines: ['Recipient cap reached'] });
      },
    };
    expect(await releaseOne(capped, pending.id)).toBe('failed');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.state).toBe('failed');
    expect(row.reason).toMatch(/cap-exceeded/);
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
  });

  // --- PST-REQ-142 ----------------------------------------------------------------------------------

  const inbound = async (me: Person, o: { subject: string; messageId: string; inReplyTo?: string; from?: string; receivedAt?: Date; seen?: boolean }) => {
    const raw = rawMessage({ from: o.from ?? 'alice@example.org', to: me.address, subject: o.subject, messageId: o.messageId, ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo }) });
    const put = await blobs.put(raw);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: clock.now(), flags: o.seen === true ? ['\\Seen'] : [] }));
    await db.message.update({
      where: { id: filed.id },
      data: {
        messageIdHeader: o.messageId.slice(1, -1),
        subject: o.subject,
        fromAddress: o.from ?? 'alice@example.org',
        sentAt: clock.now(),
        ...(o.receivedAt === undefined ? {} : { receivedAt: o.receivedAt }),
        ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo.slice(1, -1), references: [o.inReplyTo.slice(1, -1)] }),
      },
    });
    const threadId = await assignThread(db, {
      accountId: me.id,
      messageId: filed.id,
      messageIdHeader: o.messageId,
      ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo }),
      references: o.inReplyTo === undefined ? [] : [o.inReplyTo],
      subject: o.subject,
      from: o.from ?? 'alice@example.org',
      to: me.address,
      date: clock.now(),
    });
    return { ...filed, threadId };
  };

  it('snooze: the snoozed fixture comes back to INBOX at `until`, unread, with EXPUNGE in Snoozed and EXISTS in INBOX', async () => {
    const me = await person();
    const first = await inbound(me, { subject: 'Snooze me', messageId: `<${randomUUID()}@example.org>`, seen: true });
    const second = await inbound(me, { subject: 'Re: Snooze me', messageId: `<${randomUUID()}@example.org>`, inReplyTo: `<${(await db.message.findUniqueOrThrow({ where: { id: first.id } })).messageIdHeader ?? ''}>`, seen: true });
    expect(second.threadId).toBe(first.threadId);
    const inbox = me.box.INBOX;
    // What POST /api/threads/:id/snooze does (apps/api/src/mail/snooze.ts, the same move).
    const until = new Date(clock.now().getTime() + 3_600_000);
    const snoozedBox = await db.$transaction(async (tx) => {
      const box = await ensureMailbox(tx, me.id, SNOOZED_MAILBOX, null);
      await moveMessages(tx, { sourceId: inbox, targetId: box, messageIds: [first.id, second.id], clearSeen: false });
      await tx.snoozedThread.create({ data: { accountId: me.id, threadId: first.threadId, until, messageIds: [first.id, second.id] } });
      return box;
    });
    expect(await db.message.count({ where: { mailboxId: inbox } })).toBe(0);

    clock.offsetMs = until.getTime() - Date.now() - 1_000;
    expect(await returnDue({ db, now: clock.now })).toBe(0);
    expect(await db.message.count({ where: { mailboxId: snoozedBox } })).toBe(2);

    const snoozedUids = (await db.message.findMany({ where: { mailboxId: snoozedBox }, select: { uid: true } })).map((m) => m.uid).sort();
    const inboxBefore = await db.mailbox.findUniqueOrThrow({ where: { id: inbox } });
    notified.length = 0;
    clock.advance(15_000);
    expect(await returnDue({ db, now: clock.now })).toBe(1);

    const back = await db.message.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(back.map((m) => m.mailboxId)).toEqual([inbox, inbox]);
    for (const m of back) {
      expect(m.flags).not.toContain('\\Seen');
      expect(m.uid).toBeGreaterThanOrEqual(inboxBefore.uidnext);
      expect(m.modseq).toBeGreaterThan(inboxBefore.highestModseq);
    }
    // EXPUNGE / VANISHED in Snoozed for exactly the UIDs that left.
    const expunged = (await db.expungedMessage.findMany({ where: { mailboxId: snoozedBox } })).map((e) => e.uid).sort();
    expect(expunged).toEqual(snoozedUids);
    await new Promise((r) => setTimeout(r, 200));
    expect(notified).toEqual(expect.arrayContaining([inbox, snoozedBox]));
    const row = await db.snoozedThread.findFirstOrThrow({ where: { accountId: me.id } });
    expect(row.state).toBe('returned');
    expect(await db.auditEvent.count({ where: { action: 'thread.snooze-return', entityId: first.threadId } })).toBe(1);
    // Exactly once.
    expect(await returnDue({ db, now: clock.now })).toBe(0);
  });

  // --- PST-REQ-143 ----------------------------------------------------------------------------------

  it('remind-if-no-reply: with no reply, the sent message resurfaces in INBOX unread ($Remind), from the same blob, and nothing is delivered', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now(), remindAfterSeconds: 3_600 });
    expect(await releaseOne(deps, pending.id)).toBe('released');
    const reminder = await db.replyReminder.findFirstOrThrow({ where: { accountId: me.id } });
    const sent = await db.message.findUniqueOrThrow({ where: { id: reminder.sentMessageId } });
    const refsBefore = (await db.blob.findUniqueOrThrow({ where: { sha256: sent.blobSha256 } })).refcount;
    const outboundBefore = await db.outboundMessage.count({ where: { accountId: me.id } });

    // Not yet due.
    clock.advance(3_000_000);
    expect((await checkDue({ db, now: clock.now })).resurfaced).toBe(0);
    clock.advance(700_000);
    expect((await checkDue({ db, now: clock.now })).resurfaced).toBe(1);

    const row = await db.replyReminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(row.state).toBe('resurfaced');
    const copy = await db.message.findUniqueOrThrow({ where: { id: row.resurfacedMessageId ?? '' } });
    expect(copy.mailboxId).toBe(me.box.INBOX);
    expect(copy.flags).toEqual([...REMIND_FLAGS]);
    expect(copy.flags).not.toContain('\\Seen');
    expect(copy.blobSha256).toBe(sent.blobSha256);
    expect(copy.threadId).toBe(sent.threadId);
    expect((await db.blob.findUniqueOrThrow({ where: { sha256: sent.blobSha256 } })).refcount).toBe(refsBefore + 1);
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(outboundBefore);
    // Once.
    expect((await checkDue({ db, now: clock.now })).resurfaced).toBe(0);
  });

  it('remind-if-no-reply: a reply in the thread means no reminder', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now(), remindAfterSeconds: 3_600 });
    expect(await releaseOne(deps, pending.id)).toBe('released');
    const reminder = await db.replyReminder.findFirstOrThrow({ where: { accountId: me.id } });
    await inbound(me, { subject: 'Re: reply', messageId: `<${randomUUID()}@example.org>`, inReplyTo: pending.messageIdHeader, receivedAt: new Date(reminder.sentAt.getTime() + 60_000) });
    clock.advance(3_700_000);
    const counts = await checkDue({ db, now: clock.now });
    expect(counts.replied).toBe(1);
    expect(counts.resurfaced).toBe(0);
    const row = await db.replyReminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(row.state).toBe('replied');
    expect(await db.message.count({ where: { mailboxId: me.box.INBOX, flags: { has: '$Remind' } } })).toBe(0);
  });

  it('remind-if-no-reply: my own follow-up in the thread is not a reply', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now(), remindAfterSeconds: 60 });
    expect(await releaseOne(deps, pending.id)).toBe('released');
    const reminder = await db.replyReminder.findFirstOrThrow({ where: { accountId: me.id } });
    await inbound(me, { subject: 'Re: bump', messageId: `<${randomUUID()}@d3cloud.io>`, inReplyTo: pending.messageIdHeader, from: me.address, receivedAt: new Date(reminder.sentAt.getTime() + 10_000) });
    clock.advance(120_000);
    expect((await checkDue({ db, now: clock.now })).resurfaced).toBe(1);
  });
});
