// DKIM key rotation (PST-T-7.4, PST-REQ-125): quarterly, under dated selectors, publishing the new
// key before signing with it and retiring the old one 7 days after the switch.
//
// Postroom never edits DNS. The operator publishes TXT records (Cloudflare), so the state machine
// per (domain, algorithm) waits on what our resolver can actually see:
//
//   active ──(due: activeFrom + 3 months)──▶ new key created `pending` (old keeps signing)
//   pending ──(its TXT, with the matching p=, visible in DNS)──▶ new `active`,
//                                                               old `retiring`, retireAfter = switch + 7 days
//   retiring ──(now ≥ retireAfter)──▶ `retired` (the operator may now remove its TXT)
//
// A switch never happens without the DNS check, and retirement never happens before retireAfter.
// Every step is idempotent (re-read under the per-domain advisory lock before writing) and audited
// as the system. `rotateDkimKeys` is one pass; `dkim-keys rotate <domain>` runs it, daily, from the
// operator's Shipyard schedule — it does nothing until something is due.
import {
  dnsRecordFor,
  generateDkimKeys,
  parseTagList,
  sealDkimKey,
  stripWhitespace,
  type DkimAlgorithm,
  type DkimDns,
  type DkimKeyPair,
} from '@postroom/auth-checks';
import { recordAudit, type Actor } from '@postroom/audit';
import type { Kek } from '@postroom/crypto';
import { normalizeDomain, type Db } from '@postroom/db';
import { datedSelector, dkimAad, DKIM_ALGORITHMS, FROM_DB, KEY_STATE, TO_DB, UnknownDomainError, type KeyState } from './dkim.js';

/** A key signs for this many calendar months before its successor is created. */
export const ROTATION_PERIOD_MONTHS = 3;
/** A superseded key stays published — and so keeps verifying — this long after the switch. */
export const OVERLAP_DAYS = 7;

const DAY_MS = 86_400_000;
const SYSTEM: Actor = { kind: 'system', label: 'dkim-rotation' };

/** `d` plus `months` calendar months (UTC), clamped to the end of a shorter month (Jan 31 + 1 → Feb 28). */
export function addUtcMonths(d: Date, months: number): Date {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target;
}

/** When an active key's successor is due to be created. */
export function rotationDueAt(activeFrom: Date): Date {
  return addUtcMonths(activeFrom, ROTATION_PERIOD_MONTHS);
}

/** The earliest a key superseded at `switchedAt` may be retired. */
export function retireAfterFor(switchedAt: Date): Date {
  return new Date(switchedAt.getTime() + OVERLAP_DAYS * DAY_MS);
}

function keyTag(record: string): { k: string; p: string } | undefined {
  let tags: Map<string, string>;
  try {
    tags = parseTagList(record);
  } catch {
    return undefined;
  }
  const v = tags.get('v');
  if (v !== undefined && v !== 'DKIM1') return undefined;
  return { k: (tags.get('k') ?? 'rsa').toLowerCase(), p: stripWhitespace(tags.get('p') ?? '') };
}

/** Whether any of the `published` TXT values carries the same key (k= and a non-empty p=) as `expected`. */
export function txtMatches(published: readonly string[], expected: string): boolean {
  const want = keyTag(expected);
  if (want === undefined || want.p === '') return false;
  return published.some((txt) => {
    const got = keyTag(txt);
    return got !== undefined && got.k === want.k && got.p === want.p;
  });
}

export type DnsVisibility = { readonly visible: true } | { readonly visible: false; readonly reason: string };

const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;

/** Ask the resolver whether `dnsName` publishes `dnsRecord`'s key. A lookup failure is "not visible". */
export async function checkPublished(dns: DkimDns, dnsName: string, dnsRecord: string): Promise<DnsVisibility> {
  let records: readonly string[];
  try {
    const answer = await dns.txt(dnsName);
    if (Array.isArray(answer)) {
      records = answer as readonly string[];
    } else {
      const result = answer as Exclude<typeof answer, readonly string[]>;
      if (result.rcode !== RCODE_NOERROR && result.rcode !== RCODE_NXDOMAIN) {
        return { visible: false, reason: `DNS lookup of ${dnsName} failed (rcode ${String(result.rcode)})` };
      }
      records = result.answers.flatMap((a) => (a.kind === 'TXT' ? [a.strings.join('')] : []));
    }
  } catch (err) {
    return { visible: false, reason: `DNS lookup of ${dnsName} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (records.length === 0) return { visible: false, reason: `no TXT record at ${dnsName} yet` };
  if (!txtMatches(records, dnsRecord)) return { visible: false, reason: `the TXT at ${dnsName} does not carry this key's p= value` };
  return { visible: true };
}

export type RotationEventKind = 'retired' | 'switched' | 'awaiting-dns' | 'created-pending' | 'not-due' | 'no-active-key';

export interface RotationEvent {
  readonly algorithm: DkimAlgorithm;
  readonly kind: RotationEventKind;
  /** The key the event is about (the new key for created/awaiting/switched, the old one for retired). */
  readonly selector?: string;
  readonly dnsName?: string;
  readonly dnsRecord?: string;
  /** For the operator, one line. */
  readonly detail: string;
}

export interface RotateOptions {
  /** The resolver the DNS check goes through: our validating resolver in production. */
  readonly dns: DkimDns;
  readonly now?: Date;
  /** Create the successor now even when rotation is not yet due. Never skips the DNS check. */
  readonly force?: boolean;
  readonly actor?: Actor;
}

interface Row {
  readonly id: string;
  readonly selector: string;
  readonly algorithm: DkimAlgorithm;
  readonly state: KeyState;
  readonly dnsRecord: string;
  readonly activeFrom: Date;
  readonly retireAfter: Date | null;
}

const ROW_SELECT = { id: true, selector: true, algorithm: true, state: true, dnsRecord: true, activeFrom: true, retireAfter: true } as const;

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

async function lockDomain(tx: Tx, name: string): Promise<void> {
  // The same lock ensureDkimKeys takes: key creation and rotation for a domain never interleave.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`postroom-dkim:${name}`}, 0))`;
}

async function liveRows(db: Db | Tx, domainId: string, algorithm: DkimAlgorithm): Promise<Row[]> {
  const rows = await db.dkimKey.findMany({
    where: { domainId, algorithm: TO_DB[algorithm], state: { in: [KEY_STATE.pending, KEY_STATE.active, KEY_STATE.retiring] } },
    orderBy: { activeFrom: 'desc' },
    select: ROW_SELECT,
  });
  return rows.map((r) => ({ ...r, algorithm: FROM_DB[r.algorithm], state: r.state }));
}

function dnsNameOf(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`;
}

/**
 * One rotation pass over every algorithm of `domain`: retire what is past its overlap, switch to a
 * pending key whose TXT is now visible, and create a pending successor for an active key that is
 * due. Returns what happened (and what is still waiting) per algorithm.
 */
export async function rotateDkimKeys(db: Db, kek: Kek, domainName: string, options: RotateOptions): Promise<RotationEvent[]> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? SYSTEM;
  const name = normalizeDomain(domainName);
  const domain = await db.domain.findUnique({ where: { name }, select: { id: true } });
  if (domain === null) throw new UnknownDomainError(name);

  const events: RotationEvent[] = [];
  let pairs: { rsa: DkimKeyPair; ed25519: DkimKeyPair } | undefined;

  for (const algorithm of DKIM_ALGORITHMS) {
    // 1. Retire every superseded key whose 7 days are up — and none whose aren't.
    for (const key of await liveRows(db, domain.id, algorithm)) {
      if (key.state !== KEY_STATE.retiring || key.retireAfter === null || now < key.retireAfter) continue;
      const retired = await db.$transaction(async (tx) => {
        await lockDomain(tx, name);
        const { count } = await tx.dkimKey.updateMany({
          where: { id: key.id, state: KEY_STATE.retiring, retireAfter: { lte: now } },
          data: { state: KEY_STATE.retired, retiredAt: now },
        });
        if (count === 0) return false;
        await recordAudit(tx, {
          actor,
          action: 'dkim_key.retire',
          entityType: 'dkim_key',
          entityId: key.id,
          before: { state: KEY_STATE.retiring, retireAfter: key.retireAfter?.toISOString() },
          after: { domain: name, selector: key.selector, algorithm, state: KEY_STATE.retired, retiredAt: now.toISOString() },
        });
        return true;
      });
      if (retired) {
        const dnsName = dnsNameOf(key.selector, name);
        events.push({ algorithm, kind: 'retired', selector: key.selector, dnsName, dnsRecord: key.dnsRecord, detail: `retired ${key.selector}: the TXT at ${dnsName} may now be removed` });
      }
    }

    const rows = await liveRows(db, domain.id, algorithm);
    const pending = rows.find((r) => r.state === KEY_STATE.pending);
    const active = rows.find((r) => r.state === KEY_STATE.active);

    // 2. A pending key switches in only once our resolver sees its TXT with the matching p=.
    if (pending !== undefined) {
      const dnsName = dnsNameOf(pending.selector, name);
      const seen = await checkPublished(options.dns, dnsName, pending.dnsRecord);
      if (!seen.visible) {
        events.push({ algorithm, kind: 'awaiting-dns', selector: pending.selector, dnsName, dnsRecord: pending.dnsRecord, detail: `${seen.reason}; still signing with ${active?.selector ?? 'nothing'}` });
        continue;
      }
      const retireAfter = retireAfterFor(now);
      const switched = await db.$transaction(async (tx) => {
        await lockDomain(tx, name);
        const { count } = await tx.dkimKey.updateMany({
          where: { id: pending.id, state: KEY_STATE.pending },
          data: { state: KEY_STATE.active, activeFrom: now, dnsVerifiedAt: now },
        });
        if (count === 0) return null;
        const previous = await tx.dkimKey.findMany({
          where: { domainId: domain.id, algorithm: TO_DB[algorithm], state: KEY_STATE.active, id: { not: pending.id } },
          select: { id: true, selector: true },
        });
        for (const old of previous) {
          await tx.dkimKey.update({ where: { id: old.id }, data: { state: KEY_STATE.retiring, retireAfter } });
          await recordAudit(tx, {
            actor,
            action: 'dkim_key.retiring',
            entityType: 'dkim_key',
            entityId: old.id,
            before: { state: KEY_STATE.active },
            after: { domain: name, selector: old.selector, algorithm, state: KEY_STATE.retiring, retireAfter: retireAfter.toISOString(), supersededBy: pending.selector },
          });
        }
        await recordAudit(tx, {
          actor,
          action: 'dkim_key.activate',
          entityType: 'dkim_key',
          entityId: pending.id,
          before: { state: KEY_STATE.pending },
          after: { domain: name, selector: pending.selector, algorithm, state: KEY_STATE.active, activeFrom: now.toISOString(), dnsVerifiedAt: now.toISOString() },
        });
        return previous.map((p) => p.selector);
      });
      if (switched !== null) {
        const old = switched.length > 0 ? `; ${switched.join(', ')} retiring, keep its TXT published until at least ${retireAfter.toISOString()}` : '';
        events.push({ algorithm, kind: 'switched', selector: pending.selector, dnsName, dnsRecord: pending.dnsRecord, detail: `now signing with ${pending.selector}${old}` });
      }
      continue;
    }

    // 3. Create the successor of a key that is due, as `pending`: it signs nothing yet.
    if (active === undefined) {
      events.push({ algorithm, kind: 'no-active-key', detail: `no active ${algorithm} key: run \`dkim-keys ${name}\` first` });
      continue;
    }
    const dueAt = rotationDueAt(active.activeFrom);
    if (options.force !== true && now < dueAt) {
      events.push({ algorithm, kind: 'not-due', selector: active.selector, detail: `${active.selector} signs until rotation is due at ${dueAt.toISOString()}` });
      continue;
    }
    pairs ??= generateDkimKeys();
    const pair = algorithm === 'rsa-sha256' ? pairs.rsa : pairs.ed25519;
    const dnsRecord = dnsRecordFor(algorithm, pair.publicKey);
    const created = await db.$transaction(async (tx) => {
      await lockDomain(tx, name);
      const raced = await tx.dkimKey.findFirst({
        where: { domainId: domain.id, algorithm: TO_DB[algorithm], state: KEY_STATE.pending },
        select: { selector: true },
      });
      if (raced !== null) return null;
      const taken = await tx.dkimKey.findMany({ where: { domainId: domain.id }, select: { selector: true } });
      const selector = datedSelector(now, algorithm, new Set(taken.map((t) => t.selector)));
      const row = await tx.dkimKey.create({
        data: {
          domainId: domain.id,
          selector,
          algorithm: TO_DB[algorithm],
          dnsRecord,
          sealedPrivate: new Uint8Array(sealDkimKey(kek, pair.privateKey, dkimAad(name, selector))),
          kekId: kek.id,
          activeFrom: now,
          state: KEY_STATE.pending,
        },
        select: { id: true },
      });
      await recordAudit(tx, {
        actor,
        action: 'dkim_key.create',
        entityType: 'dkim_key',
        entityId: row.id,
        before: null,
        after: { domain: name, selector, algorithm, dnsRecord, kekId: kek.id, state: KEY_STATE.pending, replaces: active.selector },
      });
      return selector;
    });
    if (created !== null) {
      const dnsName = dnsNameOf(created, name);
      events.push({ algorithm, kind: 'created-pending', selector: created, dnsName, dnsRecord, detail: `publish the TXT at ${dnsName}; ${active.selector} keeps signing until it is visible` });
    }
  }
  return events;
}

export interface DkimKeyStatus {
  readonly selector: string;
  readonly algorithm: DkimAlgorithm;
  readonly state: KeyState;
  readonly dnsName: string;
  readonly dnsRecord: string;
  readonly activeFrom: Date;
  readonly retireAfter: Date | null;
  readonly retiredAt: Date | null;
  /** What the operator should do with this key's TXT record. */
  readonly instruction: string;
}

/** Every key of `domain`, newest first, with what to do about its TXT record. */
export async function dkimKeyStatus(db: Db, domainName: string): Promise<DkimKeyStatus[]> {
  const name = normalizeDomain(domainName);
  const domain = await db.domain.findUnique({ where: { name }, select: { id: true } });
  if (domain === null) throw new UnknownDomainError(name);
  const rows = await db.dkimKey.findMany({
    where: { domainId: domain.id },
    orderBy: [{ createdAt: 'desc' }, { selector: 'asc' }],
    select: { ...ROW_SELECT, retiredAt: true },
  });
  return rows.map((r) => {
    const state = r.state;
    const instruction =
      state === KEY_STATE.pending
        ? 'publish this TXT record; signing switches to it once our resolver sees it'
        : state === KEY_STATE.active
          ? 'keep published: signing with this key'
          : state === KEY_STATE.retiring
            ? `keep published until at least ${r.retireAfter?.toISOString() ?? '?'}: verifies mail signed before the switch`
            : 'retired: this TXT record may be removed';
    return {
      selector: r.selector,
      algorithm: FROM_DB[r.algorithm],
      state,
      dnsName: dnsNameOf(r.selector, name),
      dnsRecord: r.dnsRecord,
      activeFrom: r.activeFrom,
      retireAfter: r.retireAfter,
      retiredAt: r.retiredAt,
      instruction,
    };
  });
}
