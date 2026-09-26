// PST-T-12.6, PST-REQ-161: encrypted mail hides its Bcc recipients, and a signature survives a relay
// that strips trailing whitespace — against a real database, a real blob store, gpg and openssl.
//   · an OpenPGP-encrypted send To alice, Bcc bob: the main copy is queued to alice only and none of
//     its PKESKs names bob's key; bob's own copy is queued to bob only, carries no Bcc header, and
//     gpg decrypts it with bob's TEST key; Sent keeps the main copy; every copy is audited;
//   · the S/MIME equivalent: no RecipientInfo in the main copy names dave's certificate, openssl cms
//     -decrypt opens dave's copy with dave's key and refuses the main copy;
//   · a held (undo) OpenPGP send hides Bcc behind the wildcard key ID; a held S/MIME one is refused;
//   · a signed send whose body has trailing spaces and a 900-character line: every line of the queued
//     bytes stripped of trailing whitespace, and gpg --verify / openssl cms -verify still pass.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomInt, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { certificatesFromPem, decodeArmor, encodeOid, encodeTlv, generateKey, parseContentInfo, parseEnvelopedData, parseKeys, readPackets, Tag, type OpenPgpKey } from '@postroom/pgp';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { CryptoKeyCreated, KeyPublicExport } from '../../src/keys/schemas.js';
import { SendResponse } from '../../src/compose/schemas.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'pgp', 'test', 'fixtures');
const text = (f: string): string => readFileSync(join(FIXTURES, f), 'utf8');

function tool(name: string): string | null {
  const brew = `/opt/homebrew/bin/${name}`;
  if (existsSync(brew)) return brew;
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  if (path === '') return null;
  // macOS's /usr/bin/openssl is LibreSSL, whose `cms` is not the one these tests mean.
  return name === 'openssl' && !spawnSync(path, ['version'], { encoding: 'utf8' }).stdout.startsWith('OpenSSL 3') ? null : path;
}
const GPG = tool('gpg');
const OPENSSL = tool('openssl');
if (GPG === null) process.stderr.write('compose-crypto: gpg not found — skipping the gpg checks (install GnuPG 2.4+ to run them)\n');
if (OPENSSL === null) process.stderr.write('compose-crypto: OpenSSL 3 not found — skipping the openssl cms checks\n');

// A throwaway self-signed RSA S/MIME certificate for an address, made in the test run.
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

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pst-t126-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
// The API's TestClock runs ahead of the wall clock (each sign-in advances it), so keys and
// signatures it dates are "in the future" to gpg: --ignore-time-conflict, as for any clock skew.
const gpgIn = (home: string, args: string[], input?: Buffer | string) =>
  spawnSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--trust-model', 'always', '--ignore-time-conflict', ...args], { input, maxBuffer: 16 * 1024 * 1024 });
const openssl = (args: string[], input?: Buffer) => spawnSync(OPENSSL ?? 'openssl', args, { input, maxBuffer: 16 * 1024 * 1024 });

/** The armored OpenPGP message inside a PGP/MIME message, as its packets. */
function pgpMessage(raw: Buffer): { armored: string; pkeskKeyIds: string[] } {
  const s = raw.toString('latin1');
  const from = s.indexOf('-----BEGIN PGP MESSAGE-----');
  const to = s.indexOf('-----END PGP MESSAGE-----');
  expect(from).toBeGreaterThan(0);
  const armored = s.slice(from, to + '-----END PGP MESSAGE-----'.length);
  const packets = readPackets(decodeArmor(armored)?.data ?? Buffer.alloc(0));
  return { armored, pkeskKeyIds: packets.filter((p) => p.tag === Tag.PKESK).map((p) => p.body.subarray(1, 9).toString('hex').toUpperCase()) };
}
const keyIdsOf = (k: OpenPgpKey): string[] => [k.primary.keyId, ...k.subkeys.map((s) => s.keyId)];
const headerOf = (raw: Buffer): string => raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1');
/** What a hostile relay does: every line loses its trailing whitespace. */
const stripTrailing = (b: Buffer): Buffer => Buffer.from(b.toString('latin1').replace(/[ \t]+\r\n/g, '\r\n'), 'latin1');

describe.skipIf(!baseUrl)('Encrypted Bcc and relay-proof signatures (PST-T-12.6, PST-REQ-161)', () => {
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
    address: string;
    cookie: string;
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
    await mk('Sent', SpecialUse.sent);
    await mk('Drafts', SpecialUse.drafts);
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret) };
  };

  const post = (who: Person, path: string, body: unknown = {}) => request(app).post(path).set(CSRF).set('cookie', who.cookie).send(body as object);
  const generate = async (who: Person) => {
    const res = await post(who, '/api/keys/generate', { address: who.address });
    expect(res.status).toBe(201);
    const key = CryptoKeyCreated.parse(res.body).key;
    const exp = await request(app).get(`/api/keys/${key.id}/export`).set('cookie', who.cookie);
    return { ...key, publicArmored: KeyPublicExport.parse(exp.body).publicKey };
  };
  const importKey = async (who: Person, body: Record<string, unknown>) => {
    const res = await post(who, '/api/keys/import', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const blobBytes = async (sha: string): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of await blobs.get(sha)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  };
  /** Every queued message of the account, with its envelope recipients and bytes. */
  const queued = async (accountId: string) => {
    const rows = await db.outboundMessage.findMany({ where: { accountId }, include: { recipients: true }, orderBy: { createdAt: 'asc' } });
    return Promise.all(rows.map(async (r) => ({ id: r.id, blobSha256: r.blobSha256, to: r.recipients.map((x) => x.address).sort(), raw: await blobBytes(r.blobSha256) })));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t126_crypto');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t126-blobs-'));
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
    const gpgconf = GPG === null ? null : join(GPG, '..', 'gpgconf');
    for (const d of dirs) {
      if (gpgconf !== null && existsSync(gpgconf)) spawnSync(gpgconf, ['--homedir', d, '--kill', 'all']);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('OpenPGP To alice, Bcc bob: the main copy never names bob; bob gets his own copy, queued only to him, that gpg opens with his TEST key', async () => {
    const me = await person();
    const mine = await generate(me);
    await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const bob = generateKey({ userId: 'Bob Hidden <bob@example.test>' });
    await importKey(me, { kind: 'pgp', armored: bob.publicArmored });
    const [alice] = parseKeys(decodeArmor(text('alice-ed25519.pub.asc'))?.data ?? Buffer.alloc(0));
    const [own] = parseKeys(decodeArmor(mine.publicArmored)?.data ?? Buffer.alloc(0));
    if (alice === undefined || own === undefined) throw new Error('keys');

    const res = await post(me, '/api/compose/send', { from: me.address, to: ['Alice <alice@example.test>'], bcc: ['Bob Hidden <bob@example.test>'], subject: 'Sealed with a Bcc', text: 'For Alice, and quietly Bob.\n', crypto: { sign: 'pgp', encrypt: 'pgp' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = SendResponse.parse(res.body);
    const all = await queued(me.id);
    expect(all).toHaveLength(2);
    const main = all.find((q) => q.id === sent.outboundId);
    const bobs = all.find((q) => q.id !== sent.outboundId);
    if (main === undefined || bobs === undefined) throw new Error('copies');

    // The main copy: To alice only; its PKESKs are alice's and the sender's, never bob's (nor a wildcard).
    expect(main.to).toEqual(['alice@example.test']);
    const mainPgp = pgpMessage(main.raw);
    expect(mainPgp.pkeskKeyIds).toHaveLength(2);
    for (const id of keyIdsOf(bob.key)) expect(mainPgp.pkeskKeyIds).not.toContain(id);
    expect(mainPgp.pkeskKeyIds).not.toContain('0000000000000000');
    expect(mainPgp.pkeskKeyIds.some((id) => keyIdsOf(alice).includes(id))).toBe(true);
    expect(mainPgp.pkeskKeyIds.some((id) => keyIdsOf(own).includes(id))).toBe(true);
    expect(main.raw.toString('latin1')).not.toMatch(/bob@example\.test/i);

    // Bob's copy: queued to bob only; no Bcc header; encrypted to bob and the sender, not alice.
    expect(bobs.to).toEqual(['bob@example.test']);
    expect(headerOf(bobs.raw)).not.toMatch(/^Bcc:/im);
    expect(headerOf(bobs.raw)).toContain('Subject: Sealed with a Bcc');
    const bobPgp = pgpMessage(bobs.raw);
    expect(bobPgp.pkeskKeyIds.some((id) => keyIdsOf(bob.key).includes(id))).toBe(true);
    for (const id of keyIdsOf(alice)) expect(bobPgp.pkeskKeyIds).not.toContain(id);
    expect(bobs.raw.toString('latin1')).not.toContain('For Alice');

    // Sent keeps the main copy.
    const sentRow = await db.message.findUniqueOrThrow({ where: { id: sent.sentMessageId } });
    expect(sentRow.blobSha256).toBe(main.blobSha256);

    // Every queued copy is audited as a send; the Bcc copy has its own compose audit row.
    expect(await db.auditEvent.count({ where: { action: 'submission.accept', entityId: { in: [main.id, bobs.id] } } })).toBe(2);
    const bccAudit = await db.auditEvent.findMany({ where: { actorAccountId: me.id, action: 'compose.send-bcc-copy' } });
    expect(bccAudit.map((a) => a.entityId)).toEqual([bobs.id]);

    if (GPG === null) return;
    const home = scratch();
    expect(gpgIn(home, ['--import'], bob.secretArmored).status).toBe(0);
    const opened = gpgIn(home, ['--decrypt'], bobPgp.armored);
    expect(opened.status, opened.stderr.toString()).toBe(0);
    expect(opened.stdout.toString('latin1')).toContain('For Alice, and quietly Bob.');
    expect(opened.stdout.toString('latin1')).toMatch(/multipart\/signed/);
    // And bob's key does not open the main copy.
    expect(gpgIn(home, ['--decrypt'], mainPgp.armored).status).not.toBe(0);
  });

  it('a Bcc-only encrypted send: queued only to the Bcc recipient; Sent keeps a copy encrypted to the sender alone', async () => {
    const me = await person();
    const mine = await generate(me);
    const bob = generateKey({ userId: 'Bob <bob@example.test>' });
    await importKey(me, { kind: 'pgp', armored: bob.publicArmored });
    const [own] = parseKeys(decodeArmor(mine.publicArmored)?.data ?? Buffer.alloc(0));
    if (own === undefined) throw new Error('own');
    const res = await post(me, '/api/compose/send', { from: me.address, bcc: ['bob@example.test'], subject: 'Only Bcc', text: 'Bcc only.\n', crypto: { encrypt: 'pgp' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = SendResponse.parse(res.body);
    const all = await queued(me.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.to).toEqual(['bob@example.test']);
    const sentRow = await db.message.findUniqueOrThrow({ where: { id: sent.sentMessageId } });
    expect(sentRow.blobSha256).not.toBe(all[0]?.blobSha256);
    expect(pgpMessage(await blobBytes(sentRow.blobSha256)).pkeskKeyIds).toEqual([own.subkeys[0]?.keyId]);
  });

  it('S/MIME To carol, Bcc dave: no RecipientInfo of the main copy names dave; openssl opens dave’s own copy with his key, not the main one', async () => {
    const me = await person();
    const cert = selfSignedCert(me.address);
    await importKey(me, { kind: 'smime', certificate: cert.pem, privateKey: cert.keyPem });
    await importKey(me, { kind: 'smime', certificate: text('carol-smime.pem') });
    const dave = selfSignedCert('dave@example.test');
    await importKey(me, { kind: 'smime', certificate: dave.pem });
    const [daveCert] = certificatesFromPem(dave.pem);
    const [carolCert] = certificatesFromPem(text('carol-smime.pem'));
    if (daveCert === undefined || carolCert === undefined) throw new Error('certs');

    const res = await post(me, '/api/compose/send', { from: me.address, to: ['carol@example.test'], bcc: ['dave@example.test'], subject: 'S/MIME Bcc', text: 'For Carol; Dave sees it too.\n', crypto: { sign: 'smime', encrypt: 'smime' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = SendResponse.parse(res.body);
    const all = await queued(me.id);
    expect(all).toHaveLength(2);
    const main = all.find((q) => q.id === sent.outboundId);
    const daves = all.find((q) => q.id !== sent.outboundId);
    if (main === undefined || daves === undefined) throw new Error('copies');
    expect(main.to).toEqual(['carol@example.test']);
    expect(daves.to).toEqual(['dave@example.test']);
    expect(headerOf(daves.raw)).not.toMatch(/^Bcc:/im);

    const rids = (raw: Buffer) => {
      const b64 = raw.subarray(raw.indexOf('\r\n\r\n') + 4).toString('latin1').replace(/\s+/g, '');
      const ci = parseContentInfo(Buffer.from(b64, 'base64'));
      return parseEnvelopedData(ci.content).recipients.map((r) => r.rid);
    };
    const names = (c: typeof daveCert) => (rid: ReturnType<typeof rids>[number]) => rid.kind === 'issuer-serial' && rid.issuer.equals(c.issuerRaw) && rid.serial.equals(c.serial);
    const mainRids = rids(main.raw);
    expect(mainRids).toHaveLength(2);
    expect(mainRids.some(names(daveCert))).toBe(false);
    expect(mainRids.some(names(carolCert))).toBe(true);
    const daveRids = rids(daves.raw);
    expect(daveRids.some(names(daveCert))).toBe(true);
    expect(daveRids.some(names(carolCert))).toBe(false);

    if (OPENSSL === null) return;
    const dir = scratch();
    writeFileSync(join(dir, 'dave.key'), dave.keyPem);
    writeFileSync(join(dir, 'dave.pem'), dave.pem);
    writeFileSync(join(dir, 'dave.eml'), daves.raw);
    writeFileSync(join(dir, 'main.eml'), main.raw);
    const ok = openssl(['cms', '-decrypt', '-in', join(dir, 'dave.eml'), '-inkey', join(dir, 'dave.key'), '-recip', join(dir, 'dave.pem')]);
    expect(ok.status, ok.stderr.toString()).toBe(0);
    expect(ok.stdout.toString('latin1')).toMatch(/multipart\/signed/);
    expect(openssl(['cms', '-decrypt', '-in', join(dir, 'main.eml'), '-inkey', join(dir, 'dave.key'), '-recip', join(dir, 'dave.pem')]).status).not.toBe(0);
  });

  it('a held OpenPGP send hides Bcc behind the wildcard key ID (gpg still opens it with bob’s key); a held S/MIME one is refused', async () => {
    const me = await person();
    await generate(me);
    await importKey(me, { kind: 'pgp', armored: text('alice-ed25519.pub.asc') });
    const bob = generateKey({ userId: 'Bob <bob@example.test>' });
    await importKey(me, { kind: 'pgp', armored: bob.publicArmored });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['alice@example.test'], bcc: ['bob@example.test'], subject: 'Held', text: 'Held secret.\n', undoSeconds: 10, crypto: { encrypt: 'pgp' } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const pending = await db.pendingSend.findFirstOrThrow({ where: { accountId: me.id } });
    expect([...pending.recipients].sort()).toEqual(['alice@example.test', 'bob@example.test']);
    const held = await blobBytes(pending.heldBlobSha256);
    const pgp = pgpMessage(held);
    expect(pgp.pkeskKeyIds).toHaveLength(3);
    expect(pgp.pkeskKeyIds).toContain('0000000000000000');
    for (const id of keyIdsOf(bob.key)) expect(pgp.pkeskKeyIds).not.toContain(id);
    if (GPG !== null) {
      const home = scratch();
      expect(gpgIn(home, ['--import'], bob.secretArmored).status).toBe(0);
      const opened = gpgIn(home, ['--decrypt'], pgp.armored);
      expect(opened.status, opened.stderr.toString()).toBe(0);
      expect(opened.stdout.toString('latin1')).toContain('Held secret.');
    }

    const cert = selfSignedCert(me.address);
    await importKey(me, { kind: 'smime', certificate: cert.pem, privateKey: cert.keyPem });
    await importKey(me, { kind: 'smime', certificate: text('carol-smime.pem') });
    const dave = selfSignedCert('dave@example.test');
    await importKey(me, { kind: 'smime', certificate: dave.pem });
    const refused = await post(me, '/api/compose/send', { from: me.address, to: ['carol@example.test'], bcc: ['dave@example.test'], subject: 'Held', text: 'x', undoSeconds: 10, crypto: { encrypt: 'smime' } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'smime_bcc_held' });
    expect(await db.pendingSend.count({ where: { accountId: me.id } })).toBe(1);
  });

  const HOSTILE = `Trailing spaces here   \nand a tab\t\n${'y'.repeat(900)}\nFrom the top\nend\n`;

  it('OpenPGP-signed: after every queued line loses its trailing whitespace, gpg --verify is still GOOD', async () => {
    const me = await person();
    const mine = await generate(me);
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['someone@example.test'], subject: 'Relay-proof', text: HOSTILE, crypto: { sign: 'pgp' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [q] = await queued(me.id);
    if (q === undefined) throw new Error('queued');
    const relayed = stripTrailing(q.raw);
    const s = relayed.toString('latin1');
    const boundary = /boundary="([^"]+)"/.exec(headerOf(relayed))?.[1] ?? '';
    expect(boundary).not.toBe('');
    // The signed entity: after the first delimiter line up to the CRLF before the second (RFC 1847).
    const body = s.slice(s.indexOf('\r\n\r\n') + 4);
    const first = body.indexOf(`--${boundary}\r\n`) + boundary.length + 4;
    const second = body.indexOf(`\r\n--${boundary}\r\n`, first);
    const signedPart = body.slice(first, second);
    expect(signedPart).toMatch(/Content-Transfer-Encoding: quoted-printable/);
    for (const line of signedPart.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    const sigArmor = body.slice(body.indexOf('-----BEGIN PGP SIGNATURE-----'), body.indexOf('-----END PGP SIGNATURE-----') + '-----END PGP SIGNATURE-----'.length);

    if (GPG === null) return;
    const home = scratch();
    const imp = gpgIn(home, ['--import'], mine.publicArmored);
    expect(imp.status, imp.stderr.toString()).toBe(0);
    writeFileSync(join(home, 'part'), Buffer.from(signedPart, 'latin1'));
    writeFileSync(join(home, 'part.asc'), sigArmor);
    const v = gpgIn(home, ['--status-fd', '1', '--verify', join(home, 'part.asc'), join(home, 'part')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stdout.toString()).toContain('GOODSIG');
  });

  it('S/MIME-signed: after the same strip, openssl cms -verify still succeeds', async () => {
    const me = await person();
    const cert = selfSignedCert(me.address);
    await importKey(me, { kind: 'smime', certificate: cert.pem, privateKey: cert.keyPem });
    const res = await post(me, '/api/compose/send', { from: me.address, to: ['someone@example.test'], subject: 'Relay-proof S/MIME', text: HOSTILE, crypto: { sign: 'smime' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [q] = await queued(me.id);
    if (q === undefined) throw new Error('queued');
    const relayed = stripTrailing(q.raw);
    expect(relayed.toString('latin1')).toMatch(/Content-Transfer-Encoding: quoted-printable/);

    if (OPENSSL === null) return;
    const dir = scratch();
    writeFileSync(join(dir, 'relayed.eml'), relayed);
    writeFileSync(join(dir, 'ca.pem'), cert.pem);
    const v = openssl(['cms', '-verify', '-in', join(dir, 'relayed.eml'), '-CAfile', join(dir, 'ca.pem'), '-purpose', 'smimesign', '-out', join(dir, 'out')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stderr.toString()).toContain('Verification successful');
  });
});
