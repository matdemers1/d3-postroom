import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, seed, type Db } from '../../src/index.js';

// Proves PST-T-0.4's doneWhen: the migration applies to an empty PostgreSQL 16, and the seed creates
// an operator and a domain — idempotently. Each run gets its own throwaway database.

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const pkgDir = fileURLToPath(new URL('../..', import.meta.url));

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('schema on an empty database', () => {
  const dbName = `pst_t04_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  let url = '';
  let db: Db;
  let raw: pg.Client;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url = withDatabase(baseUrl ?? '', dbName);
    const prisma = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));
    await exec(prisma, ['migrate', 'deploy'], { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url } });
    db = createDb(url);
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
  }, 120_000);

  afterAll(async () => {
    await raw.end();
    await db.$disconnect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it('seeds a domain, an admin operator and seven mailboxes, and a second run changes nothing', async () => {
    const first = await seed(db, { operatorName: 'Operator', domain: 'D3Cloud.io' });
    expect(first.changed).toBe(true);
    const second = await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    expect(second).toEqual({ ...first, changed: false });

    const domains = await db.domain.findMany();
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({ name: 'd3cloud.io', isPrimary: true });

    const accounts = await db.account.findMany();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ displayName: 'Operator', isAdmin: true, passwordHash: null });

    const mailboxes = await db.mailbox.findMany({ where: { accountId: first.operatorId } });
    expect(mailboxes).toHaveLength(7);
    for (const mb of mailboxes) {
      expect(mb.uidvalidity).toBeGreaterThan(0);
      expect(mb.uidnext).toBe(1);
      expect(mb.highestModseq).toBe(0n);
    }

    const audit = await db.auditEvent.findMany({ where: { action: 'seed' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'system', actorAccountId: null, entityId: first.operatorId });
  });

  it('rejects a duplicate (mailbox_id, uid) and shares one blob by digest', async () => {
    const inbox = await db.mailbox.findFirstOrThrow({ where: { name: 'INBOX' } });
    const sha256 = 'a'.repeat(64);
    await db.blob.create({
      data: { sha256, size: 10, wrappedDek: Buffer.alloc(40), kekId: 'k1', aead: 'aes-256-gcm', nonce: Buffer.alloc(12) },
    });
    const msg = { mailboxId: inbox.id, uid: 1, modseq: 1n, blobSha256: sha256, size: 10, internalDate: new Date() };
    await db.message.create({ data: msg });
    await expect(db.message.create({ data: msg })).rejects.toThrow();
    await db.message.create({ data: { ...msg, uid: 2 } });
    await db.blob.update({ where: { sha256 }, data: { refcount: { increment: 1 } } });
    expect((await db.blob.findUniqueOrThrow({ where: { sha256 } })).refcount).toBe(2);
  });

  it('enforces blob invariants: refcount >= 0, hex digest, immutable body', async () => {
    const sha256 = 'b'.repeat(64);
    await db.blob.create({
      data: { sha256, size: 1, wrappedDek: Buffer.alloc(40), kekId: 'k1', aead: 'aes-256-gcm', nonce: Buffer.alloc(12) },
    });
    await expect(db.blob.update({ where: { sha256 }, data: { refcount: -1 } })).rejects.toThrow();
    await expect(db.blob.update({ where: { sha256 }, data: { wrappedDek: Buffer.alloc(40, 1) } })).rejects.toThrow();
    await expect(
      db.blob.create({
        data: { sha256: 'B'.repeat(64), size: 1, wrappedDek: Buffer.alloc(1), kekId: 'k1', aead: 'x', nonce: Buffer.alloc(1) },
      }),
    ).rejects.toThrow();
  });

  it('links identities by (issuer, subject) uniquely', async () => {
    const account = await db.account.findFirstOrThrow();
    const link = { accountId: account.id, issuer: 'https://auth.d3cloud.io', subject: 'sub-1' };
    await db.identityLink.create({ data: { ...link, email: 'a@example.com' } });
    await expect(db.identityLink.create({ data: { ...link, email: 'other@example.com' } })).rejects.toThrow();
    await db.identityLink.create({ data: { ...link, subject: 'sub-2', email: 'a@example.com' } });
  });

  it('enforces lowercase names, mailbox counters and alias ownership in SQL', async () => {
    const account = await db.account.findFirstOrThrow();
    const domain = await db.domain.findFirstOrThrow();
    await expect(raw.query(`INSERT INTO domain (name) VALUES ('Upper.Example')`)).rejects.toThrow(/domain_name_lowercase/);
    await expect(
      raw.query(`INSERT INTO address (local_part, domain_id, kind, account_id) VALUES ('Matt', $1, 'primary', $2)`, [
        domain.id,
        account.id,
      ]),
    ).rejects.toThrow(/address_local_part_lowercase/);
    await expect(
      raw.query(`INSERT INTO address (local_part, domain_id, kind, account_id) VALUES ('team', $1, 'alias', $2)`, [
        domain.id,
        account.id,
      ]),
    ).rejects.toThrow(/address_owner_by_kind/);
    await expect(
      raw.query(`INSERT INTO mailbox (account_id, name, uidvalidity, updated_at) VALUES ($1, 'Zero', 0, now())`, [account.id]),
    ).rejects.toThrow(/mailbox_uidvalidity_positive/);
    await expect(
      raw.query(`INSERT INTO app_password (account_id, label, prefix, hash, scopes) VALUES ($1, 'x', 'p1', 'h', '{}')`, [
        account.id,
      ]),
    ).rejects.toThrow(/app_password_scopes_nonempty/);
  });

  it('keeps audit_event append-only', async () => {
    await expect(raw.query(`DELETE FROM audit_event`)).rejects.toThrow(/append-only/);
    await expect(raw.query(`UPDATE audit_event SET action = 'tampered'`)).rejects.toThrow(/append-only/);
  });
});
