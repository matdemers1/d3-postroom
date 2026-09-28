// PST-T-0.15: the ACME job's database state against real PostgreSQL — the account key sealed with
// the KEK (and unreadable without it), the lease that keeps the timer and `postroom acme` apart,
// and the audit rows an issuance writes with a system actor (PST-REQ-009).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { generateAccountKey, jwkThumbprint, publicJwk } from '../../src/acme/jws.js';
import { ACCOUNT_KEY_SETTING, dbAcmeStore, readLastAcme } from '../../src/acme/state.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('ACME state in PostgreSQL (PST-T-0.15)', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t015_acme');
    db = t.db;
  }, 30_000);

  afterAll(async () => {
    await t.drop();
  });

  it('seals the account key with the KEK, reopens it across instances, and audits its creation', async () => {
    const kek = generateKek();
    const store = dbAcmeStore(db, () => kek);
    expect(await store.loadAccountKey()).toBeNull();
    const key = generateAccountKey();
    await store.saveAccountKey(key);

    const row = await db.setting.findUniqueOrThrow({ where: { key: ACCOUNT_KEY_SETTING } });
    expect(JSON.stringify(row.value)).not.toContain('PRIVATE KEY');
    const reopened = await dbAcmeStore(db, () => kek).loadAccountKey();
    expect(reopened).not.toBeNull();
    expect(jwkThumbprint(publicJwk(reopened ?? key))).toBe(jwkThumbprint(publicJwk(key)));
    await expect(dbAcmeStore(db, () => generateKek()).loadAccountKey()).rejects.toThrow();

    const audit = await db.auditEvent.findFirst({ where: { action: 'acme.account-key.create' } });
    expect(audit).toMatchObject({ actorKind: 'system', entityType: 'setting' });
  });

  it('lets one holder at a time take the lease, and lets it lapse', async () => {
    const store = dbAcmeStore(db, () => generateKek());
    const now = new Date();
    expect(await store.acquire('a', 60_000, now)).toBe(true);
    expect(await store.acquire('b', 60_000, now)).toBe(false);
    expect(await store.acquire('a', 60_000, now)).toBe(true);
    await store.release('b');
    expect(await store.acquire('b', 60_000, now)).toBe(false);
    await store.release('a');
    expect(await store.acquire('b', 60_000, now)).toBe(true);
    // An expired lease (a crashed holder) is taken over.
    expect(await store.acquire('c', 60_000, new Date(now.getTime() + 120_000))).toBe(true);
    await store.release('c');
  });

  it('records the last run and audits an issuance with a system actor', async () => {
    const store = dbAcmeStore(db, () => generateKek());
    await store.recordLast({ at: new Date().toISOString(), ok: true, action: 'issued', directory: 'https://ca.test/dir', domains: ['mx.d3cloud.io'], consecutiveFailures: 0, notAfter: '2026-12-27T00:00:00.000Z' });
    expect(await readLastAcme(db)).toMatchObject({ ok: true, action: 'issued' });
    await store.audit({ action: 'tls.certificate.issue', entityId: 'mx.d3cloud.io', after: { notAfter: '2026-12-27T00:00:00.000Z' } });
    const audit = await db.auditEvent.findFirst({ where: { action: 'tls.certificate.issue' } });
    expect(audit).toMatchObject({ actorKind: 'system', entityType: 'tls_certificate', entityId: 'mx.d3cloud.io' });
  });
});
