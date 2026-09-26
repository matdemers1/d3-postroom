// DKIM keys for a sending domain (PST-REQ-038): one Ed25519 and one RSA-2048 key, sealed under the
// KEK with AAD "dkim:<domain>:<selector>", and the DNS records to publish for them.
//
// Keys are created by an explicit step (`ensureDkimKeys`, run by the CLI or a boot/admin step),
// never on first send: a key nobody has published in DNS would sign mail that then fails DKIM
// everywhere. Submission refuses with 451 while a domain has no keys rather than send unsigned.
//
// Rotation (PST-T-7.4, PST-REQ-125) lives in dkim-rotation.ts. Only a key in state `active` signs;
// a `pending` key waits for its TXT to be seen in DNS, a `retiring` one stays published for 7 days.
import {
  dnsRecordFor,
  generateDkimKeys,
  openDkimKey,
  sealDkimKey,
  selectorFor,
  type DkimAlgorithm,
  type DkimKeyPair,
  type DkimSigningKey,
} from '@postroom/auth-checks';
import { recordAudit, type Actor } from '@postroom/audit';
import type { Kek } from '@postroom/crypto';
import { DkimAlgorithm as DbAlgorithm, normalizeDomain, type Db } from '@postroom/db';

/** Signing order: Ed25519 first, then RSA (both always). */
export const DKIM_ALGORITHMS: readonly DkimAlgorithm[] = ['ed25519-sha256', 'rsa-sha256'];

export const TO_DB: Record<DkimAlgorithm, DbAlgorithm> = {
  'ed25519-sha256': DbAlgorithm.ed25519_sha256,
  'rsa-sha256': DbAlgorithm.rsa_sha256,
};
export const FROM_DB: Record<DbAlgorithm, DkimAlgorithm> = {
  [DbAlgorithm.ed25519_sha256]: 'ed25519-sha256',
  [DbAlgorithm.rsa_sha256]: 'rsa-sha256',
};

/**
 * The dkim_key_state enum's values (the generated enum is not re-exported by @postroom/db).
 * pending → active → retiring → retired; only `active` signs.
 */
export const KEY_STATE = { pending: 'pending', active: 'active', retiring: 'retiring', retired: 'retired' } as const;
export type KeyState = (typeof KEY_STATE)[keyof typeof KEY_STATE];

const SYSTEM: Actor = { kind: 'system', label: 'dkim-keys' };

export function dkimAad(domain: string, selector: string): string {
  return `dkim:${domain}:${selector}`;
}

export interface DkimKeyInfo {
  readonly domain: string;
  readonly selector: string;
  readonly algorithm: DkimAlgorithm;
  /** Where the TXT record goes: `<selector>._domainkey.<domain>`. */
  readonly dnsName: string;
  readonly dnsRecord: string;
  /** True when this call generated the key. */
  readonly created: boolean;
}

/**
 * A dated selector for a key created at `now` (`pr<yyyy><mm>e` / `pr<yyyy><mm>r`, see selectorFor),
 * with a counter appended — `pr202612e2`, `pr202612e3` — when that selector is already taken on the
 * domain (a second key made in the same month). A selector is never reused: its TXT may still be
 * cached, or still verifying mail signed under the earlier key.
 */
export function datedSelector(now: Date, algorithm: DkimAlgorithm, taken: ReadonlySet<string>): string {
  const base = selectorFor(now, algorithm);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class UnknownDomainError extends Error {
  override readonly name = 'UnknownDomainError';
  constructor(readonly domain: string) {
    super(`unknown domain: ${domain}`);
  }
}

interface KeyRow {
  readonly id: string;
  readonly selector: string;
  readonly algorithm: DbAlgorithm;
  readonly dnsRecord: string;
  readonly sealedPrivate: Uint8Array;
}

/** The signing key per algorithm for a domain: state `active`, active from before `now`, newest first. */
async function activeKeys(db: Db, domainId: string, now: Date): Promise<Map<DkimAlgorithm, KeyRow>> {
  const rows = await db.dkimKey.findMany({
    where: { domainId, state: KEY_STATE.active, retiredAt: null, activeFrom: { lte: now } },
    orderBy: { activeFrom: 'desc' },
    select: { id: true, selector: true, algorithm: true, dnsRecord: true, sealedPrivate: true },
  });
  const byAlg = new Map<DkimAlgorithm, KeyRow>();
  for (const row of rows) {
    const alg = FROM_DB[row.algorithm];
    if (!byAlg.has(alg)) byAlg.set(alg, row);
  }
  return byAlg;
}

/**
 * Make sure `domain` has a live Ed25519 and RSA-2048 key, generating (and auditing, as system)
 * whichever is missing. Idempotent; concurrent callers serialise on an advisory lock.
 */
export async function ensureDkimKeys(
  db: Db,
  kek: Kek,
  domainName: string,
  options: { readonly now?: Date } = {},
): Promise<DkimKeyInfo[]> {
  const now = options.now ?? new Date();
  const name = normalizeDomain(domainName);
  const domain = await db.domain.findUnique({ where: { name }, select: { id: true } });
  if (domain === null) throw new UnknownDomainError(name);

  let pairs: { rsa: DkimKeyPair; ed25519: DkimKeyPair } | undefined;
  const out: DkimKeyInfo[] = [];
  for (const algorithm of DKIM_ALGORITHMS) {
    const info = (row: KeyRow, created: boolean): DkimKeyInfo => ({
      domain: name,
      selector: row.selector,
      algorithm,
      dnsName: `${row.selector}._domainkey.${name}`,
      dnsRecord: row.dnsRecord,
      created,
    });
    const existing = (await activeKeys(db, domain.id, now)).get(algorithm);
    if (existing !== undefined) {
      out.push(info(existing, false));
      continue;
    }
    pairs ??= generateDkimKeys();
    const pair = algorithm === 'rsa-sha256' ? pairs.rsa : pairs.ed25519;
    const dnsRecord = dnsRecordFor(algorithm, pair.publicKey);
    const select = { id: true, selector: true, algorithm: true, dnsRecord: true, sealedPrivate: true } as const;
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`postroom-dkim:${name}`}, 0))`;
      // Someone else created one while we generated: keep theirs and write nothing.
      const raced = await tx.dkimKey.findFirst({
        where: { domainId: domain.id, algorithm: TO_DB[algorithm], state: KEY_STATE.active, retiredAt: null, activeFrom: { lte: now } },
        orderBy: { activeFrom: 'desc' },
        select,
      });
      if (raced !== null) return { row: raced, created: false };
      const taken = await tx.dkimKey.findMany({ where: { domainId: domain.id }, select: { selector: true } });
      const selector = datedSelector(now, algorithm, new Set(taken.map((t) => t.selector)));
      const sealed = sealDkimKey(kek, pair.privateKey, dkimAad(name, selector));
      const row = await tx.dkimKey.create({
        data: {
          domainId: domain.id,
          selector,
          algorithm: TO_DB[algorithm],
          dnsRecord,
          sealedPrivate: new Uint8Array(sealed),
          kekId: kek.id,
          activeFrom: now,
          state: KEY_STATE.active,
        },
        select,
      });
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'dkim_key.create',
        entityType: 'dkim_key',
        entityId: row.id,
        before: null,
        after: { domain: name, selector, algorithm, dnsRecord, kekId: kek.id },
      });
      return { row, created: true };
    });
    out.push(info(result.row, result.created));
  }
  return out;
}

/**
 * The opened signing keys for `domain`, Ed25519 then RSA — or null unless both exist (PST-REQ-038
 * wants both on every message, so one alone is "not configured").
 */
export async function loadSigningKeys(db: Db, kek: Kek, domainName: string, now = new Date()): Promise<DkimSigningKey[] | null> {
  const name = normalizeDomain(domainName);
  const domain = await db.domain.findUnique({ where: { name }, select: { id: true } });
  if (domain === null) return null;
  const byAlg = await activeKeys(db, domain.id, now);
  const keys: DkimSigningKey[] = [];
  for (const algorithm of DKIM_ALGORITHMS) {
    const row = byAlg.get(algorithm);
    if (row === undefined) return null;
    keys.push({ selector: row.selector, algorithm, privateKey: openDkimKey(kek, row.sealedPrivate, dkimAad(name, row.selector)) });
  }
  return keys;
}
