// Where a message is filed (PST-T-5.1, PST-REQ-101, PST-REQ-103, PST-ADR-007): the rule pass
// (`decide`), then the per-account naive Bayes for Other, then — only when Bayes is not ready — a
// small set of explainable header/subject rules that pick among the non-INBOX buckets.
//
//   · Priority and People go to INBOX, with the IMAP keyword $Priority or $People.
//   · Other goes to exactly one of Newsletters, Updates, Receipts or Notifications (real IMAP
//     folders), or Junk when Bayes learned it is junk or the sender is blocked.
//
// Pure and deterministic: the same signals, headers and model always give the same decision, and
// every decision carries non-empty reasons and the scores that produced it.

import { BUCKET_FOLDERS, type SortBucket } from './buckets.js';
import { decide } from './decide.js';
import { refineWithBayes, type BayesInput } from './bayes/refine.js';
import type { HeaderLike, Signals } from './signals.js';

/** The bucket a copy is filed into: INBOX's two halves, the four bucket folders, and Junk. */
export const FILING_BUCKETS = ['priority', 'people', 'newsletters', 'updates', 'receipts', 'notifications', 'junk'] as const;
export type FilingBucket = (typeof FILING_BUCKETS)[number];

export const PRIORITY_KEYWORD = '$Priority';
export const PEOPLE_KEYWORD = '$People';

/** A sender pin (PST-T-5.4, PST-REQ-105): the account pinned this message's From address to `bucket`. */
export interface PinInput {
  readonly bucket: FilingBucket;
}

export interface BucketForInput {
  readonly signals: Signals;
  /** The message's header fields (List-Id, X-GitHub-Reason, Auto-Submitted, ...). */
  readonly headers: readonly HeaderLike[];
  /** The decoded Subject, when known; otherwise it is read from `headers`. */
  readonly subject?: string | null;
  /** The sender pin for this message's From address, when the account has one; null/omitted otherwise. */
  readonly pin?: PinInput | null;
}

export interface FilingDecision {
  readonly bucket: FilingBucket;
  /** The mailbox name for the non-INBOX buckets; 'INBOX' for Priority/People; 'Junk' for junk. */
  readonly folder: string;
  /** $Priority or $People for an INBOX copy; null otherwise. */
  readonly keyword: string | null;
  readonly reasons: string[];
  readonly scores: Record<string, number>;
}

function header(headers: readonly HeaderLike[], name: string): string | null {
  const key = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === key) return h.value;
  return null;
}

function hasHeaderPrefix(headers: readonly HeaderLike[], prefix: string): string | null {
  const p = prefix.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase().startsWith(p)) return h.name;
  return null;
}

function domainOf(address: string | null): string {
  if (address === null) return '';
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase().replace(/\.+$/, '');
}

function domainIs(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** Senders whose mail is notifications (code hosts, calendars, monitoring, chat). */
const NOTIFIER_DOMAINS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'atlassian.net',
  'linear.app',
  'sentry.io',
  'slack.com',
  'discord.com',
  'calendar.google.com',
  'pagerduty.com',
  'statuspage.io',
  'uptimerobot.com',
  'vercel.com',
  'netlify.com',
  'circleci.com',
  'docker.com',
  'foreman.d3cloud.io',
  'shipyard.d3cloud.io',
];

/** Header names that only notification systems send. */
const NOTIFIER_HEADERS = ['x-github-reason', 'x-github-sender', 'x-gitlab-', 'x-jira-', 'x-linear-', 'x-sentry-', 'x-google-calendar-'];

const NOTIFIER_LOCAL = /(^|[._-])(notifications?|alerts?|calendar|calendar-notification|monitor(ing)?|builds?|ci|status)($|[._-])/i;

const RECEIPT_SUBJECT =
  /\b(receipt|invoice|your order|order (confirmation|confirmed|#|number|no\.?)|order\s+\S*\d|purchase|payment (received|confirmation|successful|processed)|you paid|thanks for your (order|purchase|payment)|refund|billing statement|subscription (renewed|renewal|confirmation))\b/i;

const UPDATE_SUBJECT =
  /\b(password|security (alert|notice|code)|sign[- ]?in|log[- ]?in|new device|verify|verification|confirm your (email|account)|account (update|activity|change)|2fa|two[- ]factor|one[- ]time (code|password)|shipped|shipping|out for delivery|delivered|delivery (scheduled|update|window)|tracking|your (package|shipment|delivery|ride|driver|order status)|arriv(ing|es|ed)|minutes away|terms of (service|use)|privacy policy|policy update|statement is ready|reset)\b/i;

/** Commerce senders whose From domain alone says "receipt" when the subject is not conclusive. */
const RECEIPT_SENDER_LOCAL = /(^|[._-])(receipts?|orders?|order-update|billing|invoices?|payments?|purchases?)($|[._-])/i;

const UPDATE_SENDER_LOCAL = /(^|[._-])(updates|security|account|accounts|verify|verification|shipping|shipment|tracking|delivery|auto-confirm)($|[._-])/i;

interface Rule {
  readonly bucket: Exclude<FilingBucket, 'priority' | 'people' | 'junk'>;
  readonly reason: string;
}

/** The explainable heuristics for an Other message, first match wins. Always returns a rule. */
export function heuristicBucket(input: BucketForInput): Rule {
  const { signals, headers } = input;
  const subject = (input.subject ?? header(headers, 'subject') ?? '').trim();
  const from = signals.fromAddress;
  const domain = domainOf(from);
  const local = from === null ? '' : from.slice(0, Math.max(0, from.lastIndexOf('@'))).toLowerCase();

  // 1. Notification systems: their own headers or their domains, before the bulk rule (GitHub
  //    notifications carry List-Id and List-Unsubscribe too).
  for (const name of NOTIFIER_HEADERS) {
    const found = name.endsWith('-') ? hasHeaderPrefix(headers, name) : header(headers, name) !== null ? name : null;
    if (found !== null) return { bucket: 'notifications', reason: `notifications: ${found} header (notification system)` };
  }
  const notifier = NOTIFIER_DOMAINS.find((d) => domainIs(domain, d));
  if (notifier !== undefined) return { bucket: 'notifications', reason: `notifications: sender domain ${domain} is a notification system (${notifier})` };

  // 2. Receipts: the subject says so, or a commerce sender's order/billing address.
  const receipt = RECEIPT_SUBJECT.exec(subject);
  if (receipt !== null) return { bucket: 'receipts', reason: `receipts: subject mentions "${receipt[0]}"` };
  if (RECEIPT_SENDER_LOCAL.test(local)) return { bucket: 'receipts', reason: `receipts: sender "${local}@${domain}" is an order/billing address` };

  // 3. Updates: transactional account, security and shipping mail.
  const update = UPDATE_SUBJECT.exec(subject);
  if (update !== null) return { bucket: 'updates', reason: `updates: subject mentions "${update[0]}" (account, security or shipping)` };
  if (UPDATE_SENDER_LOCAL.test(local)) return { bucket: 'updates', reason: `updates: sender "${local}@${domain}" is an account/security/shipping address` };

  // 4. Auto-Submitted (RFC 3834) or a notification-style sender: machine-generated notifications.
  const autoSubmitted = header(headers, 'auto-submitted');
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') {
    return { bucket: 'notifications', reason: `notifications: Auto-Submitted: ${autoSubmitted.trim()}` };
  }
  if (NOTIFIER_LOCAL.test(local)) return { bucket: 'notifications', reason: `notifications: sender "${local}@${domain}" is a notification address` };

  // 5. Newsletters: mailing-list and bulk-sender markers.
  if (header(headers, 'list-id') !== null || header(headers, 'list-unsubscribe') !== null) {
    return { bucket: 'newsletters', reason: 'newsletters: List-Id/List-Unsubscribe present (mailing list)' };
  }
  if (signals.bulk.value) return { bucket: 'newsletters', reason: `newsletters: bulk mail (${signals.bulk.reason})` };

  // 6. Anything else automated is a notification; anything else at all is an update.
  if (signals.automated.value) return { bucket: 'notifications', reason: `notifications: automated sender (${signals.automated.reason})` };
  return { bucket: 'updates', reason: 'updates: non-personal sender with no finer signal' };
}

function inbox(bucket: 'priority' | 'people', reasons: string[], scores: Record<string, number>): FilingDecision {
  const keyword = bucket === 'priority' ? PRIORITY_KEYWORD : PEOPLE_KEYWORD;
  return { bucket, folder: 'INBOX', keyword, reasons: [...reasons, `filed: INBOX with keyword ${keyword}`], scores: { ...scores, [`bucket:${bucket}`]: 1 } };
}

function folderFor(bucket: Exclude<SortBucket, 'inbox'>): string {
  return bucket === 'junk' ? 'Junk' : BUCKET_FOLDERS[bucket];
}

/**
 * A pin overrides the rule pass and Bayes entirely (PST-T-5.4, PST-REQ-105) — except that a pin
 * which would file into INBOX (Priority or People) requires the message to have authenticated,
 * exactly like the VIP rule: a spoofed From must not ride a pin into INBOX. A pin to any other
 * bucket (including Junk, the Block screen's outcome) needs no authentication — junking a spoofed
 * sender's mail is harmless. Returns null when there is no pin, or the pin failed that check (the
 * caller falls back to the normal rule/Bayes pass, and the reason the pin did not apply is recorded).
 */
function applyPin(input: BucketForInput): { decision: FilingDecision; skippedReason: null } | { decision: null; skippedReason: string | null } {
  const pin = input.pin;
  if (pin === null || pin === undefined) return { decision: null, skippedReason: null };
  const address = input.signals.fromAddress ?? 'unknown sender';
  const ridesToInbox = pin.bucket === 'priority' || pin.bucket === 'people';
  if (ridesToInbox && !input.signals.authenticated.value) {
    const skippedReason = `pinned: ${address} → ${pin.bucket}, but unauthenticated (${input.signals.authenticated.reason}) — a pin does not ride an unauthenticated message into INBOX`;
    return { decision: null, skippedReason };
  }
  const reason = `pinned: ${address} → ${pin.bucket}`;
  if (ridesToInbox) return { decision: inbox(pin.bucket, [reason], {}), skippedReason: null };
  const folder = folderFor(pin.bucket);
  return {
    decision: { bucket: pin.bucket, folder, keyword: null, reasons: [reason], scores: { [`bucket:${pin.bucket}`]: 1, pinned: 1 } },
    skippedReason: null,
  };
}

/**
 * The filing decision for one message in one account. `bayes` is the account's model for this
 * message's tokens; omit it (or pass `model: null`) when the account has none.
 */
export function bucketFor(input: BucketForInput, bayes?: BayesInput): FilingDecision {
  const pinned = applyPin(input);
  if (pinned.decision !== null) return pinned.decision;

  const rule = decide(input.signals);
  const refined = refineWithBayes(rule, bayes ?? { model: null, tokens: [] });
  const reasons = [...(pinned.skippedReason === null ? [] : [pinned.skippedReason]), ...refined.reasons];
  const scores = { ...refined.scores };

  if (rule.bucket === 'priority' || rule.bucket === 'people') return inbox(rule.bucket, reasons, scores);

  if (input.signals.membership.blocked.value) {
    reasons.push('junk: sender is blocked');
    return { bucket: 'junk', folder: 'Junk', keyword: null, reasons, scores: { ...scores, 'bucket:junk': 1 } };
  }

  // A sender that labels its own mail `Precedence: junk` and cannot authenticate it (no DMARC pass):
  // legitimate bulk senders authenticate, so this is unsolicited bulk rather than a newsletter.
  const precedence = header(input.headers, 'precedence');
  if (precedence !== null && precedence.trim().toLowerCase() === 'junk' && !input.signals.authenticated.value) {
    reasons.push(`junk: Precedence: junk from an unauthenticated sender (${input.signals.authenticated.reason})`);
    return { bucket: 'junk', folder: 'Junk', keyword: null, reasons, scores: { ...scores, 'bucket:junk': 1 } };
  }

  if (refined.refined !== null) {
    if (refined.refined === 'inbox') {
      reasons.push('people: Bayes learned this account keeps such mail in INBOX');
      return inbox('people', reasons, scores);
    }
    const folder = folderFor(refined.refined);
    reasons.push(`${refined.refined}: chosen by this account's Bayes model; filed to ${folder}`);
    return { bucket: refined.refined, folder, keyword: null, reasons, scores: { ...scores, [`bucket:${refined.refined}`]: 1 } };
  }

  const h = heuristicBucket(input);
  const folder = BUCKET_FOLDERS[h.bucket];
  reasons.push(h.reason, `filed: ${folder}`);
  return { bucket: h.bucket, folder, keyword: null, reasons, scores: { ...scores, [`bucket:${h.bucket}`]: 1, [`heuristic:${h.bucket}`]: 1 } };
}
