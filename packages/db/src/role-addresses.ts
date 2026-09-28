// The role and report addresses every served domain keeps (PST-T-4.15, PST-REQ-186), named in one
// place so the DNS checker's rua= suggestions, report ingest, the Deliverability screen's DMARC
// proposals and the api's reconciler can never disagree again. (They did: DNS published
// dmarc-reports@ / tls-reports@ while ingest read dmarc@ / tlsrpt@, so no report was ever read.)
//
// Pure: no database, so both the api and the worker import it without dragging anything along.

/** RFC 5321 §4.5.1 and RFC 2142: every mail domain answers postmaster@ and abuse@. */
export const POSTMASTER_LOCAL_PART = 'postmaster';
export const ABUSE_LOCAL_PART = 'abuse';
export const ROLE_LOCAL_PARTS: readonly string[] = [POSTMASTER_LOCAL_PART, ABUSE_LOCAL_PART];

/** The default local parts of the DMARC (RFC 7489 rua=) and TLS-RPT (RFC 8460 rua=) mailboxes. */
export const DMARC_REPORTS_LOCAL_PART = 'dmarc-reports';
export const TLS_REPORTS_LOCAL_PART = 'tls-reports';

/** The environment variables that override the defaults; either may be a comma-separated list. */
export interface ReportMailboxEnv {
  readonly REPORTS_MAILBOX?: string | undefined;
  readonly TLSRPT_MAILBOX?: string | undefined;
}

export interface ReportMailboxAddresses {
  /** Where DMARC aggregate reports go, lowercased. Never empty. */
  readonly dmarc: readonly string[];
  /** Where TLS-RPT reports go, lowercased. Never empty. */
  readonly tls: readonly string[];
}

/** The addresses in a comma-separated override, lowercased; anything without an '@' is dropped. */
export function addressList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
}

/**
 * The report mailboxes for `domain`: REPORTS_MAILBOX / TLSRPT_MAILBOX when set, else
 * dmarc-reports@<domain> and tls-reports@<domain>. Called with the primary domain for the
 * install-wide answer, and with each served domain for that domain's own DNS.
 */
export function reportMailboxesFor(env: ReportMailboxEnv, domain: string): ReportMailboxAddresses {
  const d = domain.trim().toLowerCase().replace(/\.+$/, '');
  const dmarc = addressList(env.REPORTS_MAILBOX);
  const tls = addressList(env.TLSRPT_MAILBOX);
  return {
    dmarc: dmarc.length > 0 ? dmarc : [`${DMARC_REPORTS_LOCAL_PART}@${d}`],
    tls: tls.length > 0 ? tls : [`${TLS_REPORTS_LOCAL_PART}@${d}`],
  };
}

/** The rua= value that names these addresses: `mailto:a,mailto:b`. */
export function ruaOf(addresses: readonly string[]): string {
  return addresses.map((a) => `mailto:${a}`).join(',');
}
