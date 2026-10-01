// PST-T-17.14 (admin critique 2.9 #6): the wizard's DNS step shows what this step asks the operator
// to publish, not the whole DNS screen. Pure, so the split is tested without a browser.
import { DNS_STATUS, type DnsCheckRow, type DnsStatus } from '../../api';

export interface WizardDnsGroups {
  /** Records to publish now: DNS records that are not held back for go-live. */
  now: DnsCheckRow[];
  /** Records published only after the security gate (MX, MTA-STS…): pending until then by design. */
  goLive: DnsCheckRow[];
  /** Address checks (postmaster@, abuse@, report mailboxes): checked in the database, not published. */
  addresses: DnsCheckRow[];
}

export function wizardDnsGroups(rows: readonly DnsCheckRow[]): WizardDnsGroups {
  const groups: WizardDnsGroups = { now: [], goLive: [], addresses: [] };
  for (const row of rows) {
    if (row.type === 'RCPT') groups.addresses.push(row);
    else if (row.afterGoLive) groups.goLive.push(row);
    else groups.now.push(row);
  }
  return groups;
}

/** The counts the summary line reads, over just the rows given. */
export function summaryOf(rows: readonly DnsCheckRow[]): Record<DnsStatus, number> {
  const counts: Record<DnsStatus, number> = { pass: 0, fail: 0, missing: 0, pending: 0, unknown: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** The live answer is worth showing only when it is not simply the expected value, already on screen. */
export function showLive(row: DnsCheckRow): boolean {
  return row.status !== 'pass' && row.live.length > 0;
}

/** Status words and tones, from the one table the DNS screen uses too. */
export function dnsStatus(row: DnsCheckRow): (typeof DNS_STATUS)[DnsStatus] {
  return DNS_STATUS[row.status];
}
