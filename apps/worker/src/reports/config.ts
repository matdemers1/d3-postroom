// Which mailboxes hold reports (PST-T-7.1, PST-REQ-122). The DMARC record's `rua=` and the
// `_smtp._tls` record's `rua=` point at service mailboxes (created on the admin Service accounts
// screen, PST-T-1.12, or by the api's role-address reconciler, PST-T-4.15): REPORTS_MAILBOX (default
// dmarc-reports@<domain>) and TLSRPT_MAILBOX (default tls-reports@<domain>). Either may be a
// comma-separated list. An address that does not exist yet is simply skipped: nothing is ingested
// until the mailbox is created.
//
// Every receiving folder of those accounts is read, not only INBOX: the classifier may sort a
// report into Updates or Notifications, and a report is a report wherever it was filed. Sent,
// Drafts, Trash and Rejects are never read.
import { addressList, reportMailboxesFor, SpecialUse, type Db } from '@postroom/db';

export interface ReportMailboxes {
  /** The configured addresses, lowercased. */
  readonly addresses: readonly string[];
  /** Mailbox ids the sweep reads. */
  readonly mailboxIds: readonly string[];
}

const SKIPPED: readonly SpecialUse[] = [SpecialUse.sent, SpecialUse.drafts, SpecialUse.trash, SpecialUse.rejects];

/**
 * The report addresses for this install, from the one shared definition (@postroom/db's
 * reportMailboxesFor, PST-T-4.15) that the DNS checker's rua= and the DMARC proposals also use:
 * REPORTS_MAILBOX / TLSRPT_MAILBOX if set, else dmarc-reports@ / tls-reports@ each served domain,
 * the primary first — each domain's DNS names its own, and the api's reconciler creates them.
 */
export async function reportAddresses(db: Db, env: NodeJS.ProcessEnv): Promise<string[]> {
  const domains = await db.domain.findMany({ orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { name: true } });
  const out = new Set<string>();
  if (domains.length === 0) {
    for (const a of addressList(env['REPORTS_MAILBOX'])) out.add(a);
    for (const a of addressList(env['TLSRPT_MAILBOX'])) out.add(a);
  }
  for (const d of domains) {
    const r = reportMailboxesFor(env, d.name);
    for (const a of r.dmarc) out.add(a);
    for (const a of r.tls) out.add(a);
  }
  return [...out];
}

/** Resolves the report addresses to the receiving mailboxes of the accounts behind them. */
export async function resolveReportMailboxes(db: Db, env: NodeJS.ProcessEnv): Promise<ReportMailboxes> {
  const addresses = await reportAddresses(db, env);
  const accountIds = new Set<string>();
  for (const address of addresses) {
    const at = address.lastIndexOf('@');
    const row = await db.address.findFirst({
      where: { localPart: address.slice(0, at), domain: { name: address.slice(at + 1) }, killedAt: null },
      select: { accountId: true, targets: { select: { accountId: true } } },
    });
    if (row === null) continue;
    if (row.accountId !== null) accountIds.add(row.accountId);
    for (const t of row.targets) accountIds.add(t.accountId);
  }
  if (accountIds.size === 0) return { addresses, mailboxIds: [] };
  const mailboxes = await db.mailbox.findMany({
    where: { accountId: { in: [...accountIds] }, OR: [{ specialUse: null }, { specialUse: { notIn: [...SKIPPED] } }] },
    select: { id: true },
  });
  return { addresses, mailboxIds: mailboxes.map((m) => m.id) };
}
