// PST-T-12.1, PST-REQ-160: GET /api/messages/:id/inspect carries the signature and decryption
// status. A real PGP/MIME Ed25519 fixture filed into a mailbox verifies against the account's own
// crypto_key row; the same bytes with one body byte changed do not; another account's key is not
// this account's; and an encrypted fixture decrypts with a private key sealed under the KEK.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { decodeArmor, encodeArmor, encodePacket, readPackets, Tag } from '@postroom/pgp';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { sealPrivateKey } from '../../src/mail/crypto-keys.js';
import { inspectMessage, MessageInspect } from '../../src/mail/inspect.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'pgp', 'test', 'fixtures');
const fixture = (f: string): Buffer => readFileSync(join(FIXTURES, f));
const ALICE_FPR = fixture('alice-ed25519.fpr').toString('utf8').trim();

describe.skipIf(!baseUrl)('Inspect: signature and encryption (PST-T-12.1, PST-REQ-160)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  const kek = kekFromBase64(KEK_BASE64);

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<{ id: string; cookie: string; inbox: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const inbox = await db.mailbox.create({ data: { accountId: id, name: 'INBOX', specialUse: SpecialUse.inbox, uidvalidity: randomUidValidity(randomInt) } });
    return { id, cookie: await signIn(login, totpSecret), inbox: inbox.id };
  };

  const file = async (mailboxId: string, raw: Buffer) => {
    const put = await blobs.put(raw);
    const rows = await db.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailboxId}::uuid`;
    const mb = rows[0];
    if (mb === undefined) throw new Error('no mailbox');
    const message = await db.message.create({
      data: { mailboxId, uid: mb.uidnext, modseq: mb.highest_modseq + 1n, blobSha256: put.sha256, size: put.size, internalDate: new Date(), subject: 'crypto', fromAddress: 'alice@example.test' },
    });
    await db.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: mb.highest_modseq + 1n } });
    return message;
  };

  const aliceKey = async (accountId: string, owner: 'own' | 'contact', withPrivate: boolean) => {
    const sealed = withPrivate ? sealPrivateKey(kek, accountId, 'pgp', ALICE_FPR, fixture('alice-ed25519.TEST-ONLY.sec.asc').toString('utf8')) : null;
    return db.cryptoKey.create({
      data: {
        accountId,
        kind: 'pgp',
        owner,
        address: 'alice@example.test',
        fingerprint: ALICE_FPR,
        algorithm: 'ed25519',
        publicKey: fixture('alice-ed25519.pub.asc').toString('utf8'),
        sealedPrivate: sealed === null ? null : new Uint8Array(sealed.sealedPrivate),
        kekId: sealed?.kekId ?? null,
      },
    });
  };

  const inspect = async (cookie: string, id: string) => {
    const res = await request(app).get(`/api/messages/${id}/inspect`).set('cookie', cookie);
    expect(res.status).toBe(200);
    return MessageInspect.parse(res.body);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t121_inspect');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t121-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('a PGP/MIME signed fixture is verified-known-key with a matching crypto_key row', async () => {
    const me = await person();
    const key = await aliceKey(me.id, 'contact', false);
    const m = await file(me.inbox, fixture('pgp-mime-signed-ed25519.eml'));
    const body = await inspect(me.cookie, m.id);
    expect(body.crypto.signature.status).toBe('verified-known-key');
    expect(body.crypto.signature.signer).toMatchObject({ fingerprint: ALICE_FPR, keySource: 'account', knownKeyId: key.id, owner: 'contact', fromMatches: true });
    expect(body.crypto.encryption.status).toBe('not-encrypted');
    // The rest of the drawer is untouched.
    expect(body.headers.some((h) => h.name === 'Subject')).toBe(true);
  });

  it('one changed body byte is bad-signature', async () => {
    const me = await person();
    await aliceKey(me.id, 'contact', false);
    const raw = Buffer.from(fixture('pgp-mime-signed-ed25519.eml'));
    const at = raw.indexOf('Hello Bob');
    raw[at] = (raw[at] ?? 0) ^ 0x01;
    const m = await file(me.inbox, raw);
    expect((await inspect(me.cookie, m.id)).crypto.signature.status).toBe('bad-signature');
  });

  it("another account's key does not make it known here", async () => {
    const other = await person();
    await aliceKey(other.id, 'contact', false);
    const me = await person();
    const m = await file(me.inbox, fixture('pgp-mime-signed-ed25519.eml'));
    const body = await inspect(me.cookie, m.id);
    // Alice's key rides along in the message: valid, but never trusted on its own.
    expect(body.crypto.signature.status).toBe('valid-signature-unknown-key');
    expect(body.crypto.signature.signer?.keySource).toBe('message');
  });

  it('a revoked key is never verified, and the drawer says why', async () => {
    const me = await person();
    const key = await aliceKey(me.id, 'contact', false);
    await db.cryptoKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    const m = await file(me.inbox, fixture('pgp-mime-signed-ed25519.eml'));
    const body = await inspect(me.cookie, m.id);
    expect(body.crypto.signature.status).toBe('unsupported:key-revoked');
    expect(body.crypto.signature.signer).toMatchObject({ keySource: 'account', knownKeyId: key.id });
  });

  it('a key that expired before the signature was made is never verified', async () => {
    const me = await person();
    const key = await aliceKey(me.id, 'contact', false);
    await db.cryptoKey.update({ where: { id: key.id }, data: { expiresAt: new Date('2020-01-01T00:00:00Z') } });
    const m = await file(me.inbox, fixture('pgp-mime-signed-ed25519.eml'));
    expect((await inspect(me.cookie, m.id)).crypto.signature.status).toBe('unsupported:key-expired');
  });

  it("the verifier's forgery — alice's public self-certification replayed as a document signature — is refused", async () => {
    const me = await person();
    await aliceKey(me.id, 'contact', false);
    const armored = decodeArmor(fixture('alice-ed25519.pub.asc').toString('utf8'));
    if (armored === null) throw new Error('alice key');
    const packets = readPackets(armored.data);
    const key = packets.find((p) => p.tag === Tag.PublicKey);
    const uidAt = packets.findIndex((p) => p.tag === Tag.UserId);
    const uid = packets[uidAt];
    const cert = packets.slice(uidAt + 1).find((p) => p.tag === Tag.Signature && p.body[1] === 0x13);
    if (key === undefined || uid === undefined || cert === undefined) throw new Error('alice key shape');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(uid.body.length, 0);
    const signed = Buffer.concat([Buffer.of(0x99, key.body.length >> 8, key.body.length & 0xff), key.body, Buffer.of(0xb4), len, uid.body]);
    const sig = encodeArmor('PGP SIGNATURE', encodePacket(Tag.Signature, cert.body)).replace(/\r?\n/g, '\r\n');
    const raw = Buffer.concat([
      Buffer.from('From: Alice Test <alice@example.test>\r\nTo: me@d3cloud.io\r\nSubject: forged\r\nMIME-Version: 1.0\r\nContent-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="b"\r\n\r\n--b\r\n', 'latin1'),
      signed,
      Buffer.from(`\r\n--b\r\nContent-Type: application/pgp-signature\r\n\r\n${sig}\r\n--b--\r\n`, 'latin1'),
    ]);
    const m = await file(me.inbox, raw);
    expect((await inspect(me.cookie, m.id)).crypto.signature.status).toBe('unsupported:signature-type-0x13');
  });

  it('an encrypted fixture decrypts with a private key sealed under the KEK', async () => {
    const me = await person();
    const key = await aliceKey(me.id, 'own', true);
    const m = await file(me.inbox, fixture('pgp-mime-encrypted-x25519.eml'));
    const message = await db.message.findUniqueOrThrow({ where: { id: m.id }, include: { verdict: true } });

    const opened = MessageInspect.parse(JSON.parse(JSON.stringify(await inspectMessage(db, blobs, message, { kek }))));
    expect(opened.crypto.encryption).toMatchObject({ status: 'decrypted', format: 'pgp-mime', cipher: 'AES-256', openedWithKeyId: key.id });

    // Without the KEK the sealed key cannot open, and the drawer says so rather than failing.
    const closed = await inspectMessage(db, blobs, message, {});
    expect(closed.crypto.encryption.status).toBe('failed:private-key-unavailable');

    // Through the route: the response always carries a decryption status for an encrypted message.
    const viaRoute = await inspect(me.cookie, m.id);
    expect(viaRoute.crypto.encryption.format).toBe('pgp-mime');
    expect(['decrypted', 'failed:private-key-unavailable']).toContain(viaRoute.crypto.encryption.status);
  });

  it("PST-T-12.3: an attacker's key appended to a contact's stored key as an unbound subkey never verifies as the contact", async () => {
    const me = await person();
    const daveFpr = fixture('dave-ed25519.fpr').toString('utf8').trim();
    const row = (publicKey: string) =>
      db.cryptoKey.create({ data: { accountId: me.id, kind: 'pgp', owner: 'contact', address: 'dave@example.test', fingerprint: daveFpr, algorithm: 'ed25519', publicKey } });
    const poisoned = await row(fixture('dave-poisoned.pub.asc').toString('utf8'));
    const forged = await file(me.inbox, fixture('pgp-mime-signed-mallory-as-dave.eml'));
    const body = await inspect(me.cookie, forged.id);
    expect(body.crypto.signature.status).toBe('unsupported:subkey-not-bound');
    expect(body.crypto.signature.signer).toMatchObject({ userIds: [], knownKeyId: null, fromMatches: null });
    // Dave's own signing subkey, bound with its back-signature, still verifies against the same row.
    const genuine = await file(me.inbox, fixture('pgp-mime-signed-dave-subkey.eml'));
    expect((await inspect(me.cookie, genuine.id)).crypto.signature).toMatchObject({ status: 'verified-known-key', signer: { knownKeyId: poisoned.id } });
  });

  it('S/MIME signed: valid, with the chain as presented', async () => {
    const me = await person();
    const m = await file(me.inbox, fixture('smime-signed.eml'));
    const body = await inspect(me.cookie, m.id);
    expect(body.crypto.signature.status).toBe('valid-signature-unknown-key');
    expect(body.crypto.signature.certificates).toHaveLength(2);
    expect(body.crypto.signature.chain?.verified).toBe(true);
  });
});
