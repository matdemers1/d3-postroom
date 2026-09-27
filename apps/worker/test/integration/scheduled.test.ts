// PST-T-9.1 against a real database and a real (encrypted) blob store, with a controllable clock:
//   PST-REQ-140  undo send — held for the window, nothing queued; after it, exactly one outbound
//                message, the Drafts copy gone and the Sent copy filed; an undone send never goes.
//   PST-REQ-141  scheduled send — released between T and T + 60 s, never before T; a crash inside the
//                accepting transaction, a retry and two racing releases still make exactly one send.
//   PST-REQ-142  snooze — the snoozed fixture comes back to INBOX at `until`, unread, IMAP-visibly
//                (expunged_message in Snoozed, new UIDs in INBOX, pg_notify on both).
//   PST-REQ-143  remind-if-no-reply — resurfaced only when nobody replied, never when a reply arrived;
//                never a second delivery.
//   PST-REQ-161  (PST-T-12.7) a held send with several copies — main, one per Bcc, a Sent copy —
//                releases them in one transaction, each to its own envelope, exactly once and all or
//                nothing; an undo releases every copy's blob; a row with no copies releases as before.
//   PST-REQ-140  (PST-T-9.6) the further copies' contact harvest and 'accepted' log lines run after the
//                release commits, so a harvest SQL error never aborts it; a cap refusal on a later copy
//                alerts only once the release's transaction, and its caps advisory lock, has ended.
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
import type { Prisma } from '@postroom/db';
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
    t = await createTestDatabase(baseUrl ?? '', 'pst_t96_worker');
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

  it('undo racing the release tick: exactly one wins — never an undone message that was also sent', async () => {
    for (let round = 0; round < 8; round++) {
      const me = await person();
      const pending = await hold(me, { releaseAt: clock.now() });
      // The same conditional transition the API's cancelHeld makes (apps/api/src/compose/store.ts).
      const undo = db.pendingSend
        .updateMany({ where: { id: pending.id, state: 'held' }, data: { state: 'cancelled', reason: 'undone', finishedAt: clock.now() } })
        .then((n) => (n.count === 1 ? 'undone' : 'too-late'));
      const [undone, ...releases] = await Promise.all([undo, releaseOne(deps, pending.id), releaseOne(deps, pending.id)]);
      const sent = await outboundFor(me, pending.messageIdHeader);
      const state = (await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state;
      if (undone === 'undone') {
        expect(releases.every((r) => r === 'skipped')).toBe(true);
        expect(sent).toHaveLength(0);
        expect(state).toBe('cancelled');
      } else {
        expect(releases.filter((r) => r === 'released')).toHaveLength(1);
        expect(sent).toHaveLength(1);
        expect(state).not.toBe('cancelled');
      }
    }
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

  it('PST-T-11.10: a recipient suppressed while the send was held fails it with recipient-suppressed, naming the suppression', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now() });
    // PST-REQ-179: listed after the hold (a hard bounce from another message, or an admin).
    const listed = await db.suppressedRecipient.create({ data: { address: 'secret@example.org', reason: 'hard-bounce', code: 550, enhanced: '5.1.1', text: 'No such user' } });
    try {
      expect(await releaseOne(deps, pending.id)).toBe('failed');
      expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
      const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
      expect(row.state).toBe('failed');
      expect(row.reason).toMatch(/^recipient-suppressed: secret@example\.org is on this server's suppression list \(after a hard bounce\)/);
      expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
    } finally {
      await db.suppressedRecipient.delete({ where: { id: listed.id } });
    }
  });

  // --- PST-T-12.7: a held send with several copies (an encrypted send with Bcc) -----------------------

  /**
   * What POST /api/compose/send writes for a held encrypted send with Bcc: the held blob (the main
   * copy), one pending_send_copy per copy — main (To alice), bcc (bob), bcc (carol) — each holding
   * its own blob reference. `bccOnly` holds no main copy: a 'sent' copy for Sent, and the Bcc copies.
   */
  const holdCopies = async (me: Person, o: { releaseAt: Date; bccOnly?: boolean }) => {
    const subject = `Copies ${randomUUID().slice(0, 6)}`;
    const messageId = `<${randomUUID()}@d3cloud.io>`;
    const base = { from: me.address, to: 'alice@example.org', subject, messageId };
    const mainRaw = rawMessage({ ...base, subject: `${subject} [main]` });
    const bobRaw = rawMessage({ ...base, subject: `${subject} [bob]` });
    const carolRaw = rawMessage({ ...base, subject: `${subject} [carol]` });
    const held = await blobs.put(mainRaw);
    const draftBlob = await blobs.put(rawMessage({ ...base, bcc: 'bob@example.org, carol@example.org' }));
    const draft = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'Drafts', blobSha256: draftBlob.sha256, size: draftBlob.size, internalDate: clock.now(), flags: ['\\Draft', '\\Seen'] }));
    const copies = [
      o.bccOnly === true ? { role: 'sent', recipients: [] as string[], raw: mainRaw } : { role: 'main', recipients: ['alice@example.org'], raw: mainRaw },
      { role: 'bcc', recipients: ['bob@example.org'], raw: bobRaw },
      { role: 'bcc', recipients: ['carol@example.org'], raw: carolRaw },
    ];
    const pending = await db.pendingSend.create({
      data: {
        accountId: me.id,
        kind: 'undo',
        releaseAt: o.releaseAt,
        envelopeFrom: me.address,
        recipients: [...(o.bccOnly === true ? [] : ['alice@example.org']), 'bob@example.org', 'carol@example.org'],
        heldBlobSha256: held.sha256,
        size: held.size,
        draftMessageId: draft.id,
        messageIdHeader: messageId,
        subject,
        toText: o.bccOnly === true ? '' : 'alice@example.org',
      },
    });
    const shas: string[] = [held.sha256];
    for (const [position, c] of copies.entries()) {
      const put = await blobs.put(c.raw);
      shas.push(put.sha256);
      await db.pendingSendCopy.create({ data: { pendingSendId: pending.id, role: c.role, position, recipients: c.recipients, blobSha256: put.sha256, size: put.size } });
    }
    return { pending, shas: [...new Set(shas)], subject };
  };

  /** The API's cancelHeld (apps/api/src/compose/store.ts): conditional on held, then every blob reference released. */
  const undoHeld = (id: string) =>
    db.$transaction(async (tx) => {
      const n = await tx.pendingSend.updateMany({ where: { id, state: 'held' }, data: { state: 'cancelled', reason: 'undone', finishedAt: clock.now() } });
      if (n.count === 0) return 'too-late' as const;
      const row = await tx.pendingSend.findUniqueOrThrow({ where: { id }, include: { copies: true } });
      for (const sha of [row.heldBlobSha256, ...row.copies.map((c) => c.blobSha256)]) await blobs.release(sha, tx);
      return 'undone' as const;
    });

  const envelopes = async (me: Person, messageId: string) =>
    (await outboundFor(me, messageId)).map((o) => ({ to: o.recipients.map((r) => r.address).sort(), sha: o.blobSha256 })).sort((a, b) => (a.to[0] ?? '').localeCompare(b.to[0] ?? ''));

  it('several copies release together: main to alice only, each Bcc copy only to its own recipient, Sent keeps the main copy, every reference released', async () => {
    const me = await person();
    const { pending, shas, subject } = await holdCopies(me, { releaseAt: clock.now() });
    const refsBefore = await db.blob.findMany({ where: { sha256: { in: shas } }, select: { sha256: true, refcount: true } });
    // The held blob and the main copy are the same bytes: one blob, two references (the row's, the copy's).
    expect(refsBefore.map((r) => r.refcount).sort()).toEqual([1, 1, 2]);

    expect(await releaseOne(deps, pending.id)).toBe('released');
    const out = await envelopes(me, pending.messageIdHeader);
    expect(out.map((o) => o.to)).toEqual([['alice@example.org'], ['bob@example.org'], ['carol@example.org']]);
    const bytes = await Promise.all(out.map(async (o) => (await blobs.getBuffer(o.sha)).toString('latin1')));
    expect(bytes[0]).toContain(`Subject: ${subject} [main]`);
    expect(bytes[1]).toContain(`Subject: ${subject} [bob]`);
    expect(bytes[2]).toContain(`Subject: ${subject} [carol]`);
    for (const b of bytes) expect(b).toMatch(/^DKIM-Signature:/);

    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id }, include: { copies: { orderBy: { position: 'asc' } } } });
    expect(row.state).toBe('released');
    expect(row.copies.map((c) => c.outboundId)).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(row.copies.every((c) => c.outboundId !== null)).toBe(true);
    expect(row.outboundId).toBe(row.copies[0]?.outboundId);
    // Sent keeps the main copy as queued — once.
    const sent = await db.message.findUniqueOrThrow({ where: { id: row.sentMessageId ?? '' } });
    expect(sent.mailboxId).toBe(me.box.Sent);
    expect(sent.blobSha256).toBe(out[0]?.sha);
    expect(await db.message.count({ where: { mailboxId: me.box.Sent } })).toBe(1);
    // Every held reference went with the release: no held blob is left.
    expect(await db.blob.count({ where: { sha256: { in: shas } } })).toBe(0);
    // One submission.accept per copy; one compose.release naming them.
    expect(await db.auditEvent.count({ where: { action: 'submission.accept', entityId: { in: row.copies.map((c) => c.outboundId ?? '') } } })).toBe(3);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: pending.id, action: 'compose.release' } });
    expect(JSON.stringify(audit.after)).toContain('"copies"');
    // Again: nothing more.
    expect(await releaseOne(deps, pending.id)).toBe('skipped');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(3);
  });

  it('a Bcc-only send: only the Bcc copies are queued, and Sent keeps the copy held for it', async () => {
    const me = await person();
    const { pending, shas } = await holdCopies(me, { releaseAt: clock.now(), bccOnly: true });
    const sentSha = (await db.pendingSendCopy.findFirstOrThrow({ where: { pendingSendId: pending.id, role: 'sent' } })).blobSha256;
    expect(await releaseOne(deps, pending.id)).toBe('released');
    const out = await envelopes(me, pending.messageIdHeader);
    expect(out.map((o) => o.to)).toEqual([['bob@example.org'], ['carol@example.org']]);
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    const sent = await db.message.findUniqueOrThrow({ where: { id: row.sentMessageId ?? '' } });
    expect(sent.blobSha256).toBe(sentSha);
    // The Sent copy keeps its blob; every other held reference is gone.
    expect((await db.blob.findUniqueOrThrow({ where: { sha256: sentSha } })).refcount).toBe(1);
    expect(await db.blob.count({ where: { sha256: { in: shas.filter((s) => s !== sentSha) } } })).toBe(0);
  });

  it('undo of a multi-copy send: nothing queued, every blob reference released', async () => {
    const me = await person();
    const { pending, shas } = await holdCopies(me, { releaseAt: new Date(clock.now().getTime() + 10_000) });
    expect(await undoHeld(pending.id)).toBe('undone');
    clock.advance(10_000);
    await releaseDue(deps);
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect(await db.blob.count({ where: { sha256: { in: shas } } })).toBe(0);
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
  });

  it('multi-copy: undo racing the release tick — exactly one wins, and never some copies sent and others not', async () => {
    for (let round = 0; round < 8; round++) {
      const me = await person();
      const { pending, shas } = await holdCopies(me, { releaseAt: clock.now() });
      const [undone, ...releases] = await Promise.all([undoHeld(pending.id), releaseOne(deps, pending.id), releaseOne(deps, pending.id)]);
      const sent = await outboundFor(me, pending.messageIdHeader);
      const state = (await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state;
      if (undone === 'undone') {
        expect(releases.every((r) => r === 'skipped')).toBe(true);
        expect(sent).toHaveLength(0);
        expect(state).toBe('cancelled');
      } else {
        expect(releases.filter((r) => r === 'released')).toHaveLength(1);
        expect(sent).toHaveLength(3);
        expect(state).toBe('released');
      }
      // Either way every held reference was released exactly once: none left over, none double-freed.
      expect(await db.blob.count({ where: { sha256: { in: shas } } })).toBe(0);
    }
  });

  it('multi-copy crash-safe: a crash inside the accepting transaction queues no copy; three racing releases queue each copy once', async () => {
    const me = await person();
    const { pending } = await holdCopies(me, { releaseAt: clock.now() });
    await expect(releaseOne({ ...deps, beforeCommit: () => Promise.reject(new Error('kill -9')) }, pending.id)).rejects.toThrow('kill -9');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect((await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('held');
    expect(await db.pendingSendCopy.count({ where: { pendingSendId: pending.id, outboundId: { not: null } } })).toBe(0);

    const outcomes = await Promise.all([releaseOne(deps, pending.id), releaseOne(deps, pending.id), releaseOne(deps, pending.id)]);
    expect(outcomes.filter((o) => o === 'released')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    const out = await envelopes(me, pending.messageIdHeader);
    expect(out.map((o) => o.to)).toEqual([['alice@example.org'], ['bob@example.org'], ['carol@example.org']]);
    expect(await db.message.count({ where: { mailboxId: me.box.Sent } })).toBe(1);
  });

  it('multi-copy all or nothing: a refusal of one Bcc copy fails the whole send — no copy is queued, the draft stays', async () => {
    const me = await person();
    const { pending, shas } = await holdCopies(me, { releaseAt: clock.now() });
    const capped: ReleaseDeps = {
      ...deps,
      caps: (_tx, _account, recipients) => (recipients.length === 1 && recipients[0] === 'carol@example.org' ? Promise.reject(new CapExceededError({ code: 452, enhanced: '4.5.3', lines: ['Recipient cap reached'] })) : Promise.resolve()),
    };
    expect(await releaseOne(capped, pending.id)).toBe('failed');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.state).toBe('failed');
    expect(row.reason).toMatch(/cap-exceeded.*carol@example\.org/);
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
    expect(await db.message.count({ where: { mailboxId: me.box.Sent } })).toBe(0);
    expect(await db.blob.count({ where: { sha256: { in: shas } } })).toBe(0);
  });

  // --- PST-T-9.6: the copies' post-commit effects wait for the release's own commit ----------------

  type Logged = { event: string; fields: Record<string, unknown> | undefined };

  /**
   * `base`, except that the contact harvest's first read (ownAddresses: address.findMany with an OR)
   * runs a failing statement first — on the transaction it is called in, when it is called in one,
   * which aborts that transaction just as a real SQL error in there would.
   */
  const failingHarvestReads = (base: Db, failures: { n: number }): Db => {
    type Raw = { $queryRawUnsafe(q: string): Promise<unknown> };
    const wrap = <T extends object>(client: T, raw: Raw): T =>
      new Proxy(client, {
        get(target, prop, receiver): unknown {
          if (prop === 'address') {
            const model = Reflect.get(target, prop, receiver) as Db['address'];
            return new Proxy(model, {
              get(m, p, r): unknown {
                if (p !== 'findMany') return Reflect.get(m, p, r) as unknown;
                return async (args: Parameters<Db['address']['findMany']>[0]) => {
                  if (args?.where?.OR !== undefined) {
                    failures.n++;
                    await raw.$queryRawUnsafe('SELECT 1/0');
                  }
                  return m.findMany(args);
                };
              },
            });
          }
          if (prop === '$transaction') {
            return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) =>
              (target as unknown as Db).$transaction((tx) => fn(wrap(tx, tx)), opts as never);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    return wrap(base, base as unknown as Raw);
  };

  it('multi-copy: a SQL error in the harvest reads never aborts the release — released once, every copy queued, the failure logged', async () => {
    const me = await person();
    const { pending } = await holdCopies(me, { releaseAt: clock.now() });
    const logged: Logged[] = [];
    const failures = { n: 0 };
    const faulty: ReleaseDeps = { ...deps, db: failingHarvestReads(db, failures), log: (event, fields) => void logged.push({ event, fields }) };

    expect(await releaseOne(faulty, pending.id)).toBe('released');
    const out = await envelopes(me, pending.messageIdHeader);
    expect(out.map((o) => o.to)).toEqual([['alice@example.org'], ['bob@example.org'], ['carol@example.org']]);
    expect((await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('released');
    // The harvest did read, did fail — for the accepting copy and for each further one — and said so.
    expect(failures.n).toBeGreaterThanOrEqual(3);
    const harvestFailed = logged.filter((l) => l.event === 'contacts-harvest-failed').map((l) => l.fields?.['session']);
    expect(harvestFailed).toEqual(expect.arrayContaining([`pending:${pending.id}`, `pending:${pending.id}:1`, `pending:${pending.id}:2`]));
    expect(logged.map((l) => l.event)).toContain('pending-send-released');
    // Exactly once.
    expect(await releaseOne(faulty, pending.id)).toBe('skipped');
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(3);
  });

  it("multi-copy: the copies' 'accepted' log lines come only after the release commits", async () => {
    const me = await person();
    const { pending } = await holdCopies(me, { releaseAt: clock.now() });
    const order: string[] = [];
    const traced: ReleaseDeps = {
      ...deps,
      log: (event, fields) => void order.push(`${event}:${typeof fields?.['session'] === 'string' ? fields['session'] : ''}`),
      beforeCommit: () => {
        order.push('before-commit');
        return Promise.resolve();
      },
    };
    expect(await releaseOne(traced, pending.id)).toBe('released');
    const commit = order.indexOf('before-commit');
    expect(commit).toBeGreaterThanOrEqual(0);
    for (const session of [`pending:${pending.id}`, `pending:${pending.id}:1`, `pending:${pending.id}:2`]) {
      const at = order.indexOf(`accepted:${session}`);
      expect(at, session).toBeGreaterThan(commit);
    }
    expect(order.filter((e) => e.startsWith('accepted:'))).toHaveLength(3);
  });

  it('multi-copy: a cap refusal on a later copy alerts only after the release transaction, and its advisory lock, has ended', async () => {
    const me = await person();
    const { pending, shas } = await holdCopies(me, { releaseAt: clock.now() });
    const LOCK = 960_006;
    const atAlert: { locks: number; openTransactions: number }[] = [];
    const events: string[] = [];
    const capped: ReleaseDeps = {
      ...deps,
      log: (event) => void events.push(event),
      caps: async (tx, _account, recipients) => {
        // What the real enforcer does first: the caps advisory lock, held until the transaction ends.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK}::bigint)`;
        if (recipients.length === 1 && recipients[0] === 'carol@example.org') {
          throw new CapExceededError({ code: 452, enhanced: '4.5.3', lines: ['Recipient cap reached'] }, async () => {
            events.push('alert');
            // From another connection: is the lock still held, is any transaction still open?
            const [locks] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${LOCK} AND granted`;
            const [open] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
            atAlert.push({ locks: locks?.n ?? -1, openTransactions: open?.n ?? -1 });
          });
        }
      },
    };
    expect(await releaseOne(capped, pending.id)).toBe('failed');
    // All or nothing: no copy queued, the draft stays.
    expect(await outboundFor(me, pending.messageIdHeader)).toHaveLength(0);
    expect((await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('failed');
    expect(await db.message.count({ where: { id: pending.draftMessageId ?? '', mailboxId: me.box.Drafts } })).toBe(1);
    expect(await db.blob.count({ where: { sha256: { in: shas } } })).toBe(0);
    // The alert went, once, with the lock released and no transaction open.
    expect(atAlert).toEqual([{ locks: 0, openTransactions: 0 }]);
    // And nothing was announced as accepted for a release that rolled back.
    expect(events).not.toContain('accepted');
    expect(events.indexOf('alert')).toBeGreaterThanOrEqual(0);
  });

  it('a pre-migration-shaped held row (one blob, no copies) still releases, to its whole envelope', async () => {
    const me = await person();
    const pending = await hold(me, { releaseAt: clock.now() });
    expect(await db.pendingSendCopy.count({ where: { pendingSendId: pending.id } })).toBe(0);
    expect(await releaseOne(deps, pending.id)).toBe('released');
    const out = await outboundFor(me, pending.messageIdHeader);
    expect(out).toHaveLength(1);
    expect(out[0]?.recipients.map((r) => r.address).sort()).toEqual(['alice@example.org', 'secret@example.org']);
    expect(await db.blob.findUnique({ where: { sha256: pending.heldBlobSha256 } })).toBeNull();
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
