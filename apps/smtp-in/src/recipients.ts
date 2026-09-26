// Recipient policy for inbound mail (PST-REQ-052, PST-REQ-053, PST-REQ-068).
//
// A recipient is accepted only when it names a live mailbox, alias, plus address, masked alias or
// service address at a domain Postroom serves. Everything else is refused at RCPT time, so DATA is
// never accepted without a valid recipient. There is no relay path here, from any client IP and
// with any credentials: smtp-in has no AUTH, and a domain we do not serve is always 550 5.7.1.
import type { Db } from '@postroom/db';
import { normalizeDomain, normalizeLocalPart } from '@postroom/db';
import { reply, type ForwardPath, type SmtpReply } from '@postroom/smtp-proto';

export type RecipientKind = 'mailbox' | 'alias' | 'plus' | 'masked' | 'service';

export type RejectReason =
  | 'relay-denied'
  | 'address-literal'
  | 'no-such-user'
  | 'killed'
  | 'alias-without-targets';

export interface RecipientAccepted {
  readonly ok: true;
  readonly kind: RecipientKind;
  /** Normalised `local@domain` of the address row that matched (the base address for plus). */
  readonly address: string;
  readonly accountIds: readonly string[];
  /** The `+tag` of a plus address. */
  readonly tag?: string;
  /** The site a masked alias was handed to. */
  readonly siteTag?: string;
}

export interface RecipientRejected {
  readonly ok: false;
  readonly reject: SmtpReply;
  readonly reason: RejectReason;
}

export type RecipientResolution = RecipientAccepted | RecipientRejected;

export interface AddressRecord {
  readonly kind: 'primary' | 'alias' | 'masked' | 'service';
  readonly accountId: string | null;
  readonly siteTag: string | null;
  readonly killedAt: Date | null;
  /** address_target account ids (alias fan-out). */
  readonly targets: readonly string[];
}

export interface DomainRecord {
  readonly id: string;
  readonly name: string;
}

/** The lookups recipient policy needs; Prisma in production, a map in unit tests. */
export interface RecipientStore {
  findDomain(name: string): Promise<DomainRecord | null>;
  primaryDomain(): Promise<DomainRecord | null>;
  findAddress(domainId: string, localPart: string): Promise<AddressRecord | null>;
}

export const RecipientReplies = {
  relayDenied: reply(550, '5.7.1', 'Relay not permitted'),
  noSuchUser: reply(550, '5.1.1', 'No such user'),
  ok: reply(250, '2.1.5', 'Recipient OK'),
} as const satisfies Record<string, SmtpReply>;

export function prismaRecipientStore(db: Db): RecipientStore {
  return {
    findDomain: (name) => db.domain.findUnique({ where: { name }, select: { id: true, name: true } }),
    primaryDomain: () =>
      db.domain.findFirst({ where: { isPrimary: true }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } }),
    findAddress: async (domainId, localPart) => {
      const row = await db.address.findUnique({
        where: { localPart_domainId: { localPart, domainId } },
        select: { kind: true, accountId: true, siteTag: true, killedAt: true, targets: { select: { accountId: true } } },
      });
      if (!row) return null;
      return {
        kind: row.kind,
        accountId: row.accountId,
        siteTag: row.siteTag,
        killedAt: row.killedAt,
        targets: row.targets.map((t) => t.accountId),
      };
    },
  };
}

function isStore(source: Db | RecipientStore): source is RecipientStore {
  return 'findAddress' in source;
}

function rejected(reason: RejectReason): RecipientRejected {
  const r = reason === 'relay-denied' || reason === 'address-literal' ? RecipientReplies.relayDenied : RecipientReplies.noSuchUser;
  return { ok: false, reject: r, reason };
}

/** Accept `local@domain` as a string, or a parsed forward path from the RCPT command. */
export type RecipientInput = string | ForwardPath;

function split(input: RecipientInput): { localPart: string; domain: string } | 'postmaster' | null {
  if (typeof input !== 'string') {
    return input.kind === 'postmaster' ? 'postmaster' : { localPart: input.mailbox.localPart, domain: input.mailbox.domain };
  }
  const at = input.lastIndexOf('@');
  if (at <= 0 || at === input.length - 1) return null;
  return { localPart: input.slice(0, at), domain: input.slice(at + 1) };
}

function toAccepted(kind: RecipientKind, address: string, rec: AddressRecord, extra: { tag?: string } = {}): RecipientResolution {
  if (rec.killedAt !== null) return rejected('killed');
  if (rec.kind === 'alias') {
    if (rec.targets.length === 0) return rejected('alias-without-targets');
    return { ok: true, kind, address, accountIds: [...new Set(rec.targets)], ...extra };
  }
  if (rec.accountId === null) return rejected('no-such-user');
  const siteTag = rec.kind === 'masked' && rec.siteTag !== null ? { siteTag: rec.siteTag } : {};
  return { ok: true, kind, address, accountIds: [rec.accountId], ...extra, ...siteTag };
}

const KIND_OF: Record<AddressRecord['kind'], RecipientKind> = {
  primary: 'mailbox',
  alias: 'alias',
  masked: 'masked',
  service: 'service',
};

/**
 * Decide one RCPT. The domain is checked first, so a domain we do not serve is 550 5.7.1 whatever
 * the local part; then the exact address; then `base+tag` against a primary or service address.
 */
export async function resolveRecipient(source: Db | RecipientStore, input: RecipientInput): Promise<RecipientResolution> {
  const store = isStore(source) ? source : prismaRecipientStore(source);
  const parts = split(input);
  if (parts === null) return rejected('no-such-user');

  let domain: DomainRecord | null;
  let rawLocal: string;
  if (parts === 'postmaster') {
    // RFC 5321 §4.1.1.3: bare <Postmaster> is the postmaster of our primary domain.
    domain = await store.primaryDomain();
    rawLocal = 'postmaster';
  } else {
    if (parts.domain.startsWith('[')) return rejected('address-literal');
    let name: string;
    try {
      name = normalizeDomain(parts.domain);
    } catch {
      // A domain that does not even normalise is certainly not one we serve: refused, not swallowed.
      return rejected('relay-denied');
    }
    domain = await store.findDomain(name);
    rawLocal = parts.localPart;
  }
  if (domain === null) return rejected('relay-denied');

  let local: string;
  try {
    local = normalizeLocalPart(rawLocal);
  } catch {
    // An empty or malformed local part names no mailbox.
    return rejected('no-such-user');
  }

  const exact = await store.findAddress(domain.id, local);
  if (exact !== null) return toAccepted(KIND_OF[exact.kind], `${local}@${domain.name}`, exact);

  const plus = local.indexOf('+');
  if (plus > 0) {
    const base = local.slice(0, plus);
    const tag = local.slice(plus + 1);
    const rec = await store.findAddress(domain.id, base);
    if (rec !== null && (rec.kind === 'primary' || rec.kind === 'service')) {
      return toAccepted('plus', `${base}@${domain.name}`, rec, tag === '' ? {} : { tag });
    }
  }
  return rejected('no-such-user');
}
