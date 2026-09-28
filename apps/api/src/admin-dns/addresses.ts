// The DNS checker's address rows (PST-T-4.15, PST-REQ-186): postmaster@ and abuse@ at the domain,
// and every mailbox its DMARC and TLS-RPT rua= name, must exist and deliver to someone. These are
// read from the database, not DNS — but they belong on the same screen, because a rua= that
// points at an address nobody receives is a DNS record that silently does nothing.
//
// Pass means the address resolves at RCPT as smtp-in would (not killed; an alias with at least one
// enabled target, or an owned address whose account is enabled). An address that exists but is not
// the shape the reconciler would have made is still a pass — it delivers, and the reconciler never
// touches an existing address — and the reason names where it goes, so the operator can see it.
import { ABUSE_LOCAL_PART, POSTMASTER_LOCAL_PART, type Db } from '@postroom/db';
import type { CheckRow } from './check.js';
import { bare } from './expected.js';

/** The addresses in a rua= value (`mailto:a@x,mailto:b@y!10m`), lowercased; non-mailto URIs dropped. */
export function ruaAddresses(rua: string): string[] {
  const out: string[] = [];
  for (const part of rua.split(',')) {
    const m = /^\s*mailto:([^!\s]+)/i.exec(part);
    if (m?.[1] !== undefined && m[1].includes('@')) out.push(m[1].toLowerCase());
  }
  return out;
}

interface AddressRowSpec {
  readonly record: 'Role address' | 'Report mailbox';
  readonly address: string;
  readonly note: string;
}

const ROLE_NOTE = 'An alias delivering to the first admin; Postroom creates it at start and when setup completes (RFC 5321 §4.5.1, RFC 2142).';
const DMARC_NOTE = 'The DMARC rua= mailbox: a service mailbox the report sweep reads; Postroom creates it at start and when setup completes.';
const TLS_NOTE = 'The TLS-RPT rua= mailbox: a service mailbox the report sweep reads; Postroom creates it at start and when setup completes.';

async function checkAddress(db: Db, spec: AddressRowSpec): Promise<CheckRow> {
  const at = spec.address.lastIndexOf('@');
  const localPart = spec.address.slice(0, at);
  const domainName = bare(spec.address.slice(at + 1));
  const base = { record: spec.record, name: spec.address, type: 'RCPT' as const, expected: null, afterGoLive: false, note: spec.note };
  const domain = await db.domain.findUnique({ where: { name: domainName }, select: { id: true } });
  if (domain === null) {
    return { ...base, live: [], status: 'pending', reason: `${domainName} is not a domain Postroom serves, so this mailbox is not checked here.` };
  }
  const row = await db.address.findUnique({
    where: { localPart_domainId: { localPart, domainId: domain.id } },
    select: {
      kind: true,
      killedAt: true,
      account: { select: { displayName: true, disabledAt: true } },
      targets: { select: { account: { select: { displayName: true, disabledAt: true } } } },
    },
  });
  if (row === null) {
    return { ...base, live: [], status: 'fail', reason: `${spec.address} does not exist: mail to it is refused at RCPT. Restart the api (or finish setup) to create it.` };
  }
  const receivers = row.kind === 'alias' ? row.targets.map((t) => t.account) : row.account === null ? [] : [row.account];
  const enabled = receivers.filter((a) => a.disabledAt === null).map((a) => a.displayName);
  const live = [`${row.kind} → ${receivers.length === 0 ? 'no one' : receivers.map((a) => a.displayName).join(', ')}`];
  if (row.killedAt !== null) return { ...base, live, status: 'fail', reason: `${spec.address} is killed: mail to it is refused.` };
  if (enabled.length === 0) return { ...base, live, status: 'fail', reason: `${spec.address} exists but delivers to no enabled account.` };
  return { ...base, live, status: 'pass', reason: `Delivers to ${enabled.join(', ')}.` };
}

/** postmaster@ and abuse@ at `domain`, then every mailbox the expected rua= values name. */
export async function checkRoleAddresses(db: Db, domain: string, rua: { dmarc: string; tls: string }): Promise<CheckRow[]> {
  const specs: AddressRowSpec[] = [POSTMASTER_LOCAL_PART, ABUSE_LOCAL_PART].map((l) => ({ record: 'Role address', address: `${l}@${bare(domain)}`, note: ROLE_NOTE }));
  const seen = new Set(specs.map((s) => s.address));
  for (const [value, note] of [[rua.dmarc, DMARC_NOTE], [rua.tls, TLS_NOTE]] as const) {
    for (const address of ruaAddresses(value)) {
      if (seen.has(address)) continue;
      seen.add(address);
      specs.push({ record: 'Report mailbox', address, note });
    }
  }
  return Promise.all(specs.map((s) => checkAddress(db, s)));
}
