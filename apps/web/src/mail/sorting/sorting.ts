// PST-T-14.9 (PST-ADR-011; design audit TF-12, TF-I5, MOD-I8, IA-09, IA-I5): the pure half of
// "sorting you can see and correct where you read" — where a bucket chip shows, the one plain
// sentence its popover says, which corrections it offers, and the Inbox segment each browser
// remembers. Free of React so it is unit tested under Node, like split.ts and triage.ts.
//
// The sentence is built from the message's STORED sorting reasons (message_verdict.reasons, the
// worker's record of what decided it). Nothing here recomputes a decision, and nothing asks a model:
// it only picks the reason that decided the bucket and says it in words.
import type { InboxSegment } from '../split';

export const FILING_BUCKETS = ['priority', 'people', 'newsletters', 'updates', 'receipts', 'notifications', 'junk'] as const;
export type FilingBucket = (typeof FILING_BUCKETS)[number];

export const BUCKET_LABEL: Readonly<Record<FilingBucket, string>> = {
  priority: 'Priority',
  people: 'People',
  newsletters: 'Newsletters',
  updates: 'Updates',
  receipts: 'Receipts',
  notifications: 'Notifications',
  junk: 'Junk',
};

export function isFilingBucket(value: string | null | undefined): value is FilingBucket {
  return value !== null && value !== undefined && (FILING_BUCKETS as readonly string[]).includes(value);
}

export function bucketLabel(bucket: string | null | undefined): string {
  return isFilingBucket(bucket) ? BUCKET_LABEL[bucket] : (bucket ?? 'Unsorted');
}

// --- Where the chip shows ---------------------------------------------------------------------------

/** Where a message is being shown, as far as its bucket is concerned. */
export type ChipContext =
  | { kind: 'search' }
  | { kind: 'inbox'; segment: InboxSegment }
  /** Any other mailbox: a bucket folder already says its bucket (`bucket`); Archive, Sent … are not about sorting. */
  | { kind: 'mailbox'; bucket?: FilingBucket | null }
  /** A member of the open conversation, beside the bucket the open message is in. */
  | { kind: 'thread'; openBucket: string | null };

/**
 * A chip only where the bucket is NOT implied by what you are looking at: search results, the Inbox's
 * Everything (which mixes Priority and People), and thread members filed in a different bucket from
 * the message you opened. Inside Notifications there is no "Notifications" chip on every row — a
 * deliberate choice. The question is not lost there: the open message's header carries a quiet
 * "Why it's here" control instead (`whyControlShows`, PST-T-16.21), which opens the same popover.
 */
export function chipShows(bucket: string | null | undefined, context: ChipContext): boolean {
  if (!isFilingBucket(bucket)) return false;
  switch (context.kind) {
    case 'search':
      return true;
    case 'inbox':
      return context.segment === 'all';
    case 'mailbox':
      return false;
    case 'thread':
      return bucket !== context.openBucket;
  }
}

/**
 * The quiet "Why it's here" control in the open message's header: the chip's complement. The chip stays
 * away where the folder already says the bucket (see above, deliberately), but a person reading in
 * Receipts or Junk still gets to ask why the message is there and correct it, so the control shows
 * exactly there: the open message, in a bucket folder or Junk, sorted into a bucket.
 */
export function whyControlShows(bucket: string | null | undefined, context: ChipContext): boolean {
  return isFilingBucket(bucket) && context.kind === 'mailbox' && context.bucket !== null && context.bucket !== undefined;
}

/** Where a "Why it’s here" control is, and whether the message got there by Postroom’s sorting or by hand. */
export interface WhyPlacement {
  /** The bucket the message is in NOW: the folder it sits in. */
  bucket: FilingBucket;
  /**
   * The stored verdict names a different bucket from the folder. A manual move only moves the message,
   * never its verdict (the API's move path), so the stored bucket would describe the Inbox the message
   * left; the popover says plainly that the person moved it, and corrects from where it is now.
   */
  byHand: boolean;
}

/** The placement for the control, or null where it does not show (see `whyControlShows`). */
export function whyPlacement(bucket: string | null | undefined, context: ChipContext): WhyPlacement | null {
  if (!whyControlShows(bucket, context) || context.kind !== 'mailbox' || !isFilingBucket(context.bucket)) return null;
  return { bucket: context.bucket, byHand: bucket !== context.bucket };
}

/** What the popover says for a message the person moved into this folder themselves. */
export const MOVED_BY_HAND_SENTENCE = 'You moved this here.';

/** The bucket a mailbox IS (a bucket folder, or Junk), or null for the Inbox and everything else. */
export function mailboxBucket(mailbox: { name: string; specialUse: string | null } | null): FilingBucket | null {
  if (mailbox === null) return null;
  if (mailbox.specialUse === 'junk') return 'junk';
  if (mailbox.specialUse !== null) return null;
  const byName: Record<string, FilingBucket> = { Newsletters: 'newsletters', Updates: 'updates', Receipts: 'receipts', Notifications: 'notifications' };
  return byName[mailbox.name] ?? null;
}

/** Whether a message corrected into `bucket` still belongs in the list being shown (else it leaves). */
export function listKeeps(bucket: FilingBucket, context: ChipContext): boolean {
  switch (context.kind) {
    case 'search':
      return true;
    case 'inbox':
      return context.segment === 'all' ? bucket === 'priority' || bucket === 'people' : bucket === context.segment;
    case 'mailbox':
      return context.bucket === bucket;
    case 'thread':
      return true;
  }
}

// --- The one sentence -----------------------------------------------------------------------------

/** What a stored reason says, in words, after "because …"; null when it is not a deciding reason. */
function phrase(reason: string, bucket: FilingBucket): string | null {
  const r = reason.trim();
  let m: RegExpMatchArray | null;
  if ((m = /^corrected: you put this in [^,]+, and mail from (.+?) now goes there too$/.exec(r)) !== null) return `you corrected it, and mail from ${m[1] ?? ''} goes there now`;
  if ((m = /^pinned: (\S+) → (\S+)$/.exec(r)) !== null) {
    const on = m[1] ?? '';
    return on.startsWith('@') ? `you always put mail from ${on.slice(1)} there` : `you always put mail from ${on} there`;
  }
  if (r.startsWith('sieve bucket ')) return 'one of your rules put it there';
  if ((m = /^plus-address tag (\S+)$/.exec(r)) !== null) return `it was sent to your +${m[1] ?? ''} address`;
  if ((m = /^bayes: (\S+) (\d(?:\.\d+)?)/.exec(r)) !== null && m[1] === bucket) {
    const p = Number(m[2]);
    const pct = Number.isFinite(p) ? ` (${String(Math.round((p <= 1 ? p * 100 : p)))}% sure)` : '';
    return `it looks like mail you have kept in ${BUCKET_LABEL[bucket]} before${pct}`;
  }
  if (r === 'people: Bayes learned this account keeps such mail in INBOX') return 'it looks like mail you keep in your Inbox';
  const colon = r.indexOf(': ');
  if (colon < 0) return null;
  const head = r.slice(0, colon);
  const rest = r.slice(colon + 2);
  if (head === 'junk') {
    if (rest === 'sender is blocked') return 'you blocked this sender';
    if (rest.startsWith('smtp-in quarantined it')) return `the server quarantined it${rest.slice('smtp-in quarantined it'.length)}`;
    if (rest.startsWith('attachment ')) return `an ${rest}`;
    if (rest.startsWith('Precedence: junk')) return 'it calls itself junk and did not authenticate';
    if (rest === 'a junk rule wins over sorting') return null;
    return rest;
  }
  if (head !== bucket) return null;
  if (rest === 'human, known sender, addressed directly, not bulk') return 'someone you know wrote to you directly';
  if (rest === 'human sender not in reply graph, contacts, or an authenticated VIP pin') return 'a person wrote, but you have not written to them or saved them as a contact yet';
  if (rest === 'known sender but not addressed directly (To)') return 'someone you know wrote, but you were only copied';
  if (rest === 'known sender but message is bulk') return 'someone you know sent it as bulk mail';
  if (rest === 'List-Id/List-Unsubscribe present (mailing list)') return 'it came through a mailing list';
  if (rest === 'non-personal sender with no finer signal') return 'it came from a company rather than a person';
  if ((m = /^sender domain (\S+) is a notification system/.exec(rest)) !== null) return `${m[1] ?? ''} sends automated notifications`;
  if ((m = /^(\S+) header \(notification system\)$/.exec(rest)) !== null) return `it carries the ${m[1] ?? ''} header that notification systems send`;
  if ((m = /^subject mentions "([^"]+)"/.exec(rest)) !== null) return `the subject mentions “${m[1] ?? ''}”`;
  if ((m = /^sender "([^"]+)" is (an? [^(]+?) \(/.exec(rest)) !== null) return `${m[1] ?? ''} is ${(m[2] ?? '').trim()}`;
  if ((m = /^sent from a newsletter subdomain \("([^"]+)" of (\S+)\)$/.exec(rest)) !== null) return `it was sent from ${m[2] ?? ''}’s newsletter address`;
  if (rest.startsWith('Auto-Submitted:')) return 'it was sent automatically';
  if (rest.startsWith('automated sender')) return 'it came from an automated sender';
  if (rest.startsWith('bulk mail')) return 'it was sent as bulk mail';
  return rest;
}

/**
 * "Filed in Notifications because github.com sends automated notifications." — the reason that
 * decided, found in the stored list in the order the worker wrote it. A correction or a pin decides
 * over anything else; then the rule for this bucket; then Bayes. With nothing matching, the plain
 * fact of the bucket, never an invented why.
 */
export function whySentence(bucket: string | null | undefined, reasons: readonly string[]): string {
  if (!isFilingBucket(bucket)) return 'This message has not been sorted.';
  const label = BUCKET_LABEL[bucket];
  const where = bucket === 'priority' || bucket === 'people' ? `Filed in your Inbox as ${label}` : `Filed in ${label}`;
  const ordered = [
    ...reasons.filter((r) => r.startsWith('corrected:')).reverse(),
    ...reasons.filter((r) => r.startsWith('pinned:') && !r.includes('unauthenticated')),
    ...reasons.filter((r) => r.startsWith('sieve bucket ') || r.startsWith('plus-address tag ')),
    ...reasons.filter((r) => r.startsWith(`${bucket}: `) || (bucket === 'junk' && r.startsWith('junk: '))),
    ...reasons.filter((r) => r.startsWith('bayes: ')),
  ];
  for (const r of ordered) {
    const p = phrase(r, bucket);
    if (p !== null && p !== '') return `${where} because ${p}.`;
  }
  return `${where}.`;
}

// --- The corrections it offers -----------------------------------------------------------------------

/** Domains shared by unrelated people — kept in step with @postroom/classifier's preference.ts, which
 *  the server checks against (it refuses a domain preference here, so a drift fails safe). */
const SHARED_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com', 'fastmail.fm', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'hey.com', 'tuta.io', 'tutanota.com', 'comcast.net', 'verizon.net', 'att.net',
]);

export function domainOf(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const d = address.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
  return d === '' ? null : d;
}

/** Whether "Always put …" names the domain (automated buckets, never a mailbox provider) or the sender. */
export function preferenceScope(from: string | null | undefined, bucket: FilingBucket): 'sender' | 'domain' {
  if (bucket === 'priority' || bucket === 'people') return 'sender';
  const d = domainOf(from);
  return d === null || SHARED_DOMAINS.has(d) ? 'sender' : 'domain';
}

export interface AlwaysPut {
  scope: 'sender' | 'domain';
  bucket: FilingBucket;
  /** "Always put github.com in Notifications". */
  label: string;
}

/** "Always put <sender or domain> in <bucket>", for the bucket the message is in now. */
export function alwaysPut(from: string | null | undefined, fromName: string | null | undefined, bucket: FilingBucket): AlwaysPut | null {
  if (from === null || from === undefined || !from.includes('@')) return null;
  const scope = preferenceScope(from, bucket);
  const who = scope === 'domain' ? (domainOf(from) ?? from) : fromName !== null && fromName !== undefined && fromName.trim() !== '' ? fromName.trim() : from;
  return { scope, bucket, label: `Always put ${who} in ${BUCKET_LABEL[bucket]}` };
}

/** The move the popover leads with: the other half of the Inbox for Inbox mail, else Priority. */
export function suggestedMove(bucket: FilingBucket): FilingBucket {
  if (bucket === 'priority') return 'people';
  return 'priority';
}

/** Every other bucket, for "Somewhere else…". Junk is left to its own button (Not junk / Move to Junk). */
export function otherBuckets(bucket: FilingBucket): FilingBucket[] {
  return FILING_BUCKETS.filter((b) => b !== bucket && b !== suggestedMove(bucket) && b !== 'junk');
}

/** The Toast after a correction: what moved, and that the preference was saved. */
export function correctedMessage(bucket: FilingBucket, moved: boolean): string {
  return moved ? `Moved to ${BUCKET_LABEL[bucket]} · preference saved` : `Preference saved: ${BUCKET_LABEL[bucket]}`;
}

/** "notifications@github.com", or "github.com (the whole domain)" — a correction's preference in Rules. */
export function preferenceTarget(c: { target: string; scope: 'sender' | 'domain' }): string {
  return c.scope === 'domain' && c.target.startsWith('@') ? `${c.target.slice(1)} (the whole domain)` : c.target;
}

/** The Person card's helper line under "Their mail goes to". */
export function routingHelp(pin: string | null, bucket: string | null, name: string): string {
  if (isFilingBucket(pin)) return `You chose ${BUCKET_LABEL[pin]}. New mail from ${name} goes there.`;
  if (bucket === 'people') return `Sorted automatically. You haven't written to ${name} yet, so their mail is in People. Pick Priority to put them there from now on.`;
  if (isFilingBucket(bucket)) return `Sorted automatically — this message went to ${BUCKET_LABEL[bucket]}.`;
  return 'Sorted automatically.';
}

// --- The Inbox segment each browser remembers ----------------------------------------------------------

export const SEGMENT_STORAGE_KEY = 'postroom.inbox.segment';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The segment this browser last used; Everything by default, and whenever storage is unavailable. */
export function loadSegment(store: StorageLike | null = storage()): InboxSegment {
  try {
    const v = store?.getItem(SEGMENT_STORAGE_KEY) ?? null;
    return v === 'priority' || v === 'people' || v === 'all' ? v : 'all';
  } catch {
    return 'all';
  }
}

export function saveSegment(segment: InboxSegment, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(SEGMENT_STORAGE_KEY, segment);
  } catch {
    // Private mode, quota, a disabled store: the segment simply is not remembered.
  }
}
