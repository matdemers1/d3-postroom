// DKIM keys for a sending domain (PST-REQ-038): one Ed25519 and one RSA-2048 key, sealed under the
// KEK with AAD "dkim:<domain>:<selector>", and the DNS records to publish for them.
//
// Keys are created by an explicit step (`ensureDkimKeys`, run by the CLI or a boot/admin step),
// never on first send: a key nobody has published in DNS would sign mail that then fails DKIM
// everywhere. Submission refuses with 451 while a domain has no keys rather than send unsigned.
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

const TO_DB: Record<DkimAlgorithm, DbAlgorithm> = {
  'ed25519-sha256': DbAlgorithm.ed25519_sha256,
  'rsa-sha256': DbAlgorithm.rsa_sha256,
};
const FROM_DB: Record<DbAlgorithm, DkimAlgorithm> = {
  [DbAlgorithm.ed25519_sha256]: 'ed25519-sha256',
  [DbAlgorithm.rsa_sha256]: 'rsa-sha256',
};

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

/** The live key per algorithm for a domain: not retired, active from before `now`, newest first. */
async function activeKeys(db: Db, domainId: string, now: Date): Promise<Map<DkimAlgorithm, KeyRow>> {
  const rows = await db.dkimKey.findMany({
    where: { domainId, retiredAt: null, activeFrom: { lte: now } },
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
    const selector = selectorFor(now, algorithm);
    const dnsRecord = dnsRecordFor(algorithm, pair.publicKey);
    const sealed = sealDkimKey(kek, pair.privateKey, dkimAad(name, selector));
    const select = { id: true, selector: true, algorithm: true, dnsRecord: true, sealedPrivate: true } as const;
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`postroom-dkim:${name}`}, 0))`;
      // Someone else created one while we generated: keep theirs and write nothing.
      const raced = await tx.dkimKey.findFirst({
        where: { domainId: domain.id, algorithm: TO_DB[algorithm], retiredAt: null, activeFrom: { lte: now } },
        orderBy: { activeFrom: 'desc' },
        select,
      });
      if (raced !== null) return { row: raced, created: false };
      const row = await tx.dkimKey.create({
        data: {
          domainId: domain.id,
          selector,
          algorithm: TO_DB[algorithm],
          dnsRecord,
          sealedPrivate: new Uint8Array(sealed),
          kekId: kek.id,
          activeFrom: now,
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
