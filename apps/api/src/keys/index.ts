// The Keys screen's API (PST-T-12.2, PST-REQ-161): the account's own OpenPGP keys and S/MIME
// certificates, and its contacts' public keys — the crypto_key rows PST-T-12.1's verifier reads and
// the composer signs and encrypts with. Mounted by app.ts at /api/keys behind a session and the
// CSRF guard; every row is the caller's own (account-scoped), and every mutation is audited.
//
//   GET    /api/keys                    every key of the caller
//   POST   /api/keys/generate           a new own OpenPGP key: Ed25519 + X25519 (v4)
//   POST   /api/keys/import             an armored OpenPGP key (public → contact, secret → own), or a
//                                       PEM certificate (+ PKCS#8 key → own)
//   GET    /api/keys/:id/export         the public half (with any revocation)
//   POST   /api/keys/:id/export-secret  the private half — needs a fresh step-up, and is audited
//   POST   /api/keys/:id/revoke         revoke; an own OpenPGP key also gets a 0x20 revocation signature
//   DELETE /api/keys/:id                remove a contact's key (own keys are revoked, never deleted:
//                                       old mail encrypted to them must still open)
//
// A private half is sealed under the KEK with the AAD that binds it to its row (account, kind,
// fingerprint) — mail/crypto-keys.ts's sealPrivateKey, exactly as the verifier opens it.
import { createPrivateKey } from 'node:crypto';
import { audited, getAuditContext } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { decodeArmor, encodeArmor, generateKey, parseKeys, protectSecretKeyBlock, publicKeyBlock, revocationSignature, RevocationReason, withKeySignature } from '@postroom/pgp';
import { sendableAddresses } from '@postroom/submission';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { openPrivateKey, sealPrivateKey } from '../mail/crypto-keys.js';
import { KeyError, pgpRowFromArmored, smimeRowFromPem, userIdsOf, type KeyRowData } from './material.js';
import { ExportSecretBody, GenerateKeyBody, ImportKeyBody, KeyIdParam, RevokeKeyBody, type CryptoKeyJson } from './schemas.js';

/** A crypto_key row as Prisma returns it. */
export type CryptoKey = Awaited<ReturnType<Db['cryptoKey']['findFirstOrThrow']>>;

export function keyJson(row: CryptoKey): CryptoKeyJson {
  return {
    id: row.id,
    kind: row.kind === 'smime' ? 'smime' : 'pgp',
    owner: row.owner === 'own' ? 'own' : 'contact',
    address: row.address,
    fingerprint: row.fingerprint,
    algorithm: row.algorithm,
    userIds: userIdsOf(row.kind, row.publicKey),
    hasPrivate: row.sealedPrivate !== null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the audit row records about a key: never its material. */
const auditView = (row: Pick<CryptoKey, 'kind' | 'owner' | 'address' | 'fingerprint' | 'algorithm' | 'revokedAt'>): Record<string, unknown> => ({
  kind: row.kind,
  owner: row.owner,
  address: row.address,
  fingerprint: row.fingerprint,
  algorithm: row.algorithm,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

export function keyRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  const refuse = (res: Response, error: unknown): boolean => {
    if (error instanceof KeyError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return true;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: 'duplicate_key', message: 'That key is already in your keys.' });
      return true;
    }
    return false;
  };

  /** The caller's row, or null after answering 404. */
  const ownRow = async (req: Request, res: Response): Promise<CryptoKey | null> => {
    const params = KeyIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    const row = await db.cryptoKey.findFirst({ where: { id: params.data.id, accountId: currentSession(req).accountId } });
    if (row === null) res.status(404).json({ error: 'not_found' });
    return row;
  };

  /** Insert a row, sealing its private half under the KEK first. Audited by the caller's audited(). */
  const insert = async (req: Request, res: Response, data: KeyRowData, action: string): Promise<void> => {
    const me = currentSession(req);
    if (data.privatePlain !== null && rt.kek === null) {
      res.status(503).json({ error: 'kek_not_configured', message: 'POSTROOM_KEK is not set, so a private key cannot be stored.' });
      return;
    }
    const kek = rt.kek;
    const sealed = data.privatePlain === null || kek === null ? null : sealPrivateKey(kek, me.accountId, data.kind, data.fingerprint, data.privatePlain);
    const row = await audited(db, { kind: 'account', accountId: me.accountId }, { action, entityType: 'crypto_key', context: getAuditContext(req) }, async (tx) => {
      const created = await tx.cryptoKey.create({
        data: {
          accountId: me.accountId,
          kind: data.kind,
          owner: data.owner,
          address: data.address.toLowerCase(),
          fingerprint: data.fingerprint,
          algorithm: data.algorithm,
          publicKey: data.publicKey,
          sealedPrivate: sealed === null ? null : new Uint8Array(sealed.sealedPrivate),
          kekId: sealed?.kekId ?? null,
          expiresAt: data.expiresAt,
          revokedAt: data.revokedAt,
        },
      });
      return { entityId: created.id, before: null, after: { ...auditView(created), material: sealed === null ? 'public' : 'public+sealed' }, result: created };
    });
    res.status(201).json({ key: keyJson(row) });
  };

  router.get(
    '/',
    handle(async (req, res) => {
      const rows = await db.cryptoKey.findMany({ where: { accountId: currentSession(req).accountId }, orderBy: [{ owner: 'desc' }, { address: 'asc' }, { createdAt: 'asc' }] });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ keys: rows.map(keyJson) });
    }),
  );

  router.post(
    '/generate',
    handle(async (req, res) => {
      const body = parse(GenerateKeyBody, req.body, res);
      if (body === null) return;
      const me = currentSession(req);
      const own = await sendableAddresses(db, me.accountId);
      if (!own.includes(body.address)) {
        res.status(403).json({ error: 'address_not_owned', message: 'A key can be made only for one of your own addresses.' });
        return;
      }
      const account = await db.account.findUnique({ where: { id: me.accountId }, select: { displayName: true } });
      const name = (body.name ?? account?.displayName ?? '').trim();
      const g = generateKey({ userId: name === '' ? `<${body.address}>` : `${name} <${body.address}>`, created: rt.now() });
      const [key] = parseKeys(g.publicBinary);
      const algorithm = key === undefined ? 'Ed25519 + X25519' : [key.primary, ...key.subkeys].map((m) => m.algorithmName).join(' + ');
      try {
        await insert(req, res, { kind: 'pgp', owner: 'own', address: body.address, fingerprint: g.fingerprint, algorithm, publicKey: g.publicArmored, privatePlain: g.secretArmored, expiresAt: null, revokedAt: null, userIds: [] }, 'crypto-key.generate');
      } catch (error) {
        if (!refuse(res, error)) throw error;
      }
    }),
  );

  router.post(
    '/import',
    handle(async (req, res) => {
      const body = parse(ImportKeyBody, req.body, res);
      if (body === null) return;
      const me = currentSession(req);
      try {
        const ownAddresses = await sendableAddresses(db, me.accountId);
        const data =
          body.kind === 'pgp'
            ? pgpRowFromArmored(body.armored, { passphrase: body.passphrase, address: body.address, ownAddresses, now: rt.now() })
            : smimeRowFromPem(body.certificate, { privateKey: body.privateKey, passphrase: body.passphrase, address: body.address, ownAddresses });
        await insert(req, res, data, 'crypto-key.import');
      } catch (error) {
        if (!refuse(res, error)) throw error;
      }
    }),
  );

  router.get(
    '/:id/export',
    handle(async (req, res) => {
      const row = await ownRow(req, res);
      if (row === null) return;
      const ext = row.kind === 'pgp' ? 'asc' : 'pem';
      res.setHeader('Cache-Control', 'no-store');
      res.json({ id: row.id, kind: row.kind, fingerprint: row.fingerprint, filename: `${safeName(row.address)}-${row.fingerprint.slice(-16).toLowerCase()}.${ext}`, publicKey: row.publicKey });
    }),
  );

  router.post(
    '/:id/export-secret',
    requireStepUp(deps),
    handle(async (req, res) => {
      const body = parse(ExportSecretBody, req.body ?? {}, res);
      if (body === null) return;
      const row = await ownRow(req, res);
      if (row === null) return;
      if (row.owner !== 'own' || row.sealedPrivate === null) {
        res.status(409).json({ error: 'no_private_key', message: 'Only your own keys have a private half to export.' });
        return;
      }
      const plain = openPrivateKey(rt.kek, row);
      if (plain === null) {
        res.status(503).json({ error: 'private_key_unavailable', message: 'The private key could not be opened (the KEK is not loaded, or it was sealed under another one).' });
        return;
      }
      const text = typeof plain === 'string' ? plain : plain.toString('utf8');
      let secret: string;
      if (row.kind === 'pgp') {
        const block = decodeArmor(text)?.data ?? Buffer.alloc(0);
        secret = body.passphrase === undefined ? text : encodeArmor('PGP PRIVATE KEY BLOCK', protectSecretKeyBlock(block, body.passphrase));
      } else {
        const key = createPrivateKey(text);
        const pem = body.passphrase === undefined ? key.export({ type: 'pkcs8', format: 'pem' }) : key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: body.passphrase });
        secret = `${typeof pem === 'string' ? pem : pem.toString('utf8')}${row.publicKey}`;
      }
      const me = currentSession(req);
      await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'crypto-key.export-secret', entityType: 'crypto_key', context: getAuditContext(req) }, () =>
        Promise.resolve({ entityId: row.id, before: null, after: { ...auditView(row), protected: body.passphrase !== undefined }, result: null }),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ id: row.id, kind: row.kind, fingerprint: row.fingerprint, filename: `${safeName(row.address)}-${row.fingerprint.slice(-16).toLowerCase()}-SECRET.${row.kind === 'pgp' ? 'asc' : 'pem'}`, protected: body.passphrase !== undefined, secret });
    }),
  );

  router.post(
    '/:id/revoke',
    handle(async (req, res) => {
      const body = parse(RevokeKeyBody, req.body ?? {}, res);
      if (body === null) return;
      const row = await ownRow(req, res);
      if (row === null) return;
      if (row.revokedAt !== null) {
        res.status(409).json({ error: 'already_revoked', message: 'The key is already revoked.' });
        return;
      }
      const now = rt.now();
      let publicKey = row.publicKey;
      let signed = false;
      if (row.kind === 'pgp' && row.owner === 'own' && row.sealedPrivate !== null) {
        // A 0x20 revocation signature, stored with the key: whoever gets the exported key learns it.
        const plain = openPrivateKey(rt.kek, row);
        if (plain === null) {
          res.status(503).json({ error: 'private_key_unavailable', message: 'The private key could not be opened, so no revocation signature can be made.' });
          return;
        }
        const [key] = parseKeys(decodeArmor(typeof plain === 'string' ? plain : plain.toString('utf8'))?.data ?? Buffer.alloc(0));
        const pubBlock = decodeArmor(row.publicKey)?.data;
        if (key === undefined || pubBlock === undefined) {
          res.status(409).json({ error: 'invalid_key', message: 'The stored key could not be read.' });
          return;
        }
        const rev = revocationSignature(key, { reason: RevocationReason[body.reason], ...(body.text !== undefined ? { text: body.text } : {}), created: now });
        publicKey = encodeArmor('PGP PUBLIC KEY BLOCK', publicKeyBlock(withKeySignature(pubBlock, rev)));
        signed = true;
      }
      const me = currentSession(req);
      const updated = await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'crypto-key.revoke', entityType: 'crypto_key', context: getAuditContext(req) }, async (tx) => {
        const after = await tx.cryptoKey.update({ where: { id: row.id }, data: { revokedAt: now, publicKey } });
        return { entityId: row.id, before: auditView(row), after: { ...auditView(after), reason: body.reason, revocationSigned: signed }, result: after };
      });
      res.json({ key: keyJson(updated) });
    }),
  );

  router.delete(
    '/:id',
    handle(async (req, res) => {
      const row = await ownRow(req, res);
      if (row === null) return;
      if (row.owner === 'own') {
        res.status(409).json({ error: 'own_key', message: 'Your own keys are revoked, never deleted: mail encrypted to them must still open.' });
        return;
      }
      const me = currentSession(req);
      await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'crypto-key.delete', entityType: 'crypto_key', context: getAuditContext(req) }, async (tx) => {
        await tx.cryptoKey.delete({ where: { id: row.id } });
        return { entityId: row.id, before: auditView(row), after: null, result: null };
      });
      res.json({ ok: true });
    }),
  );

  return router;
}
