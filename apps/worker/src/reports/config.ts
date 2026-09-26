// Which mailboxes hold reports (PST-T-7.1, PST-REQ-122). The DMARC record's `rua=` and the
// `_smtp._tls` record's `rua=` point at service mailboxes (created on the admin Service accounts
// screen, PST-T-1.12): REPORTS_MAILBOX (default dmarc@<primary domain>) and TLSRPT_MAILBOX (default
// tlsrpt@<primary domain>). Either may be a comma-separated list. An address that does not exist
// yet is simply skipped: nothing is ingested until the mailbox is created.
//
// Every receiving folder of those accounts is read, not only INBOX: the classifier may sort a
// report into Updates or Notifications, and a report is a report wherever it was filed. Sent,
// Drafts, Trash and Rejects are never read.
import { SpecialUse, type Db } from '@postroom/db';

export interface ReportMailboxes {
  /** The configured addresses, lowercased. */
  readonly addresses: readonly string[];
  /** Mailbox ids the sweep reads. */
  readonly mailboxIds: readonly string[];
}

const SKIPPED: readonly SpecialUse[] = [SpecialUse.sent, SpecialUse.drafts, SpecialUse.trash, SpecialUse.rejects];

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
}

/** The report addresses for this install: env if set, else dmarc@ / tlsrpt@ the primary domain. */
export async function reportAddresses(db: Db, env: NodeJS.ProcessEnv): Promise<string[]> {
  let primary: string | null = null;
  const domain = async (): Promise<string | null> => (primary ??= (await db.domain.findFirst({ where: { isPrimary: true }, select: { name: true } }))?.name ?? null);
  const dmarc = list(env['REPORTS_MAILBOX']);
  const tls = list(env['TLSRPT_MAILBOX']);
  const out = new Set<string>();
  for (const a of dmarc) out.add(a);
  for (const a of tls) out.add(a);
  if (dmarc.length === 0 || tls.length === 0) {
    const d = await domain();
    if (d !== null) {
      if (dmarc.length === 0) out.add(`dmarc@${d}`);
      if (tls.length === 0) out.add(`tlsrpt@${d}`);
    }
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
