// Which domains are ours (PST-T-7.9, PST-REQ-122). A DMARC aggregate report's
// `policy_published/domain`, or a TLS-RPT report's `policies[].policy-domain`, that is not one of
// our Domain rows did not arrive because of anything we sent: it is a report about someone else's
// domain that happened to be filed to our report mailbox (a misdirected `rua=`, a shared reporting
// address, or a receiver that mails every domain in one batch to the same address). We still store
// it — it is evidence, and the operator may want to see it — but it is marked foreign and kept out
// of every Deliverability aggregate, which exists to answer "how is *my* domain doing".
import type { Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient;

/** Our domain names, lowercased, as of the call. Read inside the ingest transaction so a domain
 * added between the report's arrival and now can never make a foreign report retroactively ours. */
export async function ourDomainNames(tx: Tx): Promise<Set<string>> {
  const rows = await tx.domain.findMany({ select: { name: true } });
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export type ReportStatus = 'ours' | 'foreign';

export interface Classified {
  readonly status: ReportStatus;
  readonly reason: string | null;
}

/** A DMARC report is ours when its published policy domain is one of ours. */
export function classifyDmarc(policyDomain: string, ourDomains: ReadonlySet<string>): Classified {
  const domain = policyDomain.toLowerCase();
  if (ourDomains.has(domain)) return { status: 'ours', reason: null };
  return { status: 'foreign', reason: `policy_published domain "${domain}" is not one of our domains` };
}

/** A TLS-RPT report is ours when at least one of its policies' domains is one of ours — a report
 * can (per RFC 8460) cover several policy domains at once, so it is foreign only when none match. */
export function classifyTlsRpt(policyDomains: readonly string[], ourDomains: ReadonlySet<string>): Classified {
  const domains = [...new Set(policyDomains.map((d) => d.toLowerCase()))];
  if (domains.some((d) => ourDomains.has(d))) return { status: 'ours', reason: null };
  const list = domains.length === 0 ? '(none reported)' : domains.join(', ');
  return { status: 'foreign', reason: `policy domain(s) ${list} are not one of our domains` };
}
