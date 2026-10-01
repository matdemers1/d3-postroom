// Pure logic behind the calm thread view (PST-T-14.6, PST-ADR-011; design audit VIS-06, VIS-07,
// CPY-01, CPY-02, MOD-I4, INT-I7): which actions the reading toolbar shows for a mailbox, what a
// one-line message header says ("to me, Jonah Reyes", "3 days ago"), and the exception chips' words.
// Kept free of @d3cloud/ui (and so of its CSS) so it is unit tested directly under Node.
import type { DeliveryRecipient, PhishWarning, SpecialUse } from '../../api';
import { cancelledSentence, type CancelledFields } from '../delivery';
import { addressOf, displayName, splitAddresses } from '../format';

// --- The toolbar -----------------------------------------------------------------------------------

/** The one action a mailbox's toolbar leads with, if any. */
export type LeadAction = 'reply' | 'notJunk' | 'rescue' | 'editDraft' | null;
/** Labelled triage buttons, in order. */
export type LabelledAction = 'archive' | 'delete';
/** Icon-only buttons (with tooltips and accessible names), in order. */
export type IconAction = 'reply' | 'replyAll' | 'forward';

export interface ToolbarModel {
  lead: LeadAction;
  labelled: readonly LabelledAction[];
  icons: readonly IconAction[];
  /** Whether the Snooze control belongs in the icon group here. */
  snooze: boolean;
}

/**
 * What a mailbox's actions are, for a message in a mailbox of this special use (PST-T-14.6). The
 * phone's bottom bar (MobileActionBar.tsx) reads it as is; the desktop toolbar reads it through
 * readingToolbar() below.
 *
 * Reply is the likely next move everywhere but Sent (replying to yourself is rare), Junk leads with
 * Not junk and Rejected with Rescue — the one thing you came there to do — and Drafts with Edit
 * draft. Everything rare lives in the ⋯ menu, which every mailbox has.
 */
export function toolbarModel(use: SpecialUse | null | undefined): ToolbarModel {
  switch (use) {
    case 'sent':
      return { lead: null, labelled: ['archive', 'delete'], icons: ['reply', 'replyAll', 'forward'], snooze: false };
    case 'junk':
      return { lead: 'notJunk', labelled: ['delete'], icons: ['reply', 'replyAll', 'forward'], snooze: false };
    case 'rejects':
      return { lead: 'rescue', labelled: ['delete'], icons: ['reply', 'replyAll', 'forward'], snooze: false };
    case 'drafts':
      return { lead: 'editDraft', labelled: ['delete'], icons: [], snooze: false };
    default:
      return { lead: 'reply', labelled: ['archive', 'delete'], icons: ['replyAll', 'forward'], snooze: true };
  }
}

/** The labelled move the desktop toolbar leads with — the point of that mailbox — if any. */
export type ReadingLead = 'notJunk' | 'rescue' | 'editDraft' | null;
/** Triage icon buttons, in order. */
export type TriageAction = LabelledAction;

export interface ReadingToolbar {
  lead: ReadingLead;
  triage: readonly TriageAction[];
  /** Whether the Snooze control belongs here. */
  snooze: boolean;
  /** Whether a reply makes sense: the header's Reply and the quick-reply bar. */
  reply: boolean;
}

/**
 * The desktop reading toolbar drawn to the redesign canvas (PST-T-15.3): triage as ghost icon
 * buttons — Archive, Delete, Move, Snooze — then the list position with up/down, then ⋯. Reply,
 * Reply all and Forward left the toolbar for the message header and the quick-reply bar under the
 * thread, so a Reply lead becomes no lead; Not junk, Rescue and Edit draft still lead.
 */
export function readingToolbar(use: SpecialUse | null | undefined): ReadingToolbar {
  const m = toolbarModel(use);
  return {
    lead: m.lead === 'reply' ? null : m.lead,
    triage: m.labelled,
    snooze: m.snooze,
    reply: m.lead === 'reply' || m.icons.includes('reply'),
  };
}

export const ACTION_LABEL = {
  reply: 'Reply',
  replyAll: 'Reply all',
  forward: 'Forward',
  archive: 'Archive',
  delete: 'Delete',
  move: 'Move',
  prev: 'Previous message',
  next: 'Next message',
  notJunk: 'Not junk',
  rescue: 'Rescue',
  editDraft: 'Edit draft',
} as const;

/** The Gmail key each action answers to (keys.ts), shown in a tooltip or a menu row. */
export const ACTION_KEY: Partial<Record<keyof typeof ACTION_LABEL | 'star' | 'markUnread' | 'inspect' | 'more', string>> = {
  reply: 'r',
  replyAll: 'a',
  forward: 'f',
  archive: 'e',
  delete: '#',
  move: 'v',
  prev: 'k',
  next: 'j',
  star: 's',
  markUnread: '⇧U',
  inspect: 'i',
};

/** "Reply all (a)" — a tooltip names the action and its key; the accessible name stays the action. */
export function tooltipText(label: string, key: string | undefined): string {
  return key === undefined ? label : `${label} (${key})`;
}

/** Where the open message sits in the list it was opened from. `more`: the list has further pages. */
export interface ListPosition {
  index: number;
  total: number;
  more: boolean;
}

/**
 * "3 of 48" — the open message's place in the loaded list, with a "+" when more pages wait behind
 * it (the count is what is loaded, never a guess). Null when the message is not in the list at all
 * (opened from a link or a search result that has since left it).
 */
export function positionLabel(p: ListPosition | null | undefined): string | null {
  if (p === null || p === undefined || p.index < 0 || p.index >= p.total) return null;
  return `${String(p.index + 1)} of ${String(p.total)}${p.more ? '+' : ''}`;
}

/** Whether up (the newer neighbour) and down (the older one) have somewhere to go. */
export function positionMoves(p: ListPosition | null | undefined): { prev: boolean; next: boolean } {
  if (positionLabel(p) === null || p === null || p === undefined) return { prev: false, next: false };
  return { prev: p.index > 0, next: p.index < p.total - 1 };
}

/** The quick-reply field's words: "Reply to Priya Shah…", or plain "Reply…" to your own message. */
export function quickReplyLabel(from: string | null | undefined, me: string | null): string {
  if (from === null || from === undefined || from.trim() === '') return 'Reply…';
  if (me !== null && addressOf(from) === me.toLowerCase()) return 'Reply…';
  return `Reply to ${displayName(from)}…`;
}

// --- The one-line header ---------------------------------------------------------------------------

/**
 * "to me, Jonah Reyes" — who else got it, by name, with the signed-in account as "me" and first.
 * `me` is compared by address, case-insensitively. Null when there are no recipients at all.
 */
export function recipientSummary(to: string | null, cc: string | null, me: string | null, max = 3): string | null {
  const entries = [...(to === null ? [] : splitAddresses(to)), ...(cc === null ? [] : splitAddresses(cc))];
  if (entries.length === 0) return null;
  const mine = me === null ? '' : me.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  let includesMe = false;
  for (const entry of entries) {
    const address = addressOf(entry);
    const key = address === '' ? entry : address;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mine !== '' && address === mine) includesMe = true;
    else names.push(displayName(entry));
  }
  const all = includesMe ? ['me', ...names] : names;
  if (all.length === 0) return null;
  const shown = all.slice(0, max);
  const rest = all.length - shown.length;
  return `to ${shown.join(', ')}${rest > 0 ? ` +${String(rest)}` : ''}`;
}

/** The sender's name for the header line: the display name, else the address, else a placeholder. */
export function senderName(from: string | null | undefined): string {
  if (from === null || from === undefined || from.trim() === '') return '(unknown sender)';
  return displayName(from);
}

/**
 * "just now", "5 min ago", "2 hr ago", "yesterday", "3 days ago", then a date — the absolute one is
 * a hover/focus away (MOD-I4). Future dates (a skewed clock) read as "just now".
 */
export function relativeDate(iso: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ms = now.getTime() - at.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hr ago`;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${String(days)} days ago`;
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return at.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Sat, Sep 26, 2026, 8:30 AM" — what the relative date expands to on hover or focus. */
export function absoluteDate(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// --- Exception chips -------------------------------------------------------------------------------
//
// A chip appears only when something is wrong. There is no positive "Verified" chip, ever: a
// lookalike domain passes its own DMARC, so a green tick would vouch for exactly the mail it should
// warn about (CPY-02). Normal is silent.

export type ChipTone = 'danger' | 'attention';

export interface Chip {
  tone: ChipTone;
  /** The chip's own words: "Unverified sender — looks spoofed". */
  label: string;
}

const PHISH_CHIP: Record<PhishWarning['kind'], string> = {
  'auth-failure': 'Unverified sender — looks spoofed',
  'display-name-spoofing': 'Sender name doesn’t match — looks spoofed',
  'lookalike-domain': 'Lookalike sender address',
  'punycode-domain': 'Disguised sender address',
  'first-time-brand-sender': 'Unverified sender — first message from this address',
  'link-mismatch': 'A link goes somewhere unexpected',
};

/** The chip for a message's phishing warnings (already sorted worst first), or null for none. */
export function phishChip(sorted: readonly PhishWarning[]): Chip | null {
  const worst = sorted[0];
  if (worst === undefined) return null;
  return { tone: worst.severity === 'high' ? 'danger' : 'attention', label: PHISH_CHIP[worst.kind] };
}

/**
 * The chip's plain sentence: what is wrong, in words (CPY-02) — the checks' own reasons ("DMARC failed
 * for …") follow it as quieter evidence. `from` is the sender's address, for its domain.
 */
export function phishLead(sorted: readonly Pick<PhishWarning, 'kind'>[], from: string | null): string {
  const address = from === null ? '' : addressOf(from);
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  const it = domain === '' ? 'the sender’s domain' : domain;
  switch (sorted[0]?.kind) {
    case 'auth-failure':
      return domain === '' ? 'The sender’s own domain says it didn’t send this.' : `This claims to be from ${domain}, but ${domain} says it didn’t send it.`;
    case 'display-name-spoofing':
      return 'The name it shows isn’t the address it came from.';
    case 'lookalike-domain':
      return `${it} looks like a well-known domain, but it isn’t that domain.`;
    case 'punycode-domain':
      return `${it} uses look-alike characters to imitate another name.`;
    case 'first-time-brand-sender':
      return 'It names a well-known company, but this is the first mail from this address.';
    case 'link-mismatch':
      return 'A link shows one address but goes to another.';
    default:
      return 'Postroom noticed something unusual about this message.';
  }
}

/** What to do about it, after the reason: the next step, in one short sentence. */
export function phishAdvice(sorted: readonly Pick<PhishWarning, 'severity'>[]): string {
  const worst = sorted[0]?.severity;
  if (worst === 'high') return 'Don’t open its links or reply unless you are sure who sent it.';
  if (worst === 'medium') return 'Check who sent it before you act on it.';
  return 'It may be nothing; Details has the evidence.';
}

/** A delivery state that is an exception worth a chip — deferred or bounced — and its tone. */
export function deliveryChipTone(state: DeliveryRecipient['state']): ChipTone | null {
  if (state === 'bounced') return 'danger';
  if (state === 'deferred') return 'attention';
  return null;
}

/** The plain sentence after a delivery chip: what happened, and the next step. Never the remote's text.
 *  A cancelled recipient gets one too (PST-T-16.14): why, and when, with no chip — it is neutral. */
export function deliverySentence(r: Pick<DeliveryRecipient, 'state' | 'address'> & CancelledFields, now?: Date, locale?: string): string | null {
  const domain = r.address.includes('@') ? r.address.slice(r.address.lastIndexOf('@') + 1) : r.address;
  if (r.state === 'deferred') return `${domain} isn’t accepting it yet. Postroom keeps trying and will tell you if it gives up.`;
  if (r.state === 'bounced') return `This never reached ${r.address}. Check the address, then send it again.`;
  if (r.state === 'cancelled') return cancelledSentence(r, now, locale);
  return null;
}
