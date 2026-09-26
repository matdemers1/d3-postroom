// The records a Postroom domain is expected to publish (PST-REQ-099), generated from what the server
// actually knows: the domain, its dated DKIM selectors, the edge's public IP (EDGE_PUBLIC_IP, unset
// until the edge is provisioned) and the host names the protocols answer on. Pure, so it is
// unit-tested without DNS.
//
// Two records are deliberately never suggested here: anything at no-reply.<domain> (Cloudflare Email
// Service's own subdomain, with its own DMARC p=reject) and any record for another domain.
import { reverseDnsName } from '@postroom/dns';

export type RecordKind =
  | 'MX'
  | 'SPF'
  | 'DKIM'
  | 'DMARC'
  | 'PTR'
  | 'MTA-STS'
  | 'MTA-STS host'
  | 'TLS-RPT'
  | 'SRV'
  | 'autoconfig'
  | 'autodiscover';

export type DnsType = 'MX' | 'TXT' | 'PTR' | 'SRV' | 'CNAME';

export interface ExpectedRecord {
  /** Which check this row is. */
  readonly record: RecordKind;
  /** The owner name, without a trailing dot. */
  readonly name: string;
  readonly type: DnsType;
  /** The value to publish, exactly as it goes in the zone; null when it cannot be known yet. */
  readonly expected: string | null;
  /**
   * Published only when Postroom goes live (PST-REQ-086: nothing public until the security gate
   * passes). Absent from DNS before then is `pending`, not `missing`.
   */
  readonly afterGoLive: boolean;
  /** Why `expected` is null, or what the row needs, for the UI. */
  readonly note: string | null;
  /** Record-specific facts the evaluator needs (the SRV port and target, the DKIM selector…). */
  readonly detail: ExpectedDetail;
}

export type ExpectedDetail =
  | { readonly kind: 'mx'; readonly host: string }
  | { readonly kind: 'spf'; readonly ip: string | null }
  | { readonly kind: 'dkim'; readonly selector: string | null; readonly publicKey: string | null }
  | { readonly kind: 'dmarc' }
  | { readonly kind: 'ptr'; readonly ip: string | null; readonly host: string }
  | { readonly kind: 'mta-sts' }
  | { readonly kind: 'host'; readonly target: string }
  | { readonly kind: 'tls-rpt' }
  | { readonly kind: 'srv'; readonly port: number; readonly target: string };

export interface DkimKeyView {
  readonly selector: string;
  readonly dnsRecord: string;
}

export interface ExpectedInput {
  readonly domain: string;
  /** The MX and PTR host: MX_HOSTNAME, default mail.<domain>. */
  readonly mxHostname: string;
  /** IMAP_HOSTNAME / SUBMISSION_HOSTNAME, default the MX host. */
  readonly imapHostname: string;
  readonly submissionHostname: string;
  /** The web app's host (from WEB_ORIGIN): DAV, autoconfig and autodiscover are served there. */
  readonly webHostname: string;
  /** EDGE_PUBLIC_IP, or null while the edge is not provisioned. */
  readonly edgeIp: string | null;
  readonly dkim: readonly DkimKeyView[];
  /** Where DMARC aggregate reports go (DMARC_RUA), default mailto:dmarc-reports@<domain>. */
  readonly dmarcRua: string;
  /** Where TLS-RPT reports go (TLSRPT_RUA), default mailto:tls-reports@<domain>. */
  readonly tlsRptRua: string;
}

/** The subdomain this checker must never query or suggest anything for. */
export const FORBIDDEN_LABEL = 'no-reply';

export function isForbiddenName(name: string): boolean {
  const n = bare(name);
  return n === FORBIDDEN_LABEL || n.startsWith(`${FORBIDDEN_LABEL}.`) || n.includes(`.${FORBIDDEN_LABEL}.`);
}

/** Lowercase, no trailing dot. */
export function bare(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/** The DKIM p= value of a key record, whitespace removed; null when there is none. */
export function dkimPublicKey(record: string): string | null {
  for (const part of record.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === 'p') return part.slice(eq + 1).replace(/\s+/g, '');
  }
  return null;
}

export function expectedRecords(input: ExpectedInput): ExpectedRecord[] {
  const domain = bare(input.domain);
  const mx = bare(input.mxHostname);
  const rows: ExpectedRecord[] = [];
  const edgeNote = 'The edge is not provisioned yet (EDGE_PUBLIC_IP is unset), so its address is not known.';

  rows.push({
    record: 'MX',
    name: domain,
    type: 'MX',
    expected: `10 ${mx}.`,
    afterGoLive: true,
    note: 'Published only after the security gate passes (PST-REQ-086): expected after go-live.',
    detail: { kind: 'mx', host: mx },
  });

  rows.push({
    record: 'SPF',
    name: domain,
    type: 'TXT',
    expected: input.edgeIp === null ? null : `v=spf1 ${input.edgeIp.includes(':') ? 'ip6' : 'ip4'}:${input.edgeIp} -all`,
    afterGoLive: false,
    note: input.edgeIp === null ? edgeNote : 'Only the edge sends mail for this domain.',
    detail: { kind: 'spf', ip: input.edgeIp },
  });

  if (input.dkim.length === 0) {
    rows.push({
      record: 'DKIM',
      name: `<selector>._domainkey.${domain}`,
      type: 'TXT',
      expected: null,
      afterGoLive: false,
      note: 'No DKIM keys yet: generate them first (the setup wizard, or the dkim-keys CLI).',
      detail: { kind: 'dkim', selector: null, publicKey: null },
    });
  }
  for (const key of input.dkim) {
    rows.push({
      record: 'DKIM',
      name: `${key.selector}._domainkey.${domain}`,
      type: 'TXT',
      expected: key.dnsRecord,
      afterGoLive: false,
      note: `Selector ${key.selector}.`,
      detail: { kind: 'dkim', selector: key.selector, publicKey: dkimPublicKey(key.dnsRecord) },
    });
  }

  rows.push({
    record: 'DMARC',
    name: `_dmarc.${domain}`,
    type: 'TXT',
    expected: `v=DMARC1; p=none; rua=${input.dmarcRua}`,
    afterGoLive: false,
    note: 'p=none while Postroom is new; aggregate reports tell you when it is safe to tighten.',
    detail: { kind: 'dmarc' },
  });

  rows.push({
    record: 'PTR',
    name: input.edgeIp === null ? '<edge IP>.in-addr.arpa' : bare(reverseDnsName(input.edgeIp)),
    type: 'PTR',
    expected: input.edgeIp === null ? null : `${mx}.`,
    afterGoLive: false,
    note: input.edgeIp === null ? edgeNote : 'Set at the edge’s provider (Lightsail), and forward-confirmed: the name must resolve back to the edge.',
    detail: { kind: 'ptr', ip: input.edgeIp, host: mx },
  });

  rows.push({
    record: 'MTA-STS',
    name: `_mta-sts.${domain}`,
    type: 'TXT',
    expected: 'v=STSv1; id=<change on every policy edit>',
    afterGoLive: true,
    note: `With the policy served at https://mta-sts.${domain}/.well-known/mta-sts.txt. Expected after go-live.`,
    detail: { kind: 'mta-sts' },
  });
  rows.push({
    record: 'MTA-STS host',
    name: `mta-sts.${domain}`,
    type: 'CNAME',
    expected: `${bare(input.webHostname)}.`,
    afterGoLive: true,
    note: `Serves https://mta-sts.${domain}/.well-known/mta-sts.txt. Expected after go-live.`,
    detail: { kind: 'host', target: bare(input.webHostname) },
  });

  rows.push({
    record: 'TLS-RPT',
    name: `_smtp._tls.${domain}`,
    type: 'TXT',
    expected: `v=TLSRPTv1; rua=${input.tlsRptRua}`,
    afterGoLive: false,
    note: 'Senders report TLS failures delivering to you here.',
    detail: { kind: 'tls-rpt' },
  });

  const srv = (service: string, port: number, target: string, afterGoLive: boolean, note: string): void => {
    rows.push({
      record: 'SRV',
      name: `${service}.${domain}`,
      type: 'SRV',
      expected: `0 1 ${String(port)} ${bare(target)}.`,
      afterGoLive,
      note,
      detail: { kind: 'srv', port, target: bare(target) },
    });
  };
  srv('_submissions._tcp', 465, input.submissionHostname, true, 'Implicit-TLS submission (RFC 8314). Expected after go-live.');
  srv('_imaps._tcp', 993, input.imapHostname, true, 'IMAP over TLS (RFC 6186). Expected after go-live.');
  srv('_caldavs._tcp', 443, input.webHostname, false, 'CalDAV over HTTPS (RFC 6764).');
  srv('_carddavs._tcp', 443, input.webHostname, false, 'CardDAV over HTTPS (RFC 6764).');

  for (const [record, label] of [
    ['autoconfig', 'Thunderbird'],
    ['autodiscover', 'Outlook and Apple Mail'],
  ] as const) {
    rows.push({
      record,
      name: `${record}.${domain}`,
      type: 'CNAME',
      expected: `${bare(input.webHostname)}.`,
      afterGoLive: false,
      note: `${label} find their settings here; Postroom answers it (PST-T-3.6).`,
      detail: { kind: 'host', target: bare(input.webHostname) },
    });
  }

  // Belt and braces: nothing this function suggests may touch the Email Service subdomain.
  return rows.filter((r) => !isForbiddenName(r.name));
}

export interface HostEnv {
  readonly MX_HOSTNAME?: string | undefined;
  readonly IMAP_HOSTNAME?: string | undefined;
  readonly SUBMISSION_HOSTNAME?: string | undefined;
  readonly EDGE_PUBLIC_IP?: string | undefined;
  readonly DMARC_RUA?: string | undefined;
  readonly TLSRPT_RUA?: string | undefined;
}

const set = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim());

/** The environment-derived half of ExpectedInput. */
export function hostsFromEnv(env: HostEnv, domain: string, webOrigin: string): Omit<ExpectedInput, 'dkim'> {
  const d = bare(domain);
  const mxHostname = set(env.MX_HOSTNAME) ?? `mail.${d}`;
  return {
    domain: d,
    mxHostname,
    imapHostname: set(env.IMAP_HOSTNAME) ?? mxHostname,
    submissionHostname: set(env.SUBMISSION_HOSTNAME) ?? mxHostname,
    webHostname: new URL(webOrigin).hostname,
    edgeIp: set(env.EDGE_PUBLIC_IP),
    dmarcRua: set(env.DMARC_RUA) ?? `mailto:dmarc-reports@${d}`,
    tlsRptRua: set(env.TLSRPT_RUA) ?? `mailto:tls-reports@${d}`,
  };
}
