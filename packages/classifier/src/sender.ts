// Sender-shape cues (PST-T-5.9, PST-REQ-101, PST-ADR-007): does this From look like an organisation's
// transactional system or like a person? Read from the address, the domain, the display name and the
// subject — the evidence a message still carries when it has NO bulk or automation header at all.
//
// Why this exists: `detectHuman` used to call any sender with a non-empty display name human unless a
// List-*/Auto-Submitted/ESP header said otherwise, so "PagerDuty <alerts@pagerduty.com>" or
// "Brightcup <receipts@brightcup.example>" with plain headers landed in INBOX as People. Now both
// sides are weighed, and every cue that fires is named in the reasons:
//
//   transactional, strong (+2 each)
//     · local part is a role/transactional mailbox (orders, billing+eu, order-confirm, rx-updates …)
//     · domain is a known notification/commerce/transactional sender (github.com, paypal.com …)
//     · the display name is an organisation's: it equals a domain label ("Brightcup" @brightcup.…),
//       or has organisation words or marks (Team, Support, Market, Inc, "&", digits) and no
//       personal name in front of them
//   transactional, weak (+1 each)
//     · a sending subdomain (mail.*, email.*, notify.*, bounce.*, billing.* …)
//     · a transactional subject (receipt, sign-in, shipped, mentioned you …) — not on a reply/forward
//   personal
//     · +1 the display name (before any title suffix) looks like "First Last"
//     · +2 the local part is built from the display name (jane.doe ↔ Jane Doe, ghaddad ↔ Grace Haddad)
//
// A sender is transactional when the transactional score is at least 2 AND exceeds the personal
// score. A tie keeps a sender human — a colleague in billing is still a colleague. Membership (reply
// graph, contacts, VIP pin) is applied by the caller and always wins over these cues.

/** What a token in a local part or subdomain label says about the mailbox behind it. */
export type SenderCategory = 'receipt' | 'update' | 'notification' | 'newsletter' | 'role';

// A role/transactional vocabulary. Deliberately excludes words that are also common given names
// (bill, will, mark, chase, grace, hope, joy, page, ray) — a local part is matched token by token, so
// "bill@" stays a person while "billing@" and "billpay@" do not.
const VOCABULARY: Readonly<Record<SenderCategory, readonly string[]>> = {
  receipt: [
    'order', 'orders', 'orderdesk', 'receipt', 'receipts', 'invoice', 'invoices', 'invoicing', 'billing', 'billpay',
    'payment', 'payments', 'pay', 'purchase', 'purchases', 'checkout', 'refund', 'refunds', 'transaction',
    'transactions', 'subscription', 'subscriptions', 'renewal', 'renewals', 'donation', 'donations', 'ar',
  ],
  update: [
    'account', 'accounts', 'myaccount', 'security', 'secure', 'verify', 'verification', 'confirm', 'confirmation',
    'confirmations', 'auth', 'login', 'signin', 'password', 'identity', 'otp', 'mfa', 'shipping', 'shipment',
    'shipments', 'ship', 'tracking', 'track', 'delivery', 'deliveries', 'logistics', 'courier', 'dispatch',
    'update', 'updates', 'trip', 'trips', 'ride', 'rides', 'rider', 'travel', 'itinerary', 'booking', 'bookings',
    'reservation', 'reservations', 'appointment', 'appointments', 'statement', 'statements', 'policy', 'legal',
    'privacy', 'compliance', 'rx', 'pharmacy', 'claims',
  ],
  notification: [
    'notification', 'notifications', 'notify', 'notifier', 'notice', 'notices', 'alert', 'alerts', 'alerting',
    'calendar', 'reminder', 'reminders', 'monitor', 'monitoring', 'build', 'builds', 'ci', 'deploy', 'deploys',
    'deployment', 'deployments', 'bot', 'bots', 'robot', 'activity', 'comments', 'mentions', 'messages',
    'invite', 'invites', 'invitations', 'events', 'status', 'oncall', 'pager', 'incident', 'incidents', 'tickets', 'jira',
  ],
  newsletter: [
    'newsletter', 'newsletters', 'news', 'digest', 'weekly', 'daily', 'marketing', 'promo', 'promos', 'promotions',
    'offers', 'deals', 'rewards', 'announce', 'announcements', 'community', 'editor', 'editors', 'issue',
  ],
  role: [
    'info', 'support', 'help', 'helpdesk', 'care', 'customercare', 'customer', 'customers', 'service', 'services',
    'contact', 'admin', 'administrator', 'hello', 'hi', 'hey', 'team', 'sales', 'press', 'media', 'careers', 'jobs',
    'hr', 'recruiting', 'office', 'frontdesk', 'desk', 'reception', 'webmaster', 'postmaster', 'hostmaster', 'abuse',
    'members', 'member', 'membership', 'feedback', 'store', 'shop', 'mail', 'mailer', 'email', 'system', 'root',
    'daemon', 'auto', 'automated', 'automailer', 'bounce', 'bounces', 'reply', 'ops', 'operations', 'enquiries',
    'inquiries', 'general', 'accounting', 'finance', 'orders',
  ],
};

/** The bucket a category files to, in the order a local part's categories are consulted. */
export const CATEGORY_ORDER: readonly SenderCategory[] = ['receipt', 'update', 'notification', 'newsletter', 'role'];

const CATEGORY_OF = new Map<string, SenderCategory>();
for (const category of CATEGORY_ORDER) for (const word of VOCABULARY[category]) if (!CATEGORY_OF.has(word)) CATEGORY_OF.set(word, category);

/** Words that may sit between vocabulary words in a run-together local part ("myaccount",
 * "noreplyhuddle", "orderconfirm", "customerservice") but never make a match on their own. */
const FILLERS = new Set(['my', 'your', 'the', 'no', 'do', 'not', 'us', 'eu', 'uk', 'ca', 'au', 'de', 'fr', 'e', 'x', 'and']);

/** Local parts that mean "a machine sent this and nobody reads replies", separators and digits aside. */
const AUTOMATED_COMPACT = /(noreply|donotreply|dontreply|mailerdaemon)/;

/** Subdomain labels that are sending infrastructure rather than a department. */
const SENDING_LABELS = new Set([
  'mail', 'email', 'e', 'em', 'm', 'mg', 'mta', 'smtp', 'send', 'sender', 'txn', 'transactional', 't', 'msg',
  'messaging', 'comms', 'communications', 'bounce', 'bounces', 'reply', 'notify', 'mailer', 'post', 'go', 'links',
]);

/** Words in a display name that name an organisation or a function rather than a person. */
const ORGANISATION_WORDS = new Set([
  ...CATEGORY_OF.keys(),
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'gmbh', 'plc', 'group', 'holdings', 'hq', 'labs',
  'market', 'marketplace', 'store', 'shop', 'supply', 'supplies', 'goods', 'outfitters', 'studio', 'studios',
  'bank', 'credit', 'union', 'insurance', 'airlines', 'airways', 'air', 'hotel', 'hotels', 'clinic', 'health',
  'dental', 'pharmacy', 'utilities', 'energy', 'mobile', 'wireless', 'telecom', 'club', 'app', 'online',
  'official', 'direct', 'express', 'cloud', 'systems', 'software', 'foundation', 'university', 'college',
  'school', 'city', 'county', 'department', 'dept', 'desk', 'center', 'centre', 'services', 'solutions',
]);

/** Senders whose mail is a notification system's (code hosts, chat, monitoring, calendars). */
export const NOTIFIER_DOMAINS = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'linear.app', 'sentry.io', 'slack.com',
  'discord.com', 'calendar.google.com', 'pagerduty.com', 'statuspage.io', 'uptimerobot.com', 'vercel.com',
  'netlify.com', 'circleci.com', 'docker.com', 'trello.com', 'asana.com', 'notion.so', 'figma.com',
  'zoom.us', 'opsgenie.net', 'datadoghq.com', 'foreman.d3cloud.io', 'shipyard.d3cloud.io',
] as const;

/** Commerce, payment, carrier and account-system senders: their mail is transactional by default. */
const TRANSACTIONAL_DOMAINS = [
  'amazon.com', 'paypal.com', 'venmo.com', 'stripe.com', 'squareup.com', 'shopify.com', 'ebay.com', 'etsy.com',
  'apple.com', 'id.apple.com', 'accounts.google.com', 'uber.com', 'lyft.com', 'doordash.com', 'instacart.com',
  'ups.com', 'fedex.com', 'usps.com', 'dhl.com', 'intuit.com', 'chase.com', 'wellsfargo.com',
  'bankofamerica.com', 'americanexpress.com', 'capitalone.com', 'airbnb.com', 'booking.com', 'expedia.com',
] as const;

/** Two-label public suffixes, so "shop.example.co.uk"'s subdomain is "shop", not "example". */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'co.za']);

export const RECEIPT_SUBJECT =
  /\b(receipts?|invoices?|order (confirmation|confirmed|#|number|no\.?|placed|total)|order\s+\S*\d|purchase|payment\b[^.]{0,40}\b(received|confirm\w*|successful|processed|complete[d]?)|payment confirmation|you (paid|sent) |thanks for your (order|purchase|payment)|(we|we've|we have) (got|received) your (order|payment)|refund(ed)?|billing statement|subscription (renewed|renewal|confirmation)|has renewed)\b/i;

export const UPDATE_SUBJECT =
  /\b(password|security (alert|notice|code)|sign[- ]?in|log[- ]?in|new device|verify|verification|confirm your (email|account)|account (update|activity|change|balance)|2fa|two[- ]factor|one[- ]time (code|password)|shipped|shipping|shipment|out for delivery|delivered|delivery (scheduled|update|window)|tracking|your (package|parcel|shipment|delivery|ride|driver|trip|order status|booking|reservation|appointment|visit|itinerary|flight)|arriv(ing|es|ed)|minutes away|delayed|itinerary|terms of (service|use)|privacy policy|policy update|statement is ready|reset|expir(e|es|ing|ed)|unusual (activity|sign)|identity|low balance)\b/i;

export const NOTIFICATION_SUBJECT =
  /\b(mentioned you|mentions?|commented|new comments?|replied|new repl(y|ies)|assigned you|invited you|you['’]re invited|invitation|reminder|starts in|starting soon|build (#?\d+ )?(passed|failed|succeeded|completed)|pipeline (passed|failed|succeeded)|deploy(ment)? (to \S+ )?(finished|succeeded|failed|completed)|incident|alert (triggered|resolved)|\[(down|up|alert|firing|resolved)\]|is (down|not responding)|new (message|direct message|follower|responses?)|sent you a message|shared (a|an|the) \S+ with you|requested access|reacted|tagged you|pull request|merge request|ticket #?\d+|request #?\d+)\b/i;

const REPLY_OR_FORWARD = /^\s*(re|fwd?|aw|sv|antw)\s*(\[\d+\])?\s*:/i;

/** One cue that fired, with the points it carried and why. */
export interface SenderCue {
  readonly side: 'transactional' | 'personal';
  readonly points: number;
  readonly reason: string;
}

export interface SenderShape {
  readonly transactionalScore: number;
  readonly personalScore: number;
  readonly cues: readonly SenderCue[];
  /** True when transactional evidence is at least 2 and outweighs personal evidence. */
  readonly transactional: boolean;
}

export interface SenderShapeInput {
  /** The normalised (lowercased, +tag stripped) From address. */
  readonly address: string;
  readonly displayName: string;
  readonly subject: string;
  readonly threadReply: boolean;
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A local part's tokens: split on separators, digits dropped (so "verify2" is "verify"). */
export function localTokens(local: string): string[] {
  return local
    .toLowerCase()
    .split(/[._+\-=]+/)
    .map((t) => t.replace(/\d+/g, ''))
    .filter((t) => t.length > 0);
}

/** Split a run-together word into vocabulary words (and fillers), or null. At least one piece must be
 * a vocabulary word of 3+ letters, so fillers alone ("do", "no") and two-letter words ("hi", "ci")
 * never make a match out of an arbitrary name. */
function splitCompound(word: string): string[] | null {
  const n = word.length;
  const best: (string[] | null)[] = new Array<string[] | null>(n + 1).fill(null);
  best[0] = [];
  for (let end = 1; end <= n; end++) {
    for (let start = Math.max(0, end - 16); start < end; start++) {
      const prev = best[start];
      if (prev === null || prev === undefined) continue;
      const piece = word.slice(start, end);
      if (CATEGORY_OF.has(piece) || FILLERS.has(piece)) {
        best[end] = [...prev, piece];
        break;
      }
    }
  }
  const pieces = best[n];
  if (pieces === null || pieces === undefined) return null;
  return pieces.some((p) => CATEGORY_OF.has(p) && p.length >= 3) ? pieces : null;
}

/** The vocabulary words a local part (or a domain label) contains, in order. */
export function vocabularyWords(local: string): string[] {
  const words: string[] = [];
  for (const token of localTokens(local)) {
    if (CATEGORY_OF.has(token)) {
      words.push(token);
      continue;
    }
    const pieces = splitCompound(token);
    if (pieces !== null) for (const p of pieces) if (CATEGORY_OF.has(p)) words.push(p);
  }
  return words;
}

/** The first category (in CATEGORY_ORDER) that any of these words belongs to, or null. */
export function categoryOfWords(words: readonly string[]): SenderCategory | null {
  const found = new Set(words.map((w) => CATEGORY_OF.get(w)));
  for (const category of CATEGORY_ORDER) if (found.has(category)) return category;
  return null;
}

/** "noreply", "no_reply2", "do-not-reply", "noreply-huddle", "mailer-daemon" → the matched word. */
export function automatedLocalWord(local: string): string | null {
  const compact = local.toLowerCase().replace(/[^a-z]/g, '');
  const m = AUTOMATED_COMPACT.exec(compact);
  return m === null ? null : (m[1] ?? null);
}

export function domainIs(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** The labels to the left of the registrable domain ("alerts.uptimer.example.com" → alerts, uptimer). */
export function subdomainLabels(domain: string): string[] {
  const labels = domain.split('.').filter((l) => l.length > 0);
  const lastTwo = labels.slice(-2).join('.');
  const keep = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(0, Math.max(0, labels.length - keep));
}

/** A cue from a sending subdomain: its label and the category it implies (null for pure infrastructure). */
export function subdomainCue(domain: string): { label: string; category: SenderCategory | null } | null {
  for (const label of subdomainLabels(domain)) {
    const category = categoryOfWords(vocabularyWords(label));
    if (category !== null && category !== 'role') return { label, category };
    if (SENDING_LABELS.has(label) || category === 'role') return { label, category: null };
  }
  return null;
}

export function knownNotifierDomain(domain: string): string | null {
  return NOTIFIER_DOMAINS.find((d) => domainIs(domain, d)) ?? null;
}

function knownTransactionalDomain(domain: string): string | null {
  return knownNotifierDomain(domain) ?? TRANSACTIONAL_DOMAINS.find((d) => domainIs(domain, d)) ?? null;
}

/** Split a display name into its personal part and a trailing title/team ("Jane Chen (Support Lead)",
 * "Marco Rossi | Billing", "Lena Novak – Customer Success", "Grace Haddad, Security Engineer"). */
function splitDisplayName(display: string): { head: string; tail: string } {
  const cleaned = display.replace(/^["']+|["']+$/g, '').trim();
  const m = /\s*(\(|\||\s[-–—]\s|,|\s\bat\b\s|\s\bfrom\b\s|\s\bvia\b\s|@)/i.exec(cleaned);
  if (m === null || m.index === 0) return { head: cleaned, tail: '' };
  return { head: cleaned.slice(0, m.index).trim(), tail: cleaned.slice(m.index).trim() };
}

const NAME_WORD = /^(\p{Lu}[\p{Ll}\p{M}'’-]+|\p{Lu}\.?|(Mc|Mac|O['’])\p{Lu}[\p{Ll}\p{M}]+|(de|da|di|van|von|der|del|la|le|bin|ibn)|\p{Lu}[\p{Ll}\p{M}]+-\p{Lu}[\p{Ll}\p{M}]+)$/u;

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

/** "First Last": 2–4 name-shaped words, none of them an organisation/role word. */
function looksLikePersonalName(head: string): boolean {
  const ws = words(head);
  if (ws.length < 2 || ws.length > 4) return false;
  if (!ws.every((w) => NAME_WORD.test(w))) return false;
  return !ws.some((w) => ORGANISATION_WORDS.has(fold(w).replace(/[^a-z]/g, '')));
}

/** Organisation marks in a display name: a word from ORGANISATION_WORDS, "&"/"+", or digits. */
function organisationMark(display: string): string | null {
  if (/[&+]/.test(display)) return `"${/[&+]/.exec(display)?.[0] ?? '&'}"`;
  if (/\d/.test(display)) return 'digits';
  for (const w of words(display)) {
    const key = fold(w).replace(/[^a-z]/g, '');
    if (key.length > 0 && ORGANISATION_WORDS.has(key)) return `"${w.replace(/[^\p{L}\p{N}]/gu, '')}"`;
  }
  return null;
}

/** True when the local part is built from the display name's words: jane.doe, jdoe, janed, jane. */
function localBuiltFromName(localTokensList: readonly string[], local: string, head: string): string | null {
  const nameWords = words(head)
    .map((w) => fold(w).replace(/[^a-z]/g, ''))
    .filter((w) => w.length > 0 && !CATEGORY_OF.has(w));
  if (nameWords.length === 0) return null;
  const compact = local.toLowerCase().replace(/[^a-z]/g, '');
  for (const t of localTokensList) if (t.length >= 3 && nameWords.includes(t)) return t;
  const first = nameWords[0] ?? '';
  const last = nameWords[nameWords.length - 1] ?? '';
  if (nameWords.length >= 2 && first.length > 0 && last.length >= 2) {
    const shapes = [`${first}${last}`, `${first[0]}${last}`, `${first}${last[0]}`, `${last}${first}`, `${last}${first[0]}`];
    for (const s of shapes) if (compact === s) return compact;
  }
  return null;
}

/** Weigh transactional against personal evidence for one sender. Pure; every cue carries a reason. */
export function senderShape(input: SenderShapeInput): SenderShape {
  const cues: SenderCue[] = [];
  const at = input.address.lastIndexOf('@');
  const local = at < 0 ? input.address : input.address.slice(0, at);
  const domain = at < 0 ? '' : input.address.slice(at + 1);
  const tokens = localTokens(local);
  const display = input.displayName.trim();
  const { head } = splitDisplayName(display);
  const domainLabels = domain.split('.').filter((l) => l.length >= 3);

  // --- transactional, strong -----------------------------------------------------------------
  const localWords = vocabularyWords(local);
  if (localWords.length > 0) {
    const category = categoryOfWords(localWords) ?? 'role';
    cues.push({ side: 'transactional', points: 2, reason: `local part "${local}" is a ${category} mailbox ("${localWords.join('", "')}")` });
  }

  const known = knownTransactionalDomain(domain);
  if (known !== null) cues.push({ side: 'transactional', points: 2, reason: `sender domain ${domain} is a known transactional/notification sender (${known})` });

  const displayCompact = fold(display).replace(/[^a-z0-9]/g, '');
  const headIsPersonal = looksLikePersonalName(head);
  const displayIsDomain = displayCompact.length >= 3 && domainLabels.some((l) => l.replace(/[^a-z0-9]/g, '') === displayCompact);
  if (display !== '') {
    if (displayIsDomain) {
      cues.push({ side: 'transactional', points: 2, reason: `display name "${display}" is the sending domain's own name (organisation)` });
    } else if (!headIsPersonal) {
      const mark = organisationMark(display);
      const brandWord = words(display).find((w) => {
        const k = fold(w).replace(/[^a-z0-9]/g, '');
        return k.length >= 3 && domainLabels.some((l) => l === k);
      });
      if (mark !== null) cues.push({ side: 'transactional', points: 2, reason: `display name "${display}" names an organisation or function (${mark})` });
      else if (brandWord !== undefined) cues.push({ side: 'transactional', points: 2, reason: `display name "${display}" carries the sending domain's name ("${brandWord}")` });
    }
  }

  // --- transactional, weak -------------------------------------------------------------------
  const sub = subdomainCue(domain);
  if (sub !== null) cues.push({ side: 'transactional', points: 1, reason: `sent from a ${sub.category ?? 'mail-sending'} subdomain ("${sub.label}.")` });

  const subject = input.subject.trim();
  if (subject !== '' && !input.threadReply && !REPLY_OR_FORWARD.test(subject)) {
    const m = RECEIPT_SUBJECT.exec(subject) ?? UPDATE_SUBJECT.exec(subject) ?? NOTIFICATION_SUBJECT.exec(subject);
    if (m !== null) cues.push({ side: 'transactional', points: 1, reason: `subject reads as transactional ("${m[0]}")` });
  }

  // --- personal --------------------------------------------------------------------------------
  if (headIsPersonal) cues.push({ side: 'personal', points: 1, reason: `display name "${head}" reads as a personal name` });
  if (!displayIsDomain && head !== '') {
    const built = localBuiltFromName(tokens, local, head);
    if (built !== null) cues.push({ side: 'personal', points: 2, reason: `local part "${local}" is built from the display name ("${built}")` });
  }

  const transactionalScore = cues.filter((c) => c.side === 'transactional').reduce((s, c) => s + c.points, 0);
  const personalScore = cues.filter((c) => c.side === 'personal').reduce((s, c) => s + c.points, 0);
  return { transactionalScore, personalScore, cues, transactional: transactionalScore >= 2 && transactionalScore > personalScore };
}

/** "cue (+2); cue (+1)" for a reason string. */
export function describeCues(cues: readonly SenderCue[], side: SenderCue['side']): string {
  const own = cues.filter((c) => c.side === side);
  return own.length === 0 ? 'none' : own.map((c) => `${c.reason} (+${c.points})`).join('; ');
}
