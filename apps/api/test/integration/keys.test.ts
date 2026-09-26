// PST-T-12.2, PST-REQ-161: the Keys API and the composer's Sign / Encrypt, against a real database
// and a real (encrypted) blob store.
//   · key CRUD is account-scoped and every mutation is audited; a private half is sealed under the
//     KEK exactly as the verifier opens it; the row's fingerprint is the primary's, and a block with
//     two primary keys is refused; secret export needs a fresh step-up;
//   · a send with crypto produces a queued outbound message that analyzeMessage (the PST-T-12.1
//     verifier) reports decrypted with the recipient's TEST key and verified-known-key for the
//     signature — OpenPGP and S/MIME — and the sender's own key opens the Sent copy;
//   · a recipient without a key is a 409 naming them, and nothing is queued.
import { createHash, generateKeyPairSync, randomInt, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import {
  analyzeMessage,
  decodeArmor,
  encodeArmor,
  encodeOid,
  encodeTlv,
  encodePacket,
  generateKey,
  keyState,
  parseKeys,
  protectSecretKeyBlock,
  readPackets,
  Tag,
  type KnownKey,
} from '@postroom/pgp';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { CryptoKeyCreated, CryptoKeyList, KeyPublicExport, KeySecretExport } from '../../src/keys/schemas.js';
import { SendResponse } from '../../src/compose/schemas.js';
import { loadAccountKeys, openPrivateKey } from '../../src/mail/crypto-keys.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'pgp', 'test', 'fixtures');
const text = (f: string): string => readFileSync(join(FIXTURES, f), 'utf8');
const ALICE_FPR = text('alice-ed25519.fpr').trim();

/** The recipient's TEST keys, as the recipient's own account would hold them. */
const aliceOwn = (): KnownKey => ({ id: 'alice', kind: 'pgp', owner: 'own', address: 'alice@example.test', fingerprint: ALICE_FPR, publicKey: text('alice-ed25519.pub.asc'), openPrivate: () => Promise.resolve(text('alice-ed25519.TEST-ONLY.sec.asc')) });
const carolOwn = (): KnownKey => ({ id: 'carol', kind: 'smime', owner: 'own', address: 'carol@example.test', fingerprint: 'see-certificate', publicKey: text('carol-smime.pem'), openPrivate: () => Promise.resolve(text('carol-smime.TEST-ONLY.key.pem')) });

// A throwaway self-signed RSA S/MIME certificate for an account's own address, made in the test run.
const tlv = (tag: number, content: Uint8Array, constructed = false): Buffer => encodeTlv(0, constructed, tag, content);
const seq = (...items: Buffer[]): Buffer => tlv(16, Buffer.concat(items), true);
const oid = (o: string): Buffer => tlv(6, encodeOid(o));
function selfSignedCert(email: string): { pem: string; key: KeyObject; keyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(tlv(17, seq(oid('2.5.4.3'), tlv(12, Buffer.from(`${email} (TEST ONLY)`))), true));
  const time = (d: Date): Buffer => tlv(23, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'latin1'));
  const ext = (id: string, value: Buffer): Buffer => seq(oid(id), tlv(4, value));
  const exts = [ext('2.5.29.17', seq(encodeTlv(2, false, 1, Buffer.from(email, 'latin1')))), ext('2.5.29.15', tlv(3, Buffer.of(0, 0xa0))), ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.4')))];
  const alg = seq(oid('1.2.840.113549.1.1.11'), Buffer.of(5, 0));
  const tbs = seq(encodeTlv(2, true, 0, tlv(2, Buffer.of(2))), tlv(2, Buffer.of(0x42, 0x17)), alg, name, seq(time(new Date('2026-01-01T00:00:00Z')), time(new Date('2046-01-01T00:00:00Z'))), name, publicKey.export({ format: 'der', type: 'spki' }), encodeTlv(2, true, 3, seq(...exts)));
  const der = seq(tbs, alg, tlv(3, Buffer.concat([Buffer.of(0), sign('sha256', tbs, privateKey)])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return { pem, key: privateKey, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

describe.skipIf(!baseUrl)('Keys and composer crypto (PST-T-12.2, PST-REQ-161)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  const kek = kekFromBase64(KEK_BASE64);
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    login: string;
    address: string;
    cookie: string;
    totpSecret: string;
    sent: string;
  }

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
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}` });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    await mk('Drafts', SpecialUse.drafts);
    return { id, login, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret), totpSecret, sent: sent.id };
  };

  const stepUp = async (who: Person): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', who.cookie).send({ code: totpCode(who.totpSecret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const post = (who: Person, path: string, body: unknown = {}) => request(app).post(path).set(CSRF).set('cookie', who.cookie).send(body as object);
  const get = (who: Person, path: string) => request(app).get(path).set('cookie', who.cookie);
  const generate = async (who: Person) => {
    const res = await post(who, '/api/keys/generate', { address: who.address });
    expect(res.status).toBe(201);
    return CryptoKeyCreated.parse(res.body).key;
  };
  const importKey = (who: Person, body: Record<string, unknown>) => post(who, '/api/keys/import', body);
  const audits = (accountId: string, action: string) => db.auditEvent.findMany({ where: { actorAccountId: accountId, action }, orderBy: { at: 'asc' } });

  const queuedBytes = async (outboundId: string): Promise<Buffer> => {
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: outboundId } });
    const chunks: Buffer[] = [];
    for await (const c of await blobs.get(row.blobSha256)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t122_keys');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t122-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('needs a session and the CSRF header', async () => {
    expect((await request(app).get('/api/keys')).status).toBe(401);
    const me = await person();
    expect((await request(app).post('/api/keys/generate').set('cookie', me.cookie).send({ address: me.address })).status).toBe(403);
  });

  it('generate: an own Ed25519+X25519 key for an own address, private half sealed under the KEK, audited', async () => {
    const me = await person();
    const key = await generate(me);
    expect(key).toMatchObject({ kind: 'pgp', owner: 'own', address: me.address, hasPrivate: true, revokedAt: null, algorithm: 'Ed25519 (EdDSALegacy) + ECDH Curve25519' });
    expect(key.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(key.userIds).toEqual([`Person ${me.login} <${me.address}>`]);
    const row = await db.cryptoKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.kekId).toBe(kek.id);
    const secret = openPrivateKey(kek, row);
    expect(typeof secret === 'string' && secret.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(true);
    // The seal is bound to the row: moved to another account it does not open.
    expect(openPrivateKey(kek, { ...row, accountId: (await person()).id })).toBeNull();
    const [audit] = await audits(me.id, 'crypto-key.generate');
    expect(audit?.entityId).toBe(key.id);
    expect(audit?.after).toMatchObject({ kind: 'pgp', owner: 'own', fingerprint: key.fingerprint, material: 'public+sealed' });
    expect(JSON.stringify(audit?.after)).not.toContain('BEGIN');

    const other = await post(me, '/api/keys/generate', { address: 'someone@d3cloud.io' });
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ error: 'address_not_owned' });
  });

  it('is account-scoped: another account neither lists, exports, revokes nor deletes it', async () => {
    const me = await person();
    const key = await generate(me);
    const imported = CryptoKeyCreated.parse((await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') })).body).key;
    const them = await person();
    expect(CryptoKeyList.parse((await get(them, '/api/keys')).body).keys).toEqual([]);
    expect((await get(them, `/api/keys/${key.id}/export`)).status).toBe(404);
    expect((await post(them, `/api/keys/${key.id}/revoke`)).status).toBe(404);
    expect((await request(app).delete(`/api/keys/${imported.id}`).set(CSRF).set('cookie', them.cookie)).status).toBe(404);
    await stepUp(them);
    expect((await post(them, `/api/keys/${key.id}/export-secret`)).status).toBe(404);
    expect(CryptoKeyList.parse((await get(me, '/api/keys')).body).keys.map((k) => k.id).sort()).toEqual([key.id, imported.id].sort());
  });

  it('import: a contact public key (fingerprint = the primary, upper-case), duplicates 409, two primaries refused', async () => {
    const me = await person();
    const res = await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    expect(res.status).toBe(201);
    expect(CryptoKeyCreated.parse(res.body).key).toMatchObject({ owner: 'contact', address: 'alice@example.test', fingerprint: ALICE_FPR, hasPrivate: false });
    expect((await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') })).status).toBe(409);

    // Two primary keys in ONE block (alice's packets then bob's): the verifier trusts only the row's
    // fingerprint, so storing it under either would be a lie about the other.
    const two = encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat([decodeArmor(text('alice-ed25519.pub.asc'))?.data ?? Buffer.alloc(0), decodeArmor(text('bob-rsa3072.pub.asc'))?.data ?? Buffer.alloc(0)]));
    const refused = await importKey(me, { kind: 'pgp', armored: two });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'multiple_primary_keys' });
    const twoBlocks = await importKey(me, { kind: 'pgp', armored: `${text('bob-rsa3072.pub.asc')}\n${text('alice-ed25519.pub.asc')}` });
    expect(twoBlocks.body).toMatchObject({ error: 'multiple_primary_keys' });
    expect((await importKey(me, { kind: 'pgp', armored: 'not a key' })).body).toMatchObject({ error: 'invalid_key' });
    expect((await audits(me.id, 'crypto-key.import')).length).toBe(1);
  });

  it('import: an own secret key, passphrase-protected — refused without it, and with a wrong one; someone else’s address refused', async () => {
    const me = await person();
    const g = generateKey({ userId: `Me <${me.address}>` });
    const locked = encodeArmor('PGP PRIVATE KEY BLOCK', protectSecretKeyBlock(g.secretBinary, 'open sesame'));
    expect((await importKey(me, { kind: 'pgp', armored: locked })).body).toMatchObject({ error: 'passphrase_required' });
    expect((await importKey(me, { kind: 'pgp', armored: locked, passphrase: 'nope' })).body).toMatchObject({ error: 'bad_passphrase' });
    const ok = await importKey(me, { kind: 'pgp', armored: locked, passphrase: 'open sesame' });
    expect(ok.status).toBe(201);
    expect(CryptoKeyCreated.parse(ok.body).key).toMatchObject({ owner: 'own', fingerprint: g.fingerprint, hasPrivate: true });
    const row = await db.cryptoKey.findFirstOrThrow({ where: { accountId: me.id, fingerprint: g.fingerprint } });
    // Stored unprotected, sealed: the verifier can open it without a passphrase.
    const [opened] = parseKeys(decodeArmor(String(openPrivateKey(kek, row)))?.data ?? Buffer.alloc(0));
    expect(opened?.primary.secretKey).not.toBeNull();

    const notMine = await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.TEST-ONLY.sec.asc') });
    expect(notMine.status).toBe(400);
    expect(notMine.body).toMatchObject({ error: 'address_mismatch' });
  });

  it("import: a secret block whose secret material is another key's is refused (key_mismatch), and nothing is stored", async () => {
    const me = await person();
    const a = generateKey({ userId: `Me <${me.address}>` });
    const b = generateKey({ userId: `Me <${me.address}>` });
    const pa = readPackets(a.secretBinary);
    const secA = pa.find((p) => p.tag === Tag.SecretKey);
    const secB = readPackets(b.secretBinary).find((p) => p.tag === Tag.SecretKey);
    if (secA === undefined || secB === undefined) throw new Error('no secret packet');
    const pubLen = a.key.primary.body.length;
    const spliced = Buffer.concat([secA.body.subarray(0, pubLen), secB.body.subarray(pubLen)]);
    const armored = encodeArmor('PGP PRIVATE KEY BLOCK', Buffer.concat(pa.map((p) => encodePacket(p.tag, p === secA ? spliced : p.body))));
    const res = await importKey(me, { kind: 'pgp', armored });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'key_mismatch' });
    expect(await db.cryptoKey.count({ where: { accountId: me.id } })).toBe(0);
  });

  it('import S/MIME: a contact certificate (fingerprint = SHA-256 of the DER), and an own certificate + PKCS#8 key', async () => {
    const me = await person();
    const carol = await importKey(me, { kind: 'smime', certificate: text('carol-smime.pem') });
    expect(carol.status).toBe(201);
    const der = Buffer.from(text('carol-smime.pem').replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(CryptoKeyCreated.parse(carol.body).key).toMatchObject({ kind: 'smime', owner: 'contact', address: 'carol@example.test', fingerprint: createHash('sha256').update(der).digest('hex'), algorithm: 'RSA-2048' });
    const mine = selfSignedCert(me.address);
    const wrongKey = await importKey(me, { kind: 'smime', certificate: mine.pem, privateKey: text('carol-smime.TEST-ONLY.key.pem') });
    expect(wrongKey.body).toMatchObject({ error: 'key_mismatch' });
    const own = await importKey(me, { kind: 'smime', certificate: mine.pem, privateKey: mine.keyPem });
    expect(own.status).toBe(201);
    expect(CryptoKeyCreated.parse(own.body).key).toMatchObject({ owner: 'own', address: me.address, hasPrivate: true });
  });

  it('export: public for anyone signed in; secret only after a fresh step-up, audited, optionally protected', async () => {
    const me = await person();
    const key = await generate(me);
    const pub = await get(me, `/api/keys/${key.id}/export`);
    expect(pub.status).toBe(200);
    expect((pub.body as { publicKey: string }).publicKey).toContain('BEGIN PGP PUBLIC KEY BLOCK');

    const noStepUp = await post(me, `/api/keys/${key.id}/export-secret`);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
    await stepUp(me);
    const plain = KeySecretExport.parse((await post(me, `/api/keys/${key.id}/export-secret`)).body);
    expect(plain.protected).toBe(false);
    expect(parseKeys(decodeArmor(plain.secret)?.data ?? Buffer.alloc(0))[0]?.primary.fingerprint).toBe(key.fingerprint);
    const locked = KeySecretExport.parse((await post(me, `/api/keys/${key.id}/export-secret`, { passphrase: 'a long passphrase' })).body);
    expect(locked.protected).toBe(true);
    expect(() => parseKeys(decodeArmor(locked.secret)?.data ?? Buffer.alloc(0))).toThrow();
    const rows = await audits(me.id, 'crypto-key.export-secret');
    expect(rows.map((r) => (r.after as { protected: boolean }).protected)).toEqual([false, true]);

    const contact = CryptoKeyCreated.parse((await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') })).body).key;
    expect((await post(me, `/api/keys/${contact.id}/export-secret`)).status).toBe(409);
  });

  it('revoke: an own OpenPGP key gets a stored 0x20 revocation; contacts are deleted, own keys never; all audited', async () => {
    const me = await person();
    const key = await generate(me);
    const res = await post(me, `/api/keys/${key.id}/revoke`, { reason: 'compromised', text: 'lost laptop' });
    expect(res.status).toBe(200);
    const revoked = CryptoKeyCreated.parse(res.body).key;
    expect(revoked.revokedAt).not.toBeNull();
    const row = await db.cryptoKey.findUniqueOrThrow({ where: { id: key.id } });
    const [k] = parseKeys(decodeArmor(row.publicKey)?.data ?? Buffer.alloc(0));
    if (k === undefined) throw new Error('no key');
    expect(keyState(k, k.primary).revocations).toEqual([expect.objectContaining({ of: 'primary', reason: 2, verified: true, hard: true })]);
    expect((await post(me, `/api/keys/${key.id}/revoke`)).status).toBe(409);
    const [audit] = await audits(me.id, 'crypto-key.revoke');
    expect(audit?.after).toMatchObject({ reason: 'compromised', revocationSigned: true });

    expect((await request(app).delete(`/api/keys/${key.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(409);
    const contact = CryptoKeyCreated.parse((await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') })).body).key;
    expect((await request(app).delete(`/api/keys/${contact.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    expect(await db.cryptoKey.count({ where: { id: contact.id } })).toBe(0);
    expect((await audits(me.id, 'crypto-key.delete')).map((a) => a.entityId)).toEqual([contact.id]);
  });

  it('doneWhen (OpenPGP): sign + encrypt → a queued message the verifier decrypts with the recipient TEST key and reports verified-known-key', async () => {
    const me = await person();
    const mine = await generate(me);
    await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['Alice <alice@example.test>'], subject: 'Sealed', text: 'Only for Alice.\n', crypto: { sign: 'pgp', encrypt: 'pgp' } });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const raw = await queuedBytes(sent.outboundId);
    const head = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1');
    expect(head).toMatch(/^DKIM-Signature:/m);
    expect(head).toContain('Subject: Sealed');
    expect(head).toMatch(/Content-Type: multipart\/encrypted;\r\n protocol="application\/pgp-encrypted"/);
    expect(raw.toString('latin1')).not.toContain('Only for Alice');

    // The recipient: their own TEST key opens it; the sender's key, known to them, verifies it.
    const senderAsContact: KnownKey = { id: 'sender', kind: 'pgp', owner: 'contact', address: me.address, fingerprint: mine.fingerprint, publicKey: KeyPublicExport.parse((await get(me, `/api/keys/${mine.id}/export`)).body).publicKey };
    const r = await analyzeMessage([raw], [aliceOwn(), senderAsContact], { now: clock.now() });
    expect(r.encryption).toMatchObject({ status: 'decrypted', format: 'pgp-mime', cipher: 'AES-256', integrity: 'MDC (SEIPD v1)' });
    expect(r.encryption.recipients).toHaveLength(2);
    expect(r.signature).toMatchObject({ status: 'verified-known-key', format: 'pgp-mime' });
    expect(r.signature.signer).toMatchObject({ fingerprint: mine.fingerprint, fromMatches: true });

    // The sender's own key is always a recipient: the Sent copy (the same blob) opens with the account's keys.
    const own = await analyzeMessage([raw], await loadAccountKeys(db, me.id, kek), { now: clock.now() });
    expect(own.encryption.status).toBe('decrypted');
    expect(own.encryption.openedWithKeyId).toBe(mine.id);
    expect(own.signature.status).toBe('verified-known-key');
    const sentRow = await db.message.findUniqueOrThrow({ where: { id: sent.sentMessageId } });
    expect(sentRow.blobSha256).toBe((await db.outboundMessage.findUniqueOrThrow({ where: { id: sent.outboundId } })).blobSha256);
  });

  it('OpenPGP sign only: multipart/signed that the verifier reports verified-known-key', async () => {
    const me = await person();
    await generate(me);
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['someone@example.test'], subject: 'Signed', text: 'Signed, not sealed.\n', format: 'markdown', crypto: { sign: 'pgp' } });
    expect(res.status).toBe(201);
    const raw = await queuedBytes(SendResponse.parse(res.body).outboundId);
    expect(raw.toString('latin1')).toContain('multipart/alternative');
    const r = await analyzeMessage([raw], await loadAccountKeys(db, me.id, kek), { now: clock.now() });
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.encryption.status).toBe('not-encrypted');
  });

  it('doneWhen (S/MIME): sign + encrypt → the verifier decrypts with carol’s TEST key and verifies the signature', async () => {
    const me = await person();
    const cert = selfSignedCert(me.address);
    const own = CryptoKeyCreated.parse((await importKey(me, { kind: 'smime', certificate: cert.pem, privateKey: cert.keyPem })).body).key;
    await importKey(me, { kind: 'smime', certificate: text('carol-smime.pem') });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['carol@example.test'], subject: 'S/MIME', text: 'For Carol.\n', crypto: { sign: 'smime', encrypt: 'smime' } });
    expect(res.status).toBe(201);
    const raw = await queuedBytes(SendResponse.parse(res.body).outboundId);
    expect(raw.toString('latin1')).toMatch(/Content-Type: application\/pkcs7-mime; smime-type=enveloped-data/);
    const senderCert: KnownKey = { id: 'sender', kind: 'smime', owner: 'contact', address: me.address, fingerprint: own.fingerprint, publicKey: cert.pem };
    const r = await analyzeMessage([raw], [carolOwn(), senderCert], { now: clock.now() });
    expect(r.encryption).toMatchObject({ status: 'decrypted', format: 'smime', cipher: 'AES-256-CBC' });
    expect(r.signature).toMatchObject({ status: 'verified-known-key', format: 'smime' });
    expect((await analyzeMessage([raw], await loadAccountKeys(db, me.id, kek), { now: clock.now() })).encryption.status).toBe('decrypted');
  });

  it('a recipient without a key: 409 naming them, and nothing is queued; no own key: refused too', async () => {
    const me = await person();
    await generate(me);
    await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const before = await db.outboundMessage.count({ where: { accountId: me.id } });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['alice@example.test', 'Bob <bob@example.test>'], bcc: ['hidden@example.test'], subject: 'x', text: 'x', crypto: { encrypt: 'pgp' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'recipient_keys_missing', recipients: ['bob@example.test', 'hidden@example.test'] });
    expect(await db.outboundMessage.count({ where: { accountId: me.id } })).toBe(before);

    const bare = await person();
    const noKey = await post(bare, '/api/compose/send', { from: bare.address, to: ['alice@example.test'], subject: 'x', text: 'x', crypto: { sign: 'pgp' } });
    expect(noKey.status).toBe(409);
    expect(noKey.body).toMatchObject({ error: 'signing_key_missing' });
    await importKey(bare, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const noOwn = await post(bare, '/api/compose/send', { from: bare.address, to: ['alice@example.test'], subject: 'x', text: 'x', crypto: { encrypt: 'pgp' } });
    expect(noOwn.body).toMatchObject({ error: 'own_key_missing' });
    const mixed = await post(me, '/api/compose/send', { from: me.address, to: ['alice@example.test'], subject: 'x', text: 'x', crypto: { sign: 'pgp', encrypt: 'smime' } });
    expect(mixed.body).toMatchObject({ error: 'crypto_mixed' });
  });

  it('a held (undo-window) send holds the encrypted message, not the plaintext', async () => {
    const me = await person();
    await generate(me);
    await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['alice@example.test'], subject: 'Later', text: 'Held secret.\n', undoSeconds: 10, crypto: { encrypt: 'pgp' } });
    expect(res.status).toBe(202);
    const pending = await db.pendingSend.findFirstOrThrow({ where: { accountId: me.id } });
    const chunks: Buffer[] = [];
    for await (const c of await blobs.get(pending.heldBlobSha256)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    const held = Buffer.concat(chunks);
    expect(held.toString('latin1')).toContain('multipart/encrypted');
    expect(held.toString('latin1')).not.toContain('Held secret');
    expect((await analyzeMessage([held], [aliceOwn()], { now: clock.now() })).encryption.status).toBe('decrypted');
  });
});
