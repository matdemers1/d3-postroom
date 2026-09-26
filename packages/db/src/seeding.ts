import { randomInt } from 'node:crypto';
import type { Db, Prisma } from './db.js';
import { ActorKind, SpecialUse } from './generated/prisma/enums.js';
import { normalizeDomain, randomUidValidity } from './normalize.js';

/**
 * The mailboxes every account starts with, in the order a client lists them. The last four are the
 * sorting buckets (PST-REQ-101, PST-T-5.1): real, subscribed IMAP folders with no special use, so
 * every client (iPhone Mail included) lists them, and a move between them from any client trains the
 * account's model. The migration 20260926050500_bucket_folders backfills them for older accounts.
 */
export const DEFAULT_MAILBOXES: readonly { readonly name: string; readonly specialUse: SpecialUse | null }[] = [
  { name: 'INBOX', specialUse: SpecialUse.inbox },
  { name: 'Sent', specialUse: SpecialUse.sent },
  { name: 'Drafts', specialUse: SpecialUse.drafts },
  { name: 'Trash', specialUse: SpecialUse.trash },
  { name: 'Junk', specialUse: SpecialUse.junk },
  { name: 'Archive', specialUse: SpecialUse.archive },
  { name: 'Rejects', specialUse: SpecialUse.rejects },
  { name: 'Newsletters', specialUse: null },
  { name: 'Updates', specialUse: null },
  { name: 'Receipts', specialUse: null },
  { name: 'Notifications', specialUse: null },
];

/**
 * The CalDAV/CardDAV collections every person account starts with (PST-T-8.2). The database creates
 * them — a trigger on `account` (migration 20260926085534_dav), so every surface that creates an
 * account gets them without knowing about DAV, and the same migration backfilled older accounts.
 * This list mirrors the trigger for code that needs to name them (the seed's audit event, tests).
 */
export const DEFAULT_DAV_COLLECTIONS: readonly {
  readonly kind: 'calendar' | 'addressbook';
  readonly slug: string;
  readonly displayName: string;
  readonly components: readonly string[];
}[] = [
  { kind: 'calendar', slug: 'calendar', displayName: 'Calendar', components: ['VEVENT', 'VTODO'] },
  { kind: 'addressbook', slug: 'contacts', displayName: 'Contacts', components: [] },
];

export interface SeedOptions {
  /** Display name of the operator account. */
  readonly operatorName: string;
  /** The primary mail domain, e.g. d3cloud.io. */
  readonly domain: string;
}

export interface SeedResult {
  readonly domainId: string;
  readonly operatorId: string;
  /** False when the database already held everything and nothing was written. */
  readonly changed: boolean;
}

// Serialises concurrent seeds so two containers starting at once cannot both create an operator.
const SEED_LOCK = 0x5057_0001;

/**
 * Idempotent first-run seed: the primary domain, an admin operator with no password (the /setup
 * screen sets one later), and the operator's default mailboxes. Writes one audit event when it
 * changes anything, and nothing at all when it does not.
 */
export async function seed(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const domainName = normalizeDomain(opts.domain);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK})`;
    const created: Record<string, Prisma.InputJsonValue> = {};

    let domain = await tx.domain.findUnique({ where: { name: domainName } });
    if (!domain) {
      const hasPrimary = (await tx.domain.count({ where: { isPrimary: true } })) > 0;
      domain = await tx.domain.create({ data: { name: domainName, isPrimary: !hasPrimary } });
      created['domain'] = { id: domain.id, name: domain.name, isPrimary: domain.isPrimary };
    }

    let operator = await tx.account.findFirst({ where: { isAdmin: true }, orderBy: { createdAt: 'asc' } });
    if (!operator) {
      operator = await tx.account.create({ data: { displayName: opts.operatorName, isAdmin: true } });
      created['operator'] = { id: operator.id, displayName: operator.displayName, isAdmin: true };
      // The trigger created the operator's calendar and address book with the row; say so here.
      const collections = await tx.davCollection.findMany({
        where: { accountId: operator.id },
        select: { id: true, kind: true, slug: true },
        orderBy: { kind: 'asc' },
      });
      if (collections.length > 0) created['davCollections'] = collections;
    }

    const existing = await tx.mailbox.findMany({ where: { accountId: operator.id }, select: { name: true } });
    const have = new Set(existing.map((m) => m.name));
    const mailboxes: { name: string; uidvalidity: number }[] = [];
    for (const mb of DEFAULT_MAILBOXES) {
      if (have.has(mb.name)) continue;
      const row = await tx.mailbox.create({
        data: {
          accountId: operator.id,
          name: mb.name,
          specialUse: mb.specialUse,
          uidvalidity: randomUidValidity(randomInt),
        },
      });
      mailboxes.push({ name: row.name, uidvalidity: row.uidvalidity });
    }
    if (mailboxes.length > 0) created['mailboxes'] = mailboxes;

    const changed = Object.keys(created).length > 0;
    if (changed) {
      await tx.auditEvent.create({
        data: {
          actorKind: ActorKind.system,
          action: 'seed',
          entityType: 'account',
          entityId: operator.id,
          after: created,
        },
      });
    }
    return { domainId: domain.id, operatorId: operator.id, changed };
  });
}
