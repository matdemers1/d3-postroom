// PST-T-3.11 (PST-REQ-079): the composer's API against a real database and a real (encrypted) blob
// store. doneWhen — "Reply appears in the thread and in Sent" — is the first test: a reply sent over
// HTTP goes through the SMTP submission path (queued, DKIM-signed, audited), is filed in Sent, and
// joins the original's thread. The rest: From ownership, never unsigned, forwards carry the
// original, drafts are real messages that replace themselves, caps, and every mutation audited.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { AddressKind, randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { assignThread } from '@postroom/threading';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { buildOutgoingStream, buildTextMessage, bracketMsgId, parseRecipients, textPart, type OutgoingMessage } from '../../src/compose/message.js';
import { Draft, DraftList, DraftSaved, SendResponse } from '../../src/compose/schemas.js';
import { ThreadDetail } from '../../src/mail/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const hasBareLf = (b: Buffer): boolean => /(?<!\r)\n/.test(b.toString('latin1'));
const hasBareCr = (b: Buffer): boolean => /\r(?!\n)/.test(b.toString('latin1'));

describe('the message the composer builds (pure)', () => {
  const base: OutgoingMessage = {
    from: { name: 'Zoë Operator', address: 'zoe@d3cloud.io' },
    to: [{ name: 'Alice Example', address: 'alice@example.org' }],
    cc: [],
    bcc: [{ name: '', address: 'secret@example.org' }],
    subject: 'Re: Café plans',
    text: 'Line one\nLine two — naïve\n',
    messageId: '<m1@d3cloud.io>',
    inReplyTo: '<orig@example.org>',
    references: ['<root@example.org>', '<orig@example.org>'],
    date: new Date('2026-09-26T10:00:00Z'),
  };

  it('is strict CRLF, encodes non-ASCII headers as encoded-words and the body as quoted-printable', () => {
    const raw = buildTextMessage(base);
    expect(hasBareLf(raw)).toBe(false);
    expect(hasBareCr(raw)).toBe(false);
    const text = raw.toString('latin1');
    expect(text).toMatch(/^From: =\?UTF-8\?[QB]\?.+\?= <zoe@d3cloud\.io>\r\n/);
    expect(text).toContain('Subject: =?UTF-8?');
    expect(text).toContain('In-Reply-To: <orig@example.org>\r\n');
    expect(text).toContain('References: <root@example.org> <orig@example.org>\r\n');
    expect(text).toContain('Date: Sat, 26 Sep 2026 10:00:00 +0000\r\n');
    expect(text).toContain('Content-Transfer-Encoding: quoted-printable\r\n');
    expect(text).not.toContain('Bcc:');
    expect(buildTextMessage({ ...base, includeBcc: true }).toString('latin1')).toContain('Bcc: secret@example.org\r\n');
  });

  it('keeps plain ASCII text as 7bit, and folds long address lists', () => {
    expect(textPart('hello\nworld').encoding).toBe('7bit');
    expect(textPart('x'.repeat(1200)).encoding).toBe('quoted-printable');
    const many = Array.from({ length: 8 }, (_, i) => ({ name: '', address: `person${String(i)}@example.org` }));
    const raw = buildTextMessage({ ...base, to: many }).toString('latin1');
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    expect(raw).toMatch(/To: person0@example\.org,.*\r\n person/);
  });

  it('forwards the original byte for byte as message/rfc822', async () => {
    const original = Buffer.from('From: a@example.org\r\nSubject: hi\r\n\r\nbody\r\n');
    const { Readable } = await import('node:stream');
    const out = await collect(buildOutgoingStream(base, Readable.from([original.subarray(0, 7), original.subarray(7)]), 'BOUND'));
    const text = out.toString('latin1');
    expect(text).toContain('Content-Type: multipart/mixed;\r\n boundary="BOUND"\r\n');
    expect(text).toContain(`Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forwarded-message.eml"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${original.toString('latin1')}\r\n--BOUND--\r\n`);
    expect(hasBareLf(out)).toBe(false);
  });

  it('parses recipients strictly: no literals, no garbage, names kept', () => {
    expect(parseRecipients(['Alice <alice@example.org>, bob@example.org'])).toEqual({
      ok: true,
      mailboxes: [
        { name: 'Alice', address: 'alice@example.org' },
        { name: '', address: 'bob@example.org' },
      ],
    });
    expect(parseRecipients(['user@[127.0.0.1]']).ok).toBe(false);
    expect(parseRecipients(['not an address']).ok).toBe(false);
    expect(parseRecipients(['', '  ']).ok).toBe(true);
    expect(bracketMsgId('abc@x')).toBe('<abc@x>');
    expect(bracketMsgId('<a b>')).toBeNull();
  });
});

describe.skipIf(!baseUrl)('composer API (PST-T-3.11)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let cappedApp: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    address: string;
    cookie: string;
    inbox: string;
    sent: string;
    drafts: string;
  }

  const signIn = async (target: Express, login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(target).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(target).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (target: Express = app): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}` });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    const drafts = await mk('Drafts', SpecialUse.drafts);
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(target, login, totpSecret), inbox: inbox.id, sent: sent.id, drafts: drafts.id };
  };

  /** Inbound mail as the worker files it: blob, fileLocalMessage, denormalised headers, and (optionally) a thread. */
  const inbound = async (me: Person, opts: { messageId: string; subject: string; thread: boolean }) => {
    const raw = Buffer.from(
      [`From: Alice Example <alice@example.org>`, `To: ${me.address}`, `Subject: ${opts.subject}`, 'Date: Thu, 24 Sep 2026 10:00:00 +0000', `Message-ID: <${opts.messageId}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Can you make Thursday?', ''].join('\r\n'),
    );
    const put = await blobs.put(raw);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date() }));
    const sentAt = new Date('2026-09-24T10:00:00Z');
    if (opts.thread) {
      await assignThread(db, { accountId: me.id, messageId: filed.id, messageIdHeader: `<${opts.messageId}>`, references: [], subject: opts.subject, from: 'alice@example.org', to: me.address, date: sentAt });
    } else {
      // As the e2e seed files it: bracketed Message-ID, never threaded.
      await db.message.update({ where: { id: filed.id }, data: { messageIdHeader: `<${opts.messageId}>`, subject: opts.subject, fromAddress: 'alice@example.org', sentAt } });
    }
    return { ...filed, raw };
  };

  const send = (who: Person, body: Record<string, unknown>, target: Express = app) => request(target).post('/api/compose/send').set(CSRF).set('cookie', who.cookie).send({ from: who.address, ...body });

  const rawOf = async (who: Person, messageId: string): Promise<Buffer> => {
    const res = await request(app).get(`/api/messages/${messageId}/raw`).set('cookie', who.cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => {
        cb(null, Buffer.concat(chunks));
      });
    });
    expect(res.status).toBe(200);
    return res.body as Buffer;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t311');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t311-blobs-'));
    const kek = kekFromBase64(KEK_BASE64);
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    cappedApp = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, SUBMISSION_CAP_HOURLY: '3' }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('needs a session and the CSRF header', async () => {
    expect((await request(app).post('/api/compose/send').set(CSRF).send({})).status).toBe(401);
    const me = await person();
    expect((await request(app).post('/api/compose/send').set('cookie', me.cookie).send({ from: me.address, to: ['a@example.org'] })).status).toBe(403);
  });

  it('doneWhen: a reply goes through the submission path, appears in Sent and joins the thread', async () => {
    const me = await person();
    const original = await inbound(me, { messageId: 'thursday@example.org', subject: 'Thursday?', thread: true });
    const before = await db.message.findUniqueOrThrow({ where: { id: original.id } });
    expect(before.threadId).not.toBeNull();

    const res = await send(me, {
      to: ['Alice Example <alice@example.org>'],
      subject: 'Re: Thursday?',
      text: 'Thursday works.\n\nOn Thu, Alice wrote:\n> Can you make Thursday?',
      inReplyTo: '<thursday@example.org>',
      references: ['<thursday@example.org>'],
    });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    expect(sent.sentMailboxId).toBe(me.sent);
    expect(sent.threadId).toBe(before.threadId);

    // In Sent: \Seen, with the list's columns filled in.
    const list = await request(app).get(`/api/mailboxes/${me.sent}/messages`).set('cookie', me.cookie);
    expect(list.status).toBe(200);
    expect((list.body as { messages: { id: string; subject: string; from: string; flags: string[] }[] }).messages).toEqual([
      expect.objectContaining({ id: sent.sentMessageId, subject: 'Re: Thursday?', from: me.address, flags: ['\\Seen'] }),
    ]);

    // In the thread, after the original.
    const thread = await request(app).get(`/api/threads/${sent.threadId ?? ''}`).set('cookie', me.cookie);
    expect(thread.status).toBe(200);
    expect(ThreadDetail.parse(thread.body).messages.map((m) => m.id)).toEqual([original.id, sent.sentMessageId]);

    // Queued exactly as SMTP submission queues: one outbound row, its recipient, the same blob.
    const outbound = await db.outboundMessage.findUniqueOrThrow({ where: { id: sent.outboundId }, include: { recipients: true } });
    expect(outbound).toMatchObject({ accountId: me.id, appPasswordId: null, submittedVia: 'webmail', envelopeFrom: me.address, headerFrom: me.address, messageId: sent.messageId });
    expect(outbound.recipients.map((r) => r.address)).toEqual(['alice@example.org']);
    const sentRow = await db.message.findUniqueOrThrow({ where: { id: sent.sentMessageId } });
    expect(sentRow.blobSha256).toBe(outbound.blobSha256);
    expect((await db.blob.findUniqueOrThrow({ where: { sha256: outbound.blobSha256 } })).refcount).toBe(2);
    expect(await db.job.count({ where: { queue: 'outbound', payload: { path: ['messageId'], equals: sent.outboundId } } })).toBe(1);

    // The bytes: strict CRLF, signed twice (Ed25519 + RSA), threading headers for the recipient too.
    const raw = await rawOf(me, sent.sentMessageId);
    expect(hasBareLf(raw)).toBe(false);
    const text = raw.toString('latin1');
    expect(text.match(/^DKIM-Signature:/gm)).toHaveLength(2);
    expect(text).toContain('In-Reply-To: <thursday@example.org>\r\n');
    expect(text).toContain('References: <thursday@example.org>\r\n');
    expect(text).toContain(`Message-ID: ${sent.messageId}\r\n`);

    // Audited: the submission path's row and the composer's.
    const audits = await db.auditEvent.findMany({ where: { actorAccountId: me.id, action: { in: ['submission.accept', 'compose.send'] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(['compose.send', 'submission.accept']);
    expect(audits.find((a) => a.action === 'submission.accept')?.after).toMatchObject({ submittedVia: 'webmail', headerFrom: me.address });
  });

  it('threads a reply to mail that was never threaded (it is threaded first)', async () => {
    const me = await person();
    const original = await inbound(me, { messageId: 'seeded@e2e.invalid', subject: 'Seeded', thread: false });
    const res = await send(me, { to: ['alice@example.org'], subject: 'Re: Seeded', text: 'Hi.', inReplyTo: 'seeded@e2e.invalid', references: [] });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const after = await db.message.findUniqueOrThrow({ where: { id: original.id } });
    expect(after.threadId).not.toBeNull();
    expect(sent.threadId).toBe(after.threadId);
  });

  it('refuses a From the account does not own, and never sends unsigned', async () => {
    const me = await person();
    const spoof = await send(me, { from: 'someone-else@d3cloud.io', to: ['a@example.org'], text: 'x' });
    expect(spoof.status).toBe(403);
    expect(spoof.body).toMatchObject({ error: 'from_not_owned' });

    // An address at a domain with no DKIM keys: 503, and nothing queued or filed.
    const other = await db.domain.create({ data: { name: `nokeys${String(randomInt(1e6))}.test` } });
    await db.address.create({ data: { localPart: 'me', domainId: other.id, kind: AddressKind.service, accountId: me.id } });
    const unsigned = await send(me, { from: `me@${other.name}`, to: ['a@example.org'], text: 'x' });
    expect(unsigned.status).toBe(503);
    expect(unsigned.body).toMatchObject({ error: 'dkim_unconfigured' });
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(0);
    expect(await db.message.count({ where: { mailboxId: me.sent } })).toBe(0);

    expect((await send(me, { to: [], text: 'x' })).status).toBe(400);
    expect((await send(me, { to: ['user@[10.0.0.1]'], text: 'x' })).body).toMatchObject({ error: 'invalid_recipient' });
  });

  it('Bcc goes on the envelope, never in the header', async () => {
    const me = await person();
    const res = await send(me, { to: ['a@example.org'], bcc: ['hidden@example.net'], subject: 'b', text: 'x' });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const recipients = await db.outboundRecipient.findMany({ where: { outboundMessageId: sent.outboundId } });
    expect(recipients.map((r) => r.address).sort()).toEqual(['a@example.org', 'hidden@example.net']);
    expect((await rawOf(me, sent.sentMessageId)).toString('latin1')).not.toMatch(/^Bcc:/im);
  });

  it('a forward carries the original whole, and only the caller’s own messages can be forwarded', async () => {
    const me = await person();
    const original = await inbound(me, { messageId: 'fwd@example.org', subject: 'Report', thread: true });
    const res = await send(me, { to: ['bob@example.org'], subject: 'Fwd: Report', text: 'FYI', forwardOf: original.id });
    expect(res.status).toBe(201);
    const raw = (await rawOf(me, SendResponse.parse(res.body).sentMessageId)).toString('latin1');
    expect(raw).toContain('Content-Type: message/rfc822');
    expect(raw).toContain(original.raw.toString('latin1'));

    const stranger = await person();
    const theirs = await inbound(stranger, { messageId: 'private@example.org', subject: 'Private', thread: false });
    expect((await send(me, { to: ['bob@example.org'], text: 'x', forwardOf: theirs.id })).status).toBe(404);
  });

  it('drafts: saved in Drafts, reopened with their text, replaced (old one expunged), removed on send', async () => {
    const me = await person();
    const created = await request(app)
      .post('/api/compose/drafts')
      .set(CSRF)
      .set('cookie', me.cookie)
      .send({ to: ['Alice Example <alice@example.org>'], cc: ['half-typed'], subject: 'Plans — café', text: 'First line\nSecond ünïcode line', inReplyTo: '<plans@example.org>', references: ['<plans@example.org>'], mode: 'reply', sourceId: me.inbox });
    expect(created.status).toBe(201);
    const first = DraftSaved.parse(created.body);
    expect(first.mailboxId).toBe(me.drafts);
    const row = await db.message.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.flags.sort()).toEqual(['\\Draft', '\\Seen']);

    const got = await request(app).get(`/api/compose/drafts/${first.id}`).set('cookie', me.cookie);
    expect(got.status).toBe(200);
    expect(Draft.parse(got.body)).toMatchObject({
      id: first.id,
      from: me.address,
      to: ['Alice Example <alice@example.org>'],
      cc: [],
      subject: 'Plans — café',
      text: 'First line\nSecond ünïcode line',
      inReplyTo: '<plans@example.org>',
      references: ['<plans@example.org>'],
      mode: 'reply',
      sourceId: me.inbox,
    });

    const replaced = await request(app).put(`/api/compose/drafts/${first.id}`).set(CSRF).set('cookie', me.cookie).send({ to: ['alice@example.org'], subject: 'Plans', text: 'Edited', inReplyTo: '<plans@example.org>' });
    expect(replaced.status).toBe(200);
    const second = DraftSaved.parse(replaced.body);
    expect(second.id).not.toBe(first.id);
    expect((await request(app).get(`/api/compose/drafts/${first.id}`).set('cookie', me.cookie)).status).toBe(404);
    expect(await db.expungedMessage.count({ where: { mailboxId: me.drafts, uid: row.uid } })).toBe(1);
    expect(await db.blob.findUnique({ where: { sha256: row.blobSha256 } })).toBeNull();

    const listed = await request(app).get('/api/compose/drafts').query({ inReplyTo: 'plans@example.org' }).set('cookie', me.cookie);
    expect(DraftList.parse(listed.body).drafts.map((d) => [d.id, d.text])).toEqual([[second.id, 'Edited']]);

    // Another account can neither read nor replace it.
    const stranger = await person();
    expect((await request(app).get(`/api/compose/drafts/${second.id}`).set('cookie', stranger.cookie)).status).toBe(404);
    expect((await request(app).put(`/api/compose/drafts/${second.id}`).set(CSRF).set('cookie', stranger.cookie).send({ text: 'x' })).status).toBe(404);

    const sentRes = await send(me, { to: ['alice@example.org'], subject: 'Plans', text: 'Edited', draftId: second.id });
    expect(sentRes.status).toBe(201);
    expect(await db.message.count({ where: { mailboxId: me.drafts } })).toBe(0);

    const third = DraftSaved.parse((await request(app).post('/api/compose/drafts').set(CSRF).set('cookie', me.cookie).send({ text: 'throwaway' })).body);
    expect((await request(app).delete(`/api/compose/drafts/${third.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(204);
    expect((await request(app).delete(`/api/compose/drafts/${third.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(404);

    const actions = (await db.auditEvent.findMany({ where: { actorAccountId: me.id, action: { startsWith: 'draft.' } } })).map((a) => a.action).sort();
    expect(actions).toEqual(['draft.delete', 'draft.replace', 'draft.save', 'draft.save']);
  });

  it('the recipient cap refuses the message that would exceed it (429), queuing and filing nothing', async () => {
    const me = await person(cappedApp);
    expect((await send(me, { to: ['a@example.org', 'b@example.org'], text: 'x' }, cappedApp)).status).toBe(201);
    const over = await send(me, { to: ['c@example.org', 'd@example.org'], text: 'x' }, cappedApp);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'recipient_cap' });
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(1);
    expect(await db.message.count({ where: { mailboxId: me.sent } })).toBe(1);
  });
});
