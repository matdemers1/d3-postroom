// What the ACME job keeps between runs (PST-T-0.15), as `setting` rows like the backup's:
//
//   acme.account-key  the ES256 account key, PKCS#8 sealed with the KEK. Not a file on the certs
//                     volume: that volume is mounted by the four protocol daemons, which all run as
//                     the same uid, so no file mode could keep the key from them. Sealed in the
//                     database it sits with the other KEK-sealed secrets, survives restarts and
//                     image swaps, and goes out with the nightly backup.
//   acme.last         the last production run: ok or not, why, the failure count and when the next
//                     attempt is allowed (Let's Encrypt rate limits: a failing run backs off).
//   acme.staging      the last staging success — the gate before production is ever used.
//   acme.lock         a lease, so the daemon's timer and a `postroom acme` run never overlap.
//
// Every issuance is audited with a system actor (PST-REQ-009).
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { recordAudit } from '@postroom/audit';
import { openWithKek, sealWithKek, type Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';

export const ACCOUNT_KEY_SETTING = 'acme.account-key';
export const LAST_SETTING = 'acme.last';
export const STAGING_SETTING = 'acme.staging';
export const LOCK_SETTING = 'acme.lock';
const ACCOUNT_KEY_AAD = 'acme-account-key';
export const AUDIT_ACTOR = { kind: 'system', label: 'acme' } as const;

export interface LastAcme {
  /** When the run finished (ISO 8601). */
  readonly at: string;
  readonly ok: boolean;
  readonly action: 'issued' | 'renewed' | 'failed';
  readonly directory: string;
  readonly domains: readonly string[];
  readonly reason?: string;
  readonly notAfter?: string;
  readonly serial?: string;
  /** Failures since the last success. */
  readonly consecutiveFailures: number;
  /** A scheduled run waits until this (ISO 8601) after a failure. */
  readonly nextAttemptAt?: string;
}

export interface StagingPass {
  readonly at: string;
  readonly directory: string;
  readonly domains: readonly string[];
  readonly notAfter: string;
}

export interface AcmeAuditEvent {
  readonly action: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AcmeStore {
  loadAccountKey(): Promise<KeyObject | null>;
  saveAccountKey(key: KeyObject): Promise<void>;
  readLast(): Promise<LastAcme | null>;
  recordLast(value: LastAcme): Promise<void>;
  readStaging(): Promise<StagingPass | null>;
  recordStaging(value: StagingPass): Promise<void>;
  /** Take the lease for `ttlMs`; false when someone else holds an unexpired one. */
  acquire(holder: string, ttlMs: number, now: Date): Promise<boolean>;
  release(holder: string): Promise<void>;
  audit(event: AcmeAuditEvent): Promise<void>;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

interface SealedKey {
  readonly sealed: string;
}

interface Lease {
  readonly holder: string;
  readonly expiresAt: string;
}

export function dbAcmeStore(db: Db, kek: () => Kek): AcmeStore {
  const read = async <T>(key: string): Promise<T | null> => {
    const row = await db.setting.findUnique({ where: { key } });
    return row === null ? null : (row.value as T);
  };
  const write = async (key: string, value: unknown): Promise<void> => {
    await db.setting.upsert({ where: { key }, create: { key, value: json(value) }, update: { value: json(value) } });
  };
  return {
    async loadAccountKey() {
      const row = await read<SealedKey>(ACCOUNT_KEY_SETTING);
      if (row === null) return null;
      const der = openWithKek(kek(), Buffer.from(row.sealed, 'base64'), ACCOUNT_KEY_AAD);
      return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    },
    async saveAccountKey(key) {
      const der = key.export({ type: 'pkcs8', format: 'der' });
      const value = { sealed: sealWithKek(kek(), der, ACCOUNT_KEY_AAD).toString('base64') };
      await db.$transaction(async (tx) => {
        await tx.setting.upsert({ where: { key: ACCOUNT_KEY_SETTING }, create: { key: ACCOUNT_KEY_SETTING, value }, update: { value } });
        await recordAudit(tx, { actor: AUDIT_ACTOR, action: 'acme.account-key.create', entityType: 'setting', entityId: ACCOUNT_KEY_SETTING, after: { alg: 'ES256' } });
      });
    },
    readLast: () => read<LastAcme>(LAST_SETTING),
    recordLast: (value) => write(LAST_SETTING, value),
    readStaging: () => read<StagingPass>(STAGING_SETTING),
    recordStaging: (value) => write(STAGING_SETTING, value),
    async acquire(holder, ttlMs, now) {
      return db.$transaction(async (tx) => {
        // Serialises the read-then-write between processes; held only for this short transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-acme-lock'}, 0))`;
        const row = await tx.setting.findUnique({ where: { key: LOCK_SETTING } });
        const lease = row === null ? null : (row.value as unknown as Lease);
        if (lease !== null && lease.holder !== holder && new Date(lease.expiresAt).getTime() > now.getTime()) return false;
        const value = json({ holder, expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
        await tx.setting.upsert({ where: { key: LOCK_SETTING }, create: { key: LOCK_SETTING, value }, update: { value } });
        return true;
      });
    },
    async release(holder) {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-acme-lock'}, 0))`;
        const row = await tx.setting.findUnique({ where: { key: LOCK_SETTING } });
        if (row !== null && (row.value as unknown as Lease).holder === holder) await tx.setting.delete({ where: { key: LOCK_SETTING } });
      });
    },
    async audit(event) {
      await recordAudit(db, { actor: AUDIT_ACTOR, action: event.action, entityType: 'tls_certificate', entityId: event.entityId, before: event.before, after: event.after });
    },
  };
}

/** An in-memory store: the unit tests' and nothing else's. */
export function memoryAcmeStore(): AcmeStore & { audits: AcmeAuditEvent[]; key: KeyObject | null; lease: Lease | null } {
  let last: LastAcme | null = null;
  let staging: StagingPass | null = null;
  const store = {
    audits: [] as AcmeAuditEvent[],
    key: null as KeyObject | null,
    lease: null as Lease | null,
    loadAccountKey: () => Promise.resolve(store.key),
    saveAccountKey: (key: KeyObject) => {
      store.key = key;
      store.audits.push({ action: 'acme.account-key.create', entityId: ACCOUNT_KEY_SETTING });
      return Promise.resolve();
    },
    readLast: () => Promise.resolve(last),
    recordLast: (v: LastAcme) => {
      last = v;
      return Promise.resolve();
    },
    readStaging: () => Promise.resolve(staging),
    recordStaging: (v: StagingPass) => {
      staging = v;
      return Promise.resolve();
    },
    acquire: (holder: string, ttlMs: number, now: Date) => {
      const cur = store.lease;
      if (cur !== null && cur.holder !== holder && new Date(cur.expiresAt).getTime() > now.getTime()) return Promise.resolve(false);
      store.lease = { holder, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
      return Promise.resolve(true);
    },
    release: (holder: string) => {
      if (store.lease?.holder === holder) store.lease = null;
      return Promise.resolve();
    },
    audit: (e: AcmeAuditEvent) => {
      store.audits.push(e);
      return Promise.resolve();
    },
  };
  return store;
}

export async function readLastAcme(db: Db): Promise<LastAcme | null> {
  const row = await db.setting.findUnique({ where: { key: LAST_SETTING } });
  return row === null ? null : (row.value as unknown as LastAcme);
}
