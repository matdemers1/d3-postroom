// The role-address reconciler (PST-T-4.15, PST-REQ-186): every served domain keeps postmaster@
// and abuse@ (RFC 5321 §4.5.1, RFC 2142), delivering to the first admin, and the DMARC / TLS-RPT
// report mailboxes its DNS names (@postroom/db's reportMailboxesFor — the same definition the DNS
// checker, report ingest and the DMARC proposals use) exist as service mailboxes the report sweep
// reads.
//
// Runs at api start (best effort, never blocking it) and synchronously when the setup wizard
// completes. Idempotent and additive only: an address that already exists — whatever it is, and
// wherever it delivers — is never modified or reassigned; the DNS checker reports it instead. Each
// creation is its own audited transaction with a system actor, so an audit row exists exactly
// when something was created.
//
// Depends on @postroom/db and @postroom/audit only, so smtp-in's integration test can run it.
import { randomInt } from 'node:crypto';
import { audited, type Actor } from '@postroom/audit';
import {
  ABUSE_LOCAL_PART,
  AccountKind,
  AddressKind,
  DEFAULT_MAILBOXES,
  POSTMASTER_LOCAL_PART,
  parseAddress,
  randomUidValidity,
  reportMailboxesFor,
  type Db,
  type Prisma,
  type ReportMailboxEnv,
} from '@postroom/db';

const ACTOR: Actor = { kind: 'system', label: 'role-addresses' };
/** Serialises the reconciler with itself (api start and the wizard can overlap). */
const LOCK = 0x5057_0415;

export type SkipReason = 'exists' | 'no_admin' | 'not_served';

export interface ReconcileResult {
  /** Addresses this run created, `local@domain`. */
  readonly created: string[];
  /** Addresses left alone, and why. */
  readonly skipped: { readonly address: string; readonly reason: SkipReason }[];
}

/** Thrown inside the creating transaction when the address already exists: rolls the audit back too. */
class Exists extends Error {}

/** The account postmaster@ and abuse@ deliver to: the earliest-created enabled admin person. */
export async function firstAdmin(db: Db | Prisma.TransactionClient): Promise<{ id: string; displayName: string } | null> {
  return db.account.findFirst({
    where: { isAdmin: true, kind: AccountKind.person, disabledAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, displayName: true },
  });
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

async function createOnce(db: Db, address: string, action: string, create: (tx: Prisma.TransactionClient) => Promise<{ entityId: string; after: Record<string, unknown> }>, domainId: string, localPart: string): Promise<boolean> {
  try {
    await audited(db, ACTOR, { action, entityType: 'address' }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK})`;
      const taken = await tx.address.findUnique({ where: { localPart_domainId: { localPart, domainId } }, select: { id: true } });
      if (taken !== null) throw new Exists(address);
      const { entityId, after } = await create(tx);
      return { entityId, before: null, after: { address, ...after }, result: null };
    });
    return true;
  } catch (error) {
    if (error instanceof Exists || isUniqueViolation(error)) return false;
    throw error;
  }
}

/** Ensure every role and report address exists. Never modifies an existing address. */
export async function reconcileRoleAddresses(db: Db, env: ReportMailboxEnv): Promise<ReconcileResult> {
  const created: string[] = [];
  const skipped: { address: string; reason: SkipReason }[] = [];
  const domains = await db.domain.findMany({ orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true, name: true } });
  const served = new Map(domains.map((d) => [d.name, d.id]));
  const admin = await firstAdmin(db);

  for (const domain of domains) {
    for (const localPart of [POSTMASTER_LOCAL_PART, ABUSE_LOCAL_PART]) {
      const address = `${localPart}@${domain.name}`;
      if (admin === null) {
        skipped.push({ address, reason: 'no_admin' });
        continue;
      }
      const made = await createOnce(
        db,
        address,
        'role_address.alias.create',
        async (tx) => {
          const row = await tx.address.create({ data: { localPart, domainId: domain.id, kind: AddressKind.alias } });
          await tx.addressTarget.create({ data: { addressId: row.id, accountId: admin.id } });
          return { entityId: row.id, after: { kind: 'alias', targets: [admin.id] } };
        },
        domain.id,
        localPart,
      );
      if (made) created.push(address);
      else skipped.push({ address, reason: 'exists' });
    }
  }

  // Each domain's DNS names its own report mailboxes (or the REPORTS_MAILBOX / TLSRPT_MAILBOX
  // overrides, which may be at any domain — or at one Postroom does not serve, left alone).
  const reports = new Map<string, string>();
  for (const domain of domains) {
    const r = reportMailboxesFor(env, domain.name);
    for (const a of r.dmarc) if (!reports.has(a)) reports.set(a, 'DMARC reports');
    for (const a of r.tls) if (!reports.has(a)) reports.set(a, 'TLS reports');
  }
  for (const [address, displayName] of reports) {
    let parsed;
    try {
      parsed = parseAddress(address);
    } catch {
      skipped.push({ address, reason: 'not_served' });
      continue;
    }
    const { localPart } = parsed;
    const domainId = served.get(parsed.domain);
    if (domainId === undefined) {
      skipped.push({ address, reason: 'not_served' });
      continue;
    }
    // The same shape the admin Service accounts screen creates (PST-T-1.12): a service account with
    // no password, a service address, and the default mailboxes the report sweep reads.
    const made = await createOnce(
      db,
      address,
      'role_address.service_mailbox.create',
      async (tx) => {
        const account = await tx.account.create({ data: { displayName, isAdmin: false, kind: AccountKind.service } });
        const row = await tx.address.create({ data: { localPart, domainId, kind: AddressKind.service, accountId: account.id } });
        for (const mb of DEFAULT_MAILBOXES) {
          await tx.mailbox.create({ data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) } });
        }
        return { entityId: row.id, after: { kind: 'service', accountId: account.id, displayName } };
      },
      domainId,
      localPart,
    );
    if (made) created.push(address);
    else skipped.push({ address, reason: 'exists' });
  }
  return { created, skipped };
}

/** api start: run once, log the outcome, and never let a failure hold up (or take down) the daemon. */
export function reconcileAtStart(db: Db, env: ReportMailboxEnv, log: (event: string, fields?: Record<string, unknown>) => void): Promise<void> {
  return reconcileRoleAddresses(db, env).then(
    (r) => {
      log('role_addresses.reconciled', { created: r.created, skipped: r.skipped.filter((s) => s.reason !== 'exists') });
    },
    (error: unknown) => {
      log('role_addresses.failed', { error: error instanceof Error ? error.message : String(error) });
    },
  );
}
