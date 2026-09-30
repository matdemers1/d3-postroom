// PST-T-15.10 (PST-REQ-195, PST-ADR-013): composer attachments against a real database and a real
// (encrypted) blob store.
//   · doneWhen: upload → draft → reopen (re-registered as uploads) → send → the Sent copy's
//     attachment bytes are identical to the file uploaded, and still download after the worker's
//     sweep has released the upload (sends own their bytes);
//   · the limits: 413 attachment_too_large on the upload (declared and streamed), nothing stored;
//     413 attachments_too_large, 400 too_many_attachments, 404 for someone else's upload, on send
//     and on draft saves; 400 invalid_filename; GET /limits;
//   · a raw body of any type, application/json included, is stored byte for byte;
//   · DELETE releases the reference; every mutation is audited;
//   · holds (undo → the draft reopens with its files; released by the worker → Sent has them),
//     forwards (the original last), and a signed send all carry the files.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, tmpDir, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { parseMessage } from '@postroom/mime';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ComposeLimits, ComposeUpload, DraftDetail, DraftSaved, PendingSend, SendResponse } from '../../src/compose/schemas.js';
import { releaseOne, type ReleaseDeps } from '../../../worker/src/scheduled/release.js';
import { createUploadSweeper } from '../../../worker/src/sweep/upload-sweep.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

/** The decoded leaves of a message, outside any encapsulated message: id, type, filename, bytes. */
async function attachmentsOf(raw: Buffer): Promise<{ id: string; contentType: string; filename: string | null; data: Buffer }[]> {
  const inside = new Set<string>();
  const found = new Map<string, { contentType: string; filename: string | null; chunks: Buffer[] }>();
  for await (const e of parseMessage(raw)) {
    if (e.type === 'headers') {
      if (e.part.kind === 'message' || (e.part.parent !== null && inside.has(e.part.parent))) inside.add(e.part.id);
      else if (e.part.kind === 'leaf' && (e.part.disposition === 'attachment' || e.part.filename !== null)) found.set(e.part.id, { contentType: e.part.contentType, filename: e.part.filename, chunks: [] });
    } else if (e.type === 'body') found.get(e.part.id)?.chunks.push(e.chunk);
  }
  return [...found.entries()].map(([id, v]) => ({ id, contentType: v.contentType, filename: v.filename, data: Buffer.concat(v.chunks) }));
}

const hasBareLf = (b: Buffer): boolean => /(?<!\r)\n/.test(b.toString('latin1'));

/**
 * A POST with exactly these body bytes, written as these chunks (chunked transfer when there is
 * no content-length) — superagent would JSON-serialise a Buffer sent as application/json.
 */
async function rawPost(app: Express, path: string, headers: Record<string, string>, chunks: readonly Buffer[]): Promise<{ status: number; body: unknown }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text === '' ? null : (JSON.parse(text) as unknown) });
        });
      });
      req.on('error', reject);
      for (const c of chunks) req.write(c);
      req.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

describe.skipIf(!baseUrl)('composer attachments (PST-T-15.10, PST-REQ-195)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let smallApp: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  const kek = kekFromBase64(KEK_BASE64);
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    address: string;
    cookie: string;
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
    await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    const drafts = await mk('Drafts', SpecialUse.drafts);
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(target, login, totpSecret), sent: sent.id, drafts: drafts.id };
  };

  const upload = (who: Person, name: string | null, bytes: Buffer, contentType = 'application/octet-stream', target: Express = app) => {
    const r = request(target).post('/api/compose/uploads').set(CSRF).set('cookie', who.cookie).set('Content-Type', contentType);
    return (name === null ? r : r.set('X-Postroom-Filename', encodeURIComponent(name))).send(bytes);
  };
  const uploaded = async (who: Person, name: string, bytes: Buffer, contentType?: string, target?: Express) => {
    const res = await upload(who, name, bytes, contentType, target);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return ComposeUpload.parse(res.body);
  };
  const send = (who: Person, body: Record<string, unknown>, target: Express = app) => request(target).post('/api/compose/send').set(CSRF).set('cookie', who.cookie).send({ from: who.address, ...body });
  const saveDraft = (who: Person, body: Record<string, unknown>, target: Express = app) => request(target).post('/api/compose/drafts').set(CSRF).set('cookie', who.cookie).send(body);
  const binary = (r: Test): Test =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        cb(null, Buffer.concat(chunks));
      });
    });
  const rawOf = async (who: Person, messageId: string): Promise<Buffer> => {
    const res = await binary(request(app).get(`/api/messages/${messageId}/raw`).set('cookie', who.cookie));
    expect(res.status).toBe(200);
    return res.body as Buffer;
  };
  const blobBytes = async (sha: string): Promise<Buffer> => blobs.getBuffer(sha);
  const refcount = async (sha: string): Promise<number> => (await db.blob.findUnique({ where: { sha256: sha } }))?.refcount ?? 0;
  const releaseDeps = (): ReleaseDeps => ({ db, blobs, kek: () => kek, caps: () => Promise.resolve(), now: () => clock.now() });

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1510');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t1510-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    smallApp = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, COMPOSE_MAX_ATTACHMENT_BYTES: '1000', COMPOSE_MAX_ATTACHMENTS: '2' }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('doneWhen: upload → draft → reopen → send; the Sent copy carries the exact bytes, and still does after the sweep releases the upload', async () => {
    const me = await person();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(300_000), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
    const name = 'Relatório trimestral — Q3 “final”.pdf';

    // 1. Upload: raw body, percent-encoded name; one encrypted blob, one reference, audited.
    const up = await uploaded(me, name, pdf, 'Application/PDF');
    expect(up).toEqual({ id: up.id, filename: name, contentType: 'application/pdf', size: pdf.length });
    const row = await db.composeUpload.findUniqueOrThrow({ where: { id: up.id } });
    expect(row.accountId).toBe(me.id);
    expect(await refcount(row.blobSha256)).toBe(1);
    expect((await blobBytes(row.blobSha256)).equals(pdf)).toBe(true);
    expect(await db.auditEvent.count({ where: { action: 'compose.upload', entityId: up.id, actorAccountId: me.id } })).toBe(1);

    // 2. A draft with it: the draft message carries the real attachment part (IMAP clients see it).
    const saved = await saveDraft(me, { to: ['alice@example.org'], subject: 'Q3', text: 'Report attached.', attachments: [up.id] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const draft = DraftSaved.parse(saved.body);
    const draftRaw = await rawOf(me, draft.id);
    expect(hasBareLf(draftRaw)).toBe(false);
    expect(draftRaw.toString('latin1')).toMatch(/^Content-Type: multipart\/mixed;/m);
    const inDraft = await attachmentsOf(draftRaw);
    expect(inDraft.map((a) => [a.filename, a.contentType])).toEqual([[name, 'application/pdf']]);
    expect(inDraft[0]?.data.equals(pdf)).toBe(true);

    // 3. Reopen: the same bytes and name are the upload the account already has — reused, no new row.
    const reopened = await request(app).get(`/api/compose/drafts/${draft.id}`).set('cookie', me.cookie);
    expect(reopened.status).toBe(200);
    const detail = DraftDetail.parse(reopened.body);
    expect(detail).toMatchObject({ text: 'Report attached.', subject: 'Q3' });
    expect(detail.attachments).toEqual([{ id: up.id, filename: name, contentType: 'application/pdf', size: pdf.length }]);
    expect(await refcount(row.blobSha256)).toBe(1);

    // Removed from the composer, then the draft is reopened: re-registered as a NEW upload, audited.
    expect((await request(app).delete(`/api/compose/uploads/${up.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(204);
    expect(await refcount(row.blobSha256)).toBe(0);
    const again = DraftDetail.parse((await request(app).get(`/api/compose/drafts/${draft.id}`).set('cookie', me.cookie)).body);
    expect(again.attachments).toHaveLength(1);
    const restored = again.attachments[0];
    if (restored === undefined) throw new Error('restored');
    expect(restored.id).not.toBe(up.id);
    expect(restored).toMatchObject({ filename: name, contentType: 'application/pdf', size: pdf.length });
    expect(await db.auditEvent.count({ where: { action: 'compose.upload.restore', entityId: restored.id } })).toBe(1);
    // A second open reuses it.
    expect(DraftDetail.parse((await request(app).get(`/api/compose/drafts/${draft.id}`).set('cookie', me.cookie)).body).attachments.map((a) => a.id)).toEqual([restored.id]);

    // 4. Send it from the draft: queued, filed in Sent with the exact bytes; the draft is gone.
    const res = await send(me, { to: ['alice@example.org'], subject: 'Q3', text: 'Report attached.', draftId: draft.id, attachments: [restored.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = SendResponse.parse(res.body);
    expect(await db.message.count({ where: { mailboxId: me.drafts } })).toBe(0);
    const sentRaw = await rawOf(me, sent.sentMessageId);
    expect(hasBareLf(sentRaw)).toBe(false);
    const inSent = await attachmentsOf(sentRaw);
    expect(inSent.map((a) => [a.filename, a.contentType])).toEqual([[name, 'application/pdf']]);
    expect(inSent[0]?.data.equals(pdf)).toBe(true);
    const outbound = await db.outboundMessage.findUniqueOrThrow({ where: { id: sent.outboundId } });
    expect((await attachmentsOf(await blobBytes(outbound.blobSha256)))[0]?.data.equals(pdf)).toBe(true);
    // The list shows the paperclip; the send's audit row names the upload.
    const list = await request(app).get(`/api/mailboxes/${me.sent}/messages`).set('cookie', me.cookie);
    expect((list.body as { messages: { id: string; hasAttachments: boolean }[] }).messages.find((m) => m.id === sent.sentMessageId)?.hasAttachments).toBe(true);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'compose.send', entityId: sent.sentMessageId } });
    expect(audit.after).toMatchObject({ attachments: [restored.id] });

    // 5. The worker's sweep, a day later: the upload goes (its reference released, the blob shredded)…
    const restoredSha = (await db.composeUpload.findUniqueOrThrow({ where: { id: restored.id } })).blobSha256;
    const sweep = createUploadSweeper({ db, blobs, now: () => new Date(Date.now() + 25 * 3_600_000) });
    const swept = await sweep();
    expect(swept.released).toBeGreaterThanOrEqual(1);
    expect(await db.composeUpload.findUnique({ where: { id: restored.id } })).toBeNull();
    expect(await refcount(restoredSha)).toBe(0);
    // …and the Sent copy still downloads the attachment, byte for byte.
    const partId = inSent[0]?.id ?? '';
    const download = await binary(request(app).get(`/api/messages/${sent.sentMessageId}/attachments/${partId}`).set('cookie', me.cookie));
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(pdf)).toBe(true);
  });

  it('any content type is a raw body: a .json file is stored byte for byte (the JSON parser never sees it)', async () => {
    const me = await person();
    for (const bytes of [Buffer.from('{"a": [1, 2, 3]}\n'), Buffer.from('{not json at all'), Buffer.alloc(0)]) {
      const res = await rawPost(app, '/api/compose/uploads', { ...CSRF, cookie: me.cookie, 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-postroom-filename': 'data.json' }, [bytes]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const up = ComposeUpload.parse(res.body);
      expect(up).toMatchObject({ contentType: 'application/json', size: bytes.length });
      const row = await db.composeUpload.findUniqueOrThrow({ where: { id: up.id } });
      expect((await blobBytes(row.blobSha256)).equals(bytes)).toBe(true);
    }
    // No type at all, or nonsense: application/octet-stream.
    const plain = await upload(me, 'x.bin', Buffer.from('x'), 'not a type');
    expect(ComposeUpload.parse(plain.body).contentType).toBe('application/octet-stream');
  });

  it('refuses a bad filename (400 invalid_filename), and strips a path', async () => {
    const me = await person();
    for (const bad of [null, '', '..', 'a\nb.txt', 'x'.repeat(256)]) {
      const res = await upload(me, bad, Buffer.from('x'));
      expect(res.status, String(bad)).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_filename' });
    }
    const malformed = await request(app).post('/api/compose/uploads').set(CSRF).set('cookie', me.cookie).set('X-Postroom-Filename', '%E0%A4%A').send(Buffer.from('x'));
    expect(malformed.status).toBe(400);
    expect((await uploaded(me, 'C:\\fakepath\\scan.png', Buffer.from('png'), 'image/png')).filename).toBe('scan.png');
    expect(await db.composeUpload.count({ where: { accountId: me.id } })).toBe(1);
    // Without the CSRF header: 403, nothing stored.
    const noCsrf = await request(app).post('/api/compose/uploads').set('cookie', me.cookie).set('X-Postroom-Filename', 'a.txt').send(Buffer.from('x'));
    expect(noCsrf.status).toBe(403);
  });

  it('the limits: GET /limits; a file over the limit is 413 attachment_too_large (declared or streamed) and stores nothing', async () => {
    const me = await person(smallApp);
    const limits = await request(smallApp).get('/api/compose/limits').set('cookie', me.cookie);
    expect(limits.status).toBe(200);
    expect(ComposeLimits.parse(limits.body)).toEqual({ maxAttachmentBytes: 1000, maxAttachments: 2 });
    expect(ComposeLimits.parse((await request(app).get('/api/compose/limits').set('cookie', me.cookie)).body)).toEqual({ maxAttachmentBytes: 20_971_520, maxAttachments: 20 });

    const blobsBefore = await db.blob.count();
    // Declared: Content-Length over the limit, refused before a byte is read.
    const declared = await upload(me, 'big.bin', randomBytes(1001), 'application/octet-stream', smallApp);
    expect(declared.status).toBe(413);
    expect(declared.body).toMatchObject({ error: 'attachment_too_large' });

    // Streamed: chunked, no Content-Length — the counting Transform stops it mid-stream.
    const streamed = await rawPost(
      smallApp,
      '/api/compose/uploads',
      { ...CSRF, cookie: me.cookie, 'content-type': 'application/octet-stream', 'x-postroom-filename': 'streamed.bin', 'transfer-encoding': 'chunked' },
      Array.from({ length: 6 }, () => randomBytes(200)),
    );
    expect(streamed.status).toBe(413);
    expect(streamed.body).toMatchObject({ error: 'attachment_too_large' });
    // Nothing stored: no upload row, no blob row, no temp file left behind.
    expect(await db.composeUpload.count({ where: { accountId: me.id } })).toBe(0);
    expect(await db.blob.count()).toBe(blobsBefore);
    expect(await readdir(tmpDir(blobRoot)).catch(() => [])).toEqual([]);
    // Exactly at the limit is fine.
    expect((await uploaded(me, 'exact.bin', randomBytes(1000), undefined, smallApp)).size).toBe(1000);
  });

  it('the limits on send and drafts: 413 attachments_too_large, 400 too_many_attachments, 404 for an upload that is not the caller’s', async () => {
    const me = await person(smallApp);
    const a = await uploaded(me, 'a.bin', randomBytes(600), undefined, smallApp);
    const b = await uploaded(me, 'b.bin', randomBytes(600), undefined, smallApp);
    const c = await uploaded(me, 'c.bin', randomBytes(10), undefined, smallApp);
    const stranger = await person(smallApp);
    const theirs = await uploaded(stranger, 'theirs.bin', randomBytes(10), undefined, smallApp);

    const cases: [string[], number, string][] = [
      [[a.id, b.id], 413, 'attachments_too_large'],
      [[a.id, c.id, b.id], 400, 'too_many_attachments'],
      [[theirs.id], 404, 'not_found'],
      [[randomUUID()], 404, 'not_found'],
    ];
    for (const [ids, status, error] of cases) {
      const s = await send(me, { to: ['alice@example.org'], text: 'x', attachments: ids }, smallApp);
      expect(s.status, `send ${error}`).toBe(status);
      expect(s.body).toMatchObject({ error });
      const d = await saveDraft(me, { text: 'x', attachments: ids }, smallApp);
      expect(d.status, `draft ${error}`).toBe(status);
      expect(d.body).toMatchObject({ error });
    }
    expect((await send(me, { to: ['alice@example.org'], text: 'x', attachments: [theirs.id] }, smallApp)).body).toMatchObject({ message: expect.stringContaining(theirs.id) as unknown });
    // Nothing was sent or saved by any refusal.
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(0);
    expect(await db.message.count({ where: { mailboxId: me.drafts } })).toBe(0);
    // Within the limits it goes, in the order given, and PUT /drafts accepts them too.
    const ok = await send(me, { to: ['alice@example.org'], text: 'x', attachments: [c.id, a.id] }, smallApp);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await attachmentsOf(await rawOf(me, SendResponse.parse(ok.body).sentMessageId))).map((x) => x.filename)).toEqual(['c.bin', 'a.bin']);
    const d1 = DraftSaved.parse((await saveDraft(me, { text: 'x' }, smallApp)).body);
    const put = await request(smallApp).put(`/api/compose/drafts/${d1.id}`).set(CSRF).set('cookie', me.cookie).send({ text: 'y', attachments: [b.id] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await attachmentsOf(await rawOf(me, DraftSaved.parse(put.body).id))).map((x) => x.filename)).toEqual(['b.bin']);
    const over = await request(smallApp).put(`/api/compose/drafts/${DraftSaved.parse(put.body).id}`).set(CSRF).set('cookie', me.cookie).send({ text: 'y', attachments: [a.id, b.id] });
    expect(over.status).toBe(413);
  });

  it('DELETE: own uploads only; the reference is released; audited', async () => {
    const me = await person();
    const up = await uploaded(me, 'gone.txt', Buffer.from(`unique ${randomUUID()}`), 'text/plain');
    const sha = (await db.composeUpload.findUniqueOrThrow({ where: { id: up.id } })).blobSha256;
    const stranger = await person();
    expect((await request(app).delete(`/api/compose/uploads/${up.id}`).set(CSRF).set('cookie', stranger.cookie)).status).toBe(404);
    expect((await request(app).delete('/api/compose/uploads/not-a-uuid').set(CSRF).set('cookie', me.cookie)).status).toBe(404);
    expect(await refcount(sha)).toBe(1);
    expect((await request(app).delete(`/api/compose/uploads/${up.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(204);
    expect(await db.composeUpload.findUnique({ where: { id: up.id } })).toBeNull();
    expect(await refcount(sha)).toBe(0);
    expect((await request(app).delete(`/api/compose/uploads/${up.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(404);
    const actions = (await db.auditEvent.findMany({ where: { entityId: up.id } })).map((e) => e.action).sort();
    expect(actions).toEqual(['compose.upload', 'compose.upload.delete']);
    // Two uploads of the same bytes share one blob, one reference each.
    const same = Buffer.from(`shared ${randomUUID()}`);
    const one = await uploaded(me, 'one.txt', same);
    const two = await uploaded(me, 'two.txt', same);
    const shared = (await db.composeUpload.findUniqueOrThrow({ where: { id: one.id } })).blobSha256;
    expect(await refcount(shared)).toBe(2);
    await request(app).delete(`/api/compose/uploads/${two.id}`).set(CSRF).set('cookie', me.cookie);
    expect(await refcount(shared)).toBe(1);
  });

  it('a held send carries the files: in the held blob and the Drafts copy; undone, the draft reopens with them; released, Sent has them', async () => {
    const me = await person();
    const file = randomBytes(5000);
    const up = await uploaded(me, 'held.bin', file);

    const held = await send(me, { to: ['alice@example.org'], subject: 'Held', text: 'Held.', attachments: [up.id], undoSeconds: 10 });
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    const pending = PendingSend.parse(held.body);
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect((await attachmentsOf(await blobBytes(row.heldBlobSha256)))[0]?.data.equals(file)).toBe(true);
    expect((await attachmentsOf(await rawOf(me, pending.draftId ?? '')))[0]?.data.equals(file)).toBe(true);
    expect((await db.auditEvent.findFirstOrThrow({ where: { action: 'compose.hold', entityId: pending.id } })).after).toMatchObject({ attachments: [up.id] });

    // Undo: the send is cancelled, the draft stays, and reopening it gives the file back as an upload.
    expect((await request(app).post(`/api/compose/pending/${pending.id}/undo`).set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    const reopened = DraftDetail.parse((await request(app).get(`/api/compose/drafts/${pending.draftId ?? ''}`).set('cookie', me.cookie)).body);
    expect(reopened.attachments).toEqual([{ id: up.id, filename: 'held.bin', contentType: 'application/octet-stream', size: file.length }]);

    // Held again and released by the worker: the Sent copy carries the file.
    const again = await send(me, { to: ['alice@example.org'], subject: 'Held', text: 'Held.', attachments: [up.id], undoSeconds: 10, draftId: pending.draftId });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    const second = PendingSend.parse(again.body);
    expect(await releaseOne(releaseDeps(), second.id)).toBe('released');
    const released = await db.pendingSend.findUniqueOrThrow({ where: { id: second.id } });
    expect((await attachmentsOf(await rawOf(me, released.sentMessageId ?? '')))[0]?.data.equals(file)).toBe(true);
  });

  it('a forward carries the body, then the files, then the original as message/rfc822', async () => {
    const me = await person();
    const original = Buffer.from(['From: Alice <alice@example.org>', `To: ${me.address}`, 'Subject: Report', 'Message-ID: <fwd-att@example.org>', '', 'Numbers inside.', ''].join('\r\n'));
    const put = await blobs.put(original);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date() }));
    const up = await uploaded(me, 'notes.txt', Buffer.from('my notes\r\n'), 'text/plain');
    const res = await send(me, { to: ['bob@example.org'], subject: 'Fwd: Report', text: 'FYI', forwardOf: filed.id, attachments: [up.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const raw = await rawOf(me, SendResponse.parse(res.body).sentMessageId);
    const text = raw.toString('latin1');
    expect(text.indexOf('filename="notes.txt"')).toBeGreaterThan(text.indexOf('FYI'));
    expect(text.indexOf('Content-Type: message/rfc822')).toBeGreaterThan(text.indexOf('filename="notes.txt"'));
    expect(text).toContain(original.toString('latin1'));
    const parts = await attachmentsOf(raw);
    expect(parts.map((p) => p.filename)).toEqual(['notes.txt']);
    expect(parts[0]?.data.toString()).toBe('my notes\r\n');
  });

  it('a signed send builds the whole entity, files included, before it signs', async () => {
    const me = await person();
    const key = await request(app).post('/api/keys/generate').set(CSRF).set('cookie', me.cookie).send({ address: me.address });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const file = randomBytes(3000);
    const up = await uploaded(me, 'signed.bin', file);
    const res = await send(me, { to: ['someone@example.test'], subject: 'Signed', text: 'Signed, with a file.', attachments: [up.id], crypto: { sign: 'pgp' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const raw = await rawOf(me, SendResponse.parse(res.body).sentMessageId);
    expect(raw.toString('latin1')).toMatch(/^Content-Type: multipart\/signed;/m);
    const parts = await attachmentsOf(raw);
    const signedFile = parts.find((p) => p.filename === 'signed.bin');
    expect(signedFile?.data.equals(file)).toBe(true);
  });
});
