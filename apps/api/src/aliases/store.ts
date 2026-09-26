// Masked aliases: the database reads and writes behind the routes (PST-T-5.7, PST-REQ-112).
// Everything is scoped to the caller's account — a masked address is owned by exactly one account,
// never shared. A killed alias keeps its row (so its history and `killedAt` survive); smtp-in's
// RCPT policy (recipients.ts) is what actually turns that into a 550 for new mail.
import { randomInt } from 'node:crypto';
import { AddressKind, type Db, type Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient;

export interface AliasRow {
  id: string;
  address: string;
  site: string;
  createdAt: Date;
  killedAt: Date | null;
  lastUsedAt: Date | null;
  receivedCount: number;
}

export class AliasError extends Error {
  constructor(public readonly code: 'no_primary_domain' | 'not_found' | 'local_part_exhausted') {
    super(code);
  }
}

// Excludes characters that read poorly or are easy to transpose (0/O, 1/l/I).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET.charAt(randomInt(ALPHABET.length));
  return out;
}

/** A short slug from the site name: lowercase, `[a-z0-9]` only, at most 12 characters, never empty. */
function siteSlug(site: string): string {
  const cleaned = site.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return cleaned === '' ? 'alias' : cleaned;
}

// The keyword file.ts's siteKeyword derives from an alias's site tag: `[a-z0-9_-]`, lower-cased,
// non-empty (SITE_KEYWORD_PREFIX + this suffix). Kept in step with apps/worker/src/stages/file.ts's
// keywordSuffix/siteKeyword — a change there needs the same change here.
const SITE_KEYWORD_PREFIX = '$Postroom.site.';
function siteKeyword(site: string): string {
  const cleaned = site.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return `${SITE_KEYWORD_PREFIX}${cleaned === '' ? '_' : cleaned}`;
}

async function primaryDomain(db: Db): Promise<{ id: string; name: string }> {
  const domain = await db.domain.findFirst({ where: { isPrimary: true }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  if (domain === null) throw new AliasError('no_primary_domain');
  return domain;
}

/** Create a masked alias for `site`, owned by `accountId`, at the primary domain. Random local part; retried on collision. */
export async function createAlias(tx: Tx, accountId: string, site: string): Promise<AliasRow> {
  const domain = await primaryDomain(tx as unknown as Db);
  const slug = siteSlug(site);
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const localPart = `${slug}.${randomSuffix(attempt < 4 ? 4 : 6)}`;
    const existing = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId: domain.id } }, select: { id: true } });
    if (existing !== null) continue;
    const created = await tx.address.create({
      data: { localPart, domainId: domain.id, kind: AddressKind.masked, accountId, siteTag: site },
    });
    return toRow(created, domain.name, { lastUsedAt: null, receivedCount: 0 });
  }
  throw new AliasError('local_part_exhausted');
}

function toRow(
  row: { id: string; localPart: string; siteTag: string | null; createdAt: Date; killedAt: Date | null },
  domainName: string,
  usage: { lastUsedAt: Date | null; receivedCount: number },
): AliasRow {
  return {
    id: row.id,
    address: `${row.localPart}@${domainName}`,
    site: row.siteTag ?? '',
    createdAt: row.createdAt,
    killedAt: row.killedAt,
    lastUsedAt: usage.lastUsedAt,
    receivedCount: usage.receivedCount,
  };
}

/**
 * Usage for one alias: the account's filed messages carrying its site keyword. Two aliases sharing
 * the same site tag would share this count — a known approximation, since the mail store has no
 * per-address delivery log to attribute a copy to one masked address rather than another.
 */
async function usageOf(db: Db, accountId: string, site: string): Promise<{ lastUsedAt: Date | null; receivedCount: number }> {
  const keyword = siteKeyword(site);
  const [receivedCount, last] = await Promise.all([
    db.message.count({ where: { mailbox: { accountId }, flags: { has: keyword } } }),
    db.message.findFirst({ where: { mailbox: { accountId }, flags: { has: keyword } }, orderBy: { internalDate: 'desc' }, select: { internalDate: true } }),
  ]);
  return { lastUsedAt: last?.internalDate ?? null, receivedCount };
}

/** Every masked alias this account owns, newest first. */
export async function listAliases(db: Db, accountId: string): Promise<AliasRow[]> {
  const rows = await db.address.findMany({
    where: { accountId, kind: AddressKind.masked },
    include: { domain: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    rows.map(async (row) => {
      const usage = await usageOf(db, accountId, row.siteTag ?? '');
      return toRow(row, row.domain.name, usage);
    }),
  );
}

async function ownedAlias(tx: Tx, accountId: string, id: string): Promise<{ id: string; localPart: string; domainName: string; siteTag: string | null; createdAt: Date; killedAt: Date | null }> {
  const row = await tx.address.findFirst({
    where: { id, accountId, kind: AddressKind.masked },
    include: { domain: { select: { name: true } } },
  });
  if (row === null) throw new AliasError('not_found');
  return { id: row.id, localPart: row.localPart, domainName: row.domain.name, siteTag: row.siteTag, createdAt: row.createdAt, killedAt: row.killedAt };
}

/** Kill an alias: RCPT to it is refused with 550 from the moment this commits (PST-REQ-112). */
export async function killAlias(tx: Tx, accountId: string, id: string, now: Date): Promise<AliasRow> {
  const row = await ownedAlias(tx, accountId, id);
  const updated = await tx.address.update({ where: { id: row.id }, data: { killedAt: row.killedAt ?? now } });
  const usage = await usageOf(tx as unknown as Db, accountId, row.siteTag ?? '');
  return toRow(updated, row.domainName, usage);
}

/** Revive a killed alias: RCPT to it is accepted again. */
export async function reviveAlias(tx: Tx, accountId: string, id: string): Promise<AliasRow> {
  const row = await ownedAlias(tx, accountId, id);
  const updated = await tx.address.update({ where: { id: row.id }, data: { killedAt: null } });
  const usage = await usageOf(tx as unknown as Db, accountId, row.siteTag ?? '');
  return toRow(updated, row.domainName, usage);
}
