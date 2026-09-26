// Contacts outside the DAV daemon: who is in an account's address books (for the classifier's
// "contact" signal and the phishing check's display-name rule), and the "Collected" address book
// that sending mail fills (PST-REQ-138).
//
// vCards are encrypted at rest (seal.ts), so "is this address a contact" means decrypting cards.
// ContactIndex does that once per account per change: it keys its cache on every address book's
// sync sequence, which every write advances in its own transaction — so a cached answer is never
// stale, and an unchanged account costs one small query. It is bounded twice: cards read per
// account, and accounts held.
//
// Harvest writes through DavStore.putResource like any DAV client, so the new card is audited, the
// sync token moves, and the iPhone's next sync-collection pulls it. Its resource name and UID are
// derived from the address, and the write is If-None-Match: *, so a replayed or concurrent harvest
// of the same address can never make a second card.
import { createHash } from 'node:crypto';
import type { RequestContext } from '@postroom/audit';
import type { Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import { parseVCard, serializeVCard } from '@postroom/vcard';
import { buildContactCard, contactOf } from './card.js';
import { openResource } from './seal.js';
import type { Collection, DavStore } from './store.js';

export interface ContactEntry {
  /** The contact's display name (may be ''). */
  readonly name: string;
  /** One e-mail address as written on the card. */
  readonly address: string;
  readonly addressBookId: string;
  /** The card's resource name in its address book. */
  readonly resourceName: string;
}

export interface ContactIndexOptions {
  /** Cards read per account; the rest are not consulted. Default 5000. */
  readonly maxCards?: number;
  /** Accounts cached (least recently used goes first). Default 256. */
  readonly maxAccounts?: number;
}

export class ContactIndex {
  private readonly cache = new Map<string, { key: string; entries: ContactEntry[] }>();
  private readonly maxCards: number;
  private readonly maxAccounts: number;

  constructor(
    private readonly db: Db,
    private readonly kek: Kek,
    options: ContactIndexOptions = {},
  ) {
    this.maxCards = options.maxCards ?? 5000;
    this.maxAccounts = options.maxAccounts ?? 256;
  }

  /** Every (name, address) pair on the account's cards, one per e-mail address. */
  async entries(accountId: string): Promise<ContactEntry[]> {
    const books = await this.db.davCollection.findMany({
      where: { accountId, kind: 'addressbook' },
      select: { id: true, syncSeq: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const key = books.map((b) => `${b.id}:${String(b.syncSeq)}`).join(',');
    const hit = this.cache.get(accountId);
    if (hit !== undefined && hit.key === key) {
      this.cache.delete(accountId);
      this.cache.set(accountId, hit);
      return hit.entries;
    }
    const entries: ContactEntry[] = [];
    let budget = this.maxCards;
    for (const book of books) {
      if (budget <= 0) break;
      const rows = await this.db.davResource.findMany({
        where: { collectionId: book.id },
        select: { id: true, name: true, wrappedDek: true, data: true },
        orderBy: { modSeq: 'asc' },
        take: budget,
      });
      budget -= rows.length;
      for (const row of rows) {
        let view;
        try {
          view = contactOf(parseVCard(openResource(this.kek, row), { maxCards: 1 }));
        } catch {
          continue; // A card the parser refuses is simply not consulted.
        }
        for (const e of view.emails) entries.push({ name: view.displayName, address: e.address, addressBookId: book.id, resourceName: row.name });
      }
    }
    this.cache.set(accountId, { key, entries });
    while (this.cache.size > this.maxAccounts) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return entries;
  }

  /** Lower-cased addresses on the account's cards. */
  async emails(accountId: string): Promise<Set<string>> {
    return new Set((await this.entries(accountId)).map((e) => e.address.trim().toLowerCase()));
  }

  /** The card carrying `address`, or null. */
  async lookup(accountId: string, address: string): Promise<ContactEntry | null> {
    const want = address.trim().toLowerCase();
    return (await this.entries(accountId)).find((e) => e.address.trim().toLowerCase() === want) ?? null;
  }
}

const indexes = new WeakMap<Db, Map<string, ContactIndex>>();

/** One shared index per database client and KEK in a process, so every caller shares its cache. */
export function contactIndexFor(db: Db, kek: Kek): ContactIndex {
  let byKek = indexes.get(db);
  if (byKek === undefined) {
    byKek = new Map();
    indexes.set(db, byKek);
  }
  let index = byKek.get(kek.id);
  if (index === undefined) {
    index = new ContactIndex(db, kek);
    byKek.set(kek.id, index);
  }
  return index;
}

export const COLLECTED_SLUG = 'collected';
export const COLLECTED_NAME = 'Collected';
/** Recipients harvested from one message, at most. */
export const MAX_HARVEST_PER_MESSAGE = 20;

const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)([-+._].*)?$/i;

/** An address that never answers mail: noreply@, do-not-reply@, mailer-daemon@, bounces+…@. */
export function isNoReplyAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && NOREPLY.test(address.slice(0, at));
}

/**
 * A mailing-list or role local part (PST-T-8.8): list, lists, announce, discuss, digest, owner-*,
 * *-request, *-bounces, *-owner, *-l, majordomo, listserv, mailman. These are the list's own
 * addresses, never a human's, so they are never harvested as contacts.
 */
const ROLE_LOCAL =
  /^(list|lists|announce|discuss|digest|majordomo|listserv|mailman|owner-.+|.+-request|.+-bounces|.+-owner|.+-l)$/i;

/** True when `localPart` names a mailing-list or role address rather than a person. */
export function isRoleLocalPart(localPart: string): boolean {
  return ROLE_LOCAL.test(localPart);
}

/** True when `address`'s local part names a mailing-list or role address (PST-T-8.8). */
export function isRoleAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && isRoleLocalPart(address.slice(0, at));
}

/**
 * The `mailto:` address named by a `List-Post` header value (`<mailto:list@example.org>`), or
 * null — including for `List-Post: NO` (posting disabled) and any value with no `mailto:` URI.
 */
export function parseListPost(value: string): string | null {
  const m = /<mailto:\s*([^>\s]+)\s*>/i.exec(value);
  const address = m?.[1];
  return address === undefined || address === '' ? null : address.trim().toLowerCase();
}

/** The deterministic UID of the Collected card for `address`: one card per address, ever. */
export function collectedUid(address: string): string {
  return `postroom-collected-${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
}

function splitName(name: string): { given: string; family: string } {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length < 2) return { given: words[0] ?? '', family: '' };
  return { given: words.slice(0, -1).join(' '), family: words[words.length - 1] ?? '' };
}

export interface HarvestInput {
  readonly accountId: string;
  /** To and Cc, as the message's headers name them. */
  readonly recipients: readonly { readonly name: string; readonly address: string }[];
  readonly context: RequestContext;
  readonly now: Date;
  /**
   * Addresses never harvested from this message even though they are a To/Cc recipient (PST-T-8.8):
   * a mailing list's own posting address, resolved by the caller from List-Post headers — its own,
   * or the message it is replying to's. Case-insensitive.
   */
  readonly excludedAddresses?: Iterable<string>;
}

export interface HarvestResult {
  /** Addresses that got a new card in Collected. */
  readonly added: string[];
}

/** The account's own addresses, live or killed, lower-cased: never harvested. */
async function ownAddresses(db: Db, accountId: string): Promise<Set<string>> {
  const rows = await db.address.findMany({
    where: { OR: [{ accountId }, { targets: { some: { accountId } } }] },
    select: { localPart: true, domain: { select: { name: true } } },
  });
  return new Set(rows.map((a) => `${a.localPart}@${a.domain.name}`.toLowerCase()));
}

async function collectedBook(store: DavStore, caller: { accountId: string; context: RequestContext }): Promise<Collection | null> {
  const existing = await store.getCollection(caller.accountId, 'addressbook', COLLECTED_SLUG);
  if (existing !== null) return existing;
  const created = await store.createCollection(caller, 'addressbook', COLLECTED_SLUG, {
    displayName: COLLECTED_NAME,
    description: 'People you have written to',
    color: null,
    sortOrder: null,
    components: [],
    deadProps: {},
  });
  if (created === 'full') return null;
  // null: someone else created it between the read and the insert.
  return created ?? (await store.getCollection(caller.accountId, 'addressbook', COLLECTED_SLUG));
}

/**
 * Adds every recipient that is in none of the account's address books to "Collected" (created on
 * first use), skipping the account's own addresses, no-reply addresses, mailing-list/role local
 * parts (list, owner-*, *-request, …; PST-T-8.8) and the caller's `excludedAddresses` (a list's
 * resolved posting address), at most {@link MAX_HARVEST_PER_MESSAGE} per message. Idempotent.
 */
export async function harvestRecipients(db: Db, store: DavStore, index: ContactIndex, input: HarvestInput): Promise<HarvestResult> {
  const own = await ownAddresses(db, input.accountId);
  const excluded = new Set([...(input.excludedAddresses ?? [])].map((a) => a.trim().toLowerCase()));
  const seen = new Set<string>();
  const candidates: { name: string; address: string }[] = [];
  for (const r of input.recipients) {
    const address = r.address.trim();
    const key = address.toLowerCase();
    const at = key.lastIndexOf('@');
    if (at <= 0 || at === key.length - 1 || seen.has(key) || own.has(key) || isNoReplyAddress(key) || isRoleAddress(key) || excluded.has(key)) continue;
    seen.add(key);
    candidates.push({ name: r.name.trim(), address });
    if (candidates.length >= MAX_HARVEST_PER_MESSAGE) break;
  }
  if (candidates.length === 0) return { added: [] };
  const known = await index.emails(input.accountId);
  const fresh = candidates.filter((c) => !known.has(c.address.toLowerCase()));
  if (fresh.length === 0) return { added: [] };

  const caller = { accountId: input.accountId, context: input.context };
  const book = await collectedBook(store, caller);
  if (book === null) return { added: [] };
  const added: string[] = [];
  for (const c of fresh) {
    const uid = collectedUid(c.address);
    const card = buildContactCard(uid, { fn: c.name, ...splitName(c.name), emails: [{ address: c.address, type: null }], tels: [], org: '', note: '' }, input.now);
    const outcome = await store.putResource(caller, book, {
      name: `${uid}.vcf`,
      uid,
      componentType: null,
      data: Buffer.from(serializeVCard(card), 'utf8'),
      preconditions: { ifNoneMatch: '*' },
    });
    if (outcome.status === 'created') added.push(c.address);
    else if (outcome.status === 'collection-full' || outcome.status === 'collection-gone') break;
  }
  return { added };
}
