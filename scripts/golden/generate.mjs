#!/usr/bin/env node
// Deterministically generates the golden set for PST-T-5.5 / PST-REQ-107 into two DISJOINT splits:
//
//   fixtures/golden/tune/     — developers may look at these while changing heuristics. Reported,
//                               never gates CI.
//   fixtures/golden/holdout/  — a separate template pool: different senders, different domains,
//                               different subject wording, never a paraphrase of a `tune` entry.
//                               `fixtures/golden/thresholds.json` is recorded and enforced against
//                               THIS split only. See docs/runbooks/calibration.md for the rule that
//                               makes this split meaningful: heuristics are never edited while
//                               looking at a holdout failure, and holdout templates are regenerated
//                               only in a reviewed change, not to chase a passing number.
//
// Every bucket gets at least 15 distinct subject templates and 8 distinct sender identities/domains
// across the two splits combined (never fewer than that split between tune and holdout), varied
// header mixes (different ESPs, list software, notification systems, commerce/shipping/security
// flavours, human writing styles) — a handful of literal phrases is what let heuristics get tuned
// to fit the fixtures instead of the mail; this generator exists so that doesn't happen again.
//
// Every address is at example.com/.org/.net/.io (RFC 2606 reserved, plus .io conventionally used
// the same way for this kind of fixture) or a d3cloud.io test account (dana@d3cloud.io,
// sam@d3cloud.io) — none of this is real mail or a real person.
//
// Re-run any time this file changes (`node scripts/golden/generate.mjs`) — it overwrites its own
// output byte-for-byte given the same seed, so a diff in fixtures/golden/ after running it is
// either an intentional change to this script or a bug in it, never nondeterminism.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 20260926; // the day this generator was first written — change only with a reviewed diff

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One PRNG stream per split so that regenerating tune alone (impossible in practice, since this
// script always writes both, but conceptually) would never perturb holdout's sequence.
const rngTune = mulberry32(SEED);
const rngHoldout = mulberry32(SEED + 1);
function rngFor(split) {
  return split === 'tune' ? rngTune : rngHoldout;
}
function pick(arr, i) {
  return arr[i % arr.length];
}

const goldenRoot = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));

// ---------------------------------------------------------------------------------------------
// Human identity pools (priority/people). Disjoint end to end between tune and holdout: different
// first names, last names AND domains, so a holdout address can never coincide with a tune one.
// ---------------------------------------------------------------------------------------------
const HUMAN = {
  tune: {
    firstNames: ['Jane', 'Alex', 'Priya', 'Marco', 'Yuki', 'Sam', 'Lena', 'Omar', 'Grace', 'Noah'],
    lastNames: ['Doe', 'Chen', 'Patel', 'Rossi', 'Tanaka', 'Reyes', 'Novak', 'Haddad'],
    domains: ['example.com', 'example.org', 'mail.example.com'],
  },
  holdout: {
    firstNames: ['Ivy', 'Deshawn', 'Maria', 'Felix', 'Nadia', 'Owen', 'Rosa', 'Theo', 'Wren', 'Kian'],
    lastNames: ['Kim', 'Brooks', 'Silva', 'Okafor', 'Lund', 'Ortiz', 'Blake', 'Marsh'],
    domains: ['example.net', 'corp.example.org', 'people.example.net'],
  },
};

function personName(split, i) {
  const pool = HUMAN[split];
  const first = pick(pool.firstNames, i);
  const last = pick(pool.lastNames, Math.floor(i / pool.firstNames.length));
  return { first, last, full: `${first} ${last}` };
}

function personAddress(split, i) {
  const pool = HUMAN[split];
  const { first, last } = personName(split, i);
  const domain = pick(pool.domains, Math.floor(i / 5));
  return `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
}

const OWNERS = { tune: ['dana@d3cloud.io'], holdout: ['sam@d3cloud.io'] };

const AUTH_PASS = { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass' }, arc: { result: 'none' } };
const AUTH_FAIL = { spf: { result: 'fail' }, dkim: [{ result: 'fail' }], dmarc: { result: 'fail' }, arc: { result: 'none' } };
const AUTH_NONE = { spf: { result: 'none' }, dkim: [{ result: 'none' }], dmarc: { result: 'none' }, arc: { result: 'none' } };

// A shared, monotonic clock and Message-ID counter across both splits — only for uniqueness and
// plausibility, not something either split's classification depends on.
let dateCursor = Date.UTC(2026, 8, 1, 12, 0, 0);
function nextDate(split) {
  dateCursor += Math.floor(rngFor(split)() * (1000 * 60 * 170)) + 1000 * 60 * 5;
  return new Date(dateCursor).toUTCString().replace('GMT', '+0000');
}
let msgIdCounter = 0;
function nextMessageId(domain) {
  msgIdCounter += 1;
  return `<golden-${String(msgIdCounter).padStart(4, '0')}.${SEED}@${domain}>`;
}

function buildEml({ headers, body }) {
  const headerBlock = headers.filter((h) => h.value !== null && h.value !== undefined).map((h) => `${h.name}: ${h.value}`);
  return [...headerBlock, '', ...body.split('\n')].join('\r\n') + '\r\n';
}

function authResultsHeader(domain, verdicts) {
  const spf = verdicts.spf?.result ?? 'none';
  const dkim = verdicts.dkim?.[0]?.result ?? 'none';
  const dmarc = verdicts.dmarc?.result ?? 'none';
  return `mx.d3cloud.io; spf=${spf} smtp.mailfrom=${domain}; dkim=${dkim} header.d=${domain}; dmarc=${dmarc} header.from=${domain}`;
}

// One shared per-split file counter so tune-001.eml.../holdout-001.eml... stay stable and readable
// no matter which category writes them, without a global collision between splits (they land in
// different directories).
const fileCounters = { tune: 0, holdout: 0 };
function nextFile(split, prefix) {
  fileCounters[split] += 1;
  return `${prefix}-${String(fileCounters[split]).padStart(3, '0')}.eml`;
}

// Clear each split directory of stale .eml files BEFORE generating anything below — this must run
// first, not after, or it would delete the very files this run just wrote.
for (const split of ['tune', 'holdout']) {
  const dir = join(goldenRoot, split);
  mkdirSync(dir, { recursive: true });
  for (const existing of readdirSync(dir)) {
    if (existing.endsWith('.eml')) unlinkSync(join(dir, existing));
  }
}

const manifests = { tune: [], holdout: [] };

function addEntry(split, { prefix, expectedFinalBucket, tags, owner, headers, body, account, authVerdicts, envelopeFrom }) {
  const file = nextFile(split, prefix);
  writeFileSync(join(goldenRoot, split, file), buildEml({ headers, body }));
  manifests[split].push({ file, expectedFinalBucket, tags, owner, account, authVerdicts, envelopeFrom: envelopeFrom ?? null });
}

// =================================================================================================
// A. inbox-priority — human, known sender, addressed To, not bulk.
// 10 phrasings x 2 splits = 20 subject templates (>= 15); 40+ address combinations per split from
// the disjoint HUMAN pools (>= 8 identities).
// =================================================================================================
const PRIORITY_SUBJECTS = {
  tune: [
    'Re: project timeline',
    'Quick question about Saturday',
    'Notes from our call',
    'Following up',
    'Can you take a look?',
    'Thoughts on the draft?',
    "Let's grab coffee this week",
    'One more thing before EOD',
    'Re: budget numbers',
    'Sorry for the delay — here you go',
  ],
  holdout: [
    'About tomorrow’s handoff',
    'Circling back on this',
    'A small favor to ask',
    'Re: the client email',
    'Wanted your read on this',
    'Loose end from Tuesday',
    'Can we push the meeting?',
    'Attaching what we discussed',
    'Heads up before the review',
    'Re: onboarding checklist',
  ],
};
const PRIORITY_SUBTYPES = ['reply-graph', 'contact', 'vip-authenticated'];

for (const split of ['tune', 'holdout']) {
  const subjects = PRIORITY_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 20; i++) {
    const subtype = pick(PRIORITY_SUBTYPES, i);
    const { full } = personName(split, i);
    const from = personAddress(split, i);
    const subject = pick(subjects, i);
    const mobileSignoff = i % 3 === 0; // vary human writing style: a mobile signature block
    const account = {
      addresses: [owner],
      replyGraph: subtype === 'reply-graph' ? [from] : [],
      contacts: subtype === 'contact' ? [from] : [],
      pins: { vip: subtype === 'vip-authenticated' ? [from] : [], blocked: [] },
    };
    addEntry(split, {
      prefix: 'inbox-priority',
      expectedFinalBucket: 'inbox-priority',
      tags: [subtype],
      owner,
      account,
      authVerdicts: AUTH_PASS,
      envelopeFrom: from,
      headers: [
        { name: 'From', value: `${full} <${from}>` },
        { name: 'To', value: owner },
        { name: 'Subject', value: subject },
        { name: 'Date', value: nextDate(split) },
        { name: 'Message-ID', value: nextMessageId(from.split('@')[1]) },
        { name: 'Authentication-Results', value: authResultsHeader(from.split('@')[1], AUTH_PASS) },
      ],
      body: mobileSignoff ? `${subject}\n\n${full}\n\nSent from my phone` : `Hi,\n\n${subject}\n\nBest,\n${full}`,
    });
  }
}

// =================================================================================================
// B. inbox-people — human, but not "known" through Priority's channel, or known and not addressed
// directly. Same 10x2 subject template budget, three subtypes cycling per split.
// =================================================================================================
const PEOPLE_SUBJECTS = {
  tune: [
    'Nice to e-meet you',
    'Introduction from the conference',
    'Cc-ing you on this thread',
    'Loved your talk',
    'Reaching out about a collab',
    'Following up from the meetup',
    'Referred by a mutual friend',
    'Question about your recent post',
    'Would love to connect',
    'Saw your comment and wanted to reply',
  ],
  holdout: [
    'We met at the panel last week',
    'Cold email, sorry in advance',
    'Your name came up in conversation',
    'Interested in your work on this',
    'A quick intro before the call',
    'Adding you to this thread',
    'Reaching out cold — hope that’s okay',
    'Following up on the referral',
    'Wanted to say hi',
    'New here, hoping to connect',
  ],
};
const PEOPLE_SUBTYPES = ['first-time-human', 'cc-only', 'vip-spoof-dmarc-fail'];

for (const split of ['tune', 'holdout']) {
  const subjects = PEOPLE_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 20; i++) {
    const subtype = pick(PEOPLE_SUBTYPES, i);
    const { full } = personName(split, i + 100);
    const from = personAddress(split, i + 100);
    const subject = pick(subjects, i);

    let account;
    let headers;
    let authVerdicts = AUTH_PASS;
    let tags = [subtype];

    if (subtype === 'first-time-human') {
      account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
      headers = [
        { name: 'From', value: `${full} <${from}>` },
        { name: 'To', value: owner },
        { name: 'Subject', value: subject },
      ];
    } else if (subtype === 'cc-only') {
      account = { addresses: [owner], replyGraph: [from], contacts: [], pins: { vip: [], blocked: [] } };
      headers = [
        { name: 'From', value: `${full} <${from}>` },
        { name: 'To', value: `team-list@${split === 'tune' ? 'example.org' : 'example.net'}` },
        { name: 'Cc', value: owner },
        { name: 'Subject', value: subject },
      ];
    } else {
      account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [from], blocked: [] } };
      authVerdicts = AUTH_FAIL;
      tags = [subtype, 'dmarc-fail'];
      headers = [
        { name: 'From', value: `${full} <${from}>` },
        { name: 'To', value: owner },
        { name: 'Subject', value: `Urgent: ${subject}` },
      ];
    }

    headers.push(
      { name: 'Date', value: nextDate(split) },
      { name: 'Message-ID', value: nextMessageId(from.split('@')[1]) },
      { name: 'Authentication-Results', value: authResultsHeader(from.split('@')[1], authVerdicts) },
    );

    addEntry(split, {
      prefix: 'inbox-people',
      expectedFinalBucket: 'inbox-people',
      tags,
      owner,
      account,
      authVerdicts,
      envelopeFrom: from,
      headers,
      body: `Hello,\n\n${subject}\n\n${full}`,
    });
  }
}

// =================================================================================================
// Shared brand-pool helper for the five "Other" buckets: each bucket gets its own tune/holdout brand
// list (>= 5 each, 10+ total) and subject list (>= 10 each, 20+ total), so nothing here is a single
// literal phrase a heuristic could be special-cased against.
// =================================================================================================

// --- C. newsletters --------------------------------------------------------------------------
const NEWSLETTER_BRANDS = {
  tune: [
    { name: 'Weekly Signal', domain: 'weeklysignal.example.com', local: 'newsletter' },
    { name: 'The Long Read', domain: 'thelongread.example.org', local: 'digest' },
    { name: 'Founders Digest', domain: 'foundersdigest.example.com', local: 'newsletter' },
    { name: 'Kitchen Table', domain: 'kitchentable.example.net', local: 'editor' },
    { name: 'Trailhead Weekly', domain: 'trailhead.example.org', local: 'newsletter' },
  ],
  holdout: [
    { name: 'Notebook Weekly', domain: 'notebookweekly.example.net', local: 'digest' },
    { name: 'The Sunday Post', domain: 'sundaypost.example.org', local: 'editor' },
    { name: 'Field Notes', domain: 'fieldnotes.example.com', local: 'newsletter' },
    { name: 'Deep Dive', domain: 'deepdive.example.net', local: 'issue' },
    { name: 'The Commuter', domain: 'thecommuter.example.org', local: 'newsletter' },
  ],
};
const NEWSLETTER_SUBJECTS = {
  tune: [
    'This week: five things worth your time',
    'Issue #{n}',
    'What we read this week',
    'The Sunday edition',
    'Three ideas worth stealing',
    'Your weekly roundup',
    'This month in review',
    'Notes from the field',
    'A quieter kind of newsletter',
    'What we launched this week',
  ],
  holdout: [
    'The long version of the week',
    'Reading list #{n}',
    'A dispatch from the team',
    'Things we noticed this week',
    'Ten links, no ads',
    'The Tuesday roundup',
    'Small updates, worth a read',
    'What caught our eye',
    'This week’s field report',
    'Your recap for {n}',
  ],
};
// Different "list software" flavours across ESPs so the newsletter bucket does not converge on one
// header shape: Mailchimp-style CSV list-id, Substack-style hostname list-id, a generic compliance
// footer, and an ESP-fingerprint-only sender with no List-Id at all (still bulk, via Feedback-ID).
function newsletterHeaders(variant, brand) {
  const base = [{ name: 'From', value: `${brand.name} <${brand.local}@${brand.domain}>` }];
  if (variant === 0) {
    return [
      ...base,
      { name: 'List-Id', value: `${brand.name} <bulk.${brand.domain}>` },
      { name: 'List-Unsubscribe', value: `<https://${brand.domain}/unsubscribe>, <mailto:unsubscribe@${brand.domain}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
      { name: 'Precedence', value: 'bulk' },
    ];
  }
  if (variant === 1) {
    return [...base, { name: 'List-Id', value: `${brand.domain.split('.')[0]}.${brand.domain}` }, { name: 'List-Unsubscribe', value: `<https://${brand.domain}/unsubscribe>` }];
  }
  if (variant === 2) {
    return [...base, { name: 'Precedence', value: 'list' }, { name: 'List-Unsubscribe', value: `<mailto:leave@${brand.domain}>` }, { name: 'X-Mailgun-Variables', value: '{}' }];
  }
  // ESP-fingerprint-only: no List-Id/List-Unsubscribe at all — still bulk via the ESP header.
  return [...base, { name: 'X-SES-Outgoing', value: '2026.09.01-10.0.0.1' }, { name: 'Feedback-ID', value: `bulk:${brand.domain}:ses` }];
}

for (const split of ['tune', 'holdout']) {
  const brands = NEWSLETTER_BRANDS[split];
  const subjects = NEWSLETTER_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 13; i++) {
    const brand = pick(brands, i);
    const variant = i % 4;
    const subject = pick(subjects, i).replace('{n}', String(i + 1));
    const bulkFromContact = i === 0; // one edge case per split: a contact who also runs a list
    const account = {
      addresses: [owner],
      replyGraph: [],
      contacts: bulkFromContact ? [`${brand.local}@${brand.domain}`] : [],
      pins: { vip: [], blocked: [] },
    };
    const headers = newsletterHeaders(variant, brand);
    headers.push(
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'Date', value: nextDate(split) },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    );
    addEntry(split, {
      prefix: 'newsletters',
      expectedFinalBucket: 'newsletters',
      tags: bulkFromContact ? ['bulk-from-contact'] : ['newsletter', `list-software-${variant}`],
      owner,
      account,
      authVerdicts: AUTH_PASS,
      envelopeFrom: `bounce+${i}@${brand.domain}`,
      headers,
      body: `${subject}\n\nRead online: https://${brand.domain}/issues/${i + 1}`,
    });
  }
}

// --- D. updates: shipping, security/account and ride flavours ---------------------------------
const UPDATE_BRANDS = {
  tune: [
    { name: 'ParcelHop', domain: 'parcelhop.example.com', local: 'shipping', flavor: 'shipping' },
    { name: 'FreightWise', domain: 'freightwise.example.net', local: 'tracking', flavor: 'shipping' },
    { name: 'AccountGuard', domain: 'accountguard.example.org', local: 'security', flavor: 'security' },
    { name: 'RidePool', domain: 'ridepool.example.com', local: 'updates', flavor: 'ride' },
    { name: 'VaultKey', domain: 'vaultkey.example.net', local: 'account', flavor: 'security' },
  ],
  holdout: [
    { name: 'SwiftCourier', domain: 'swiftcourier.example.net', local: 'delivery', flavor: 'shipping' },
    { name: 'DashRoute', domain: 'dashroute.example.org', local: 'shipment', flavor: 'shipping' },
    { name: 'SecureLogin', domain: 'securelogin.example.com', local: 'verify', flavor: 'security' },
    { name: 'HailWay', domain: 'hailway.example.net', local: 'updates', flavor: 'ride' },
    { name: 'GuardPass', domain: 'guardpass.example.org', local: 'account', flavor: 'security' },
  ],
};
const UPDATE_SUBJECTS = {
  tune: {
    shipping: ['Your package is out for delivery', 'Delivery scheduled for tomorrow', 'Tracking update: your shipment has left the facility', 'Your shipment is on its way'],
    security: ['New sign-in from Chrome on Windows', 'Your one-time code is 482913', 'Reset your password', "We noticed a new device sign-in"],
    ride: ['Your ride is 3 minutes away', 'Your driver has arrived', 'Your ride is ending soon'],
  },
  holdout: {
    shipping: ['Your delivery window is 2–4pm today', 'Shipment update: customs cleared', 'Out for delivery — arriving today', 'Your parcel has left our warehouse'],
    security: ['Confirm your email address to continue', 'Verify it’s really you', 'Account activity you should know about', 'Two-factor code: 719204'],
    ride: ['Your driver is arriving now', 'Trip started — track live', 'Your ride has been confirmed'],
  },
};

for (const split of ['tune', 'holdout']) {
  const brands = UPDATE_BRANDS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 13; i++) {
    const brand = pick(brands, i);
    const subjectsForFlavor = UPDATE_SUBJECTS[split][brand.flavor];
    const subject = pick(subjectsForFlavor, i);
    const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
    const useSubjectPath = i % 2 === 0; // alternate which signal actually carries the classification
    const local = useSubjectPath ? 'hello' : brand.local; // generic local part when the subject alone must carry it
    addEntry(split, {
      prefix: 'updates',
      expectedFinalBucket: 'updates',
      tags: ['update', brand.flavor, useSubjectPath ? 'subject-driven' : 'sender-driven'],
      owner,
      account,
      authVerdicts: AUTH_PASS,
      envelopeFrom: `${local}@${brand.domain}`,
      headers: [
        { name: 'From', value: `${brand.name} <${local}@${brand.domain}>` },
        { name: 'To', value: owner },
        { name: 'Subject', value: subject },
        { name: 'Auto-Submitted', value: 'auto-generated' },
        { name: 'X-SES-Outgoing', value: `2026.09.${String((i % 28) + 1).padStart(2, '0')}-10.0.0.1` },
        { name: 'Date', value: nextDate(split) },
        { name: 'Message-ID', value: nextMessageId(brand.domain) },
        { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
      ],
      body: `${subject}\n\nMore detail: https://${brand.domain}/status/${1000 + i}`,
    });
  }
}

// --- E. receipts: commerce senders, varied ESPs -------------------------------------------------
const RECEIPT_BRANDS = {
  tune: [
    { name: 'Northbend Market', domain: 'northbendmarket.example.com', local: 'orders' },
    { name: 'Anchorline Books', domain: 'anchorline.example.org', local: 'receipts' },
    { name: 'Fernwood Coffee', domain: 'fernwood.example.net', local: 'billing' },
    { name: 'Pixel & Thread', domain: 'pixelthread.example.com', local: 'invoices' },
    { name: 'Harborlight Goods', domain: 'harborlight.example.org', local: 'payments' },
  ],
  holdout: [
    { name: 'Cedar & Vine', domain: 'cedarvine.example.net', local: 'orders' },
    { name: 'Millpond Supply', domain: 'millpond.example.org', local: 'billing' },
    { name: 'Stonecraft Studio', domain: 'stonecraft.example.com', local: 'receipts' },
    { name: 'Driftwood Market', domain: 'driftwood.example.net', local: 'purchases' },
    { name: 'Basalt & Co', domain: 'basaltco.example.org', local: 'invoices' },
  ],
};
const RECEIPT_SUBJECTS = {
  tune: [
    'Your receipt from {b}',
    'Order confirmed',
    'Payment received — thank you',
    'Your invoice is ready',
    'Thanks for your purchase',
    'Order #{n} confirmed',
    'Your subscription has renewed',
    'Refund processed',
    'Billing statement available',
    'Purchase confirmation',
  ],
  holdout: [
    'Payment successful',
    'You paid ${n}.00 to {b}',
    'Your order is confirmed',
    'Receipt for your recent purchase',
    'Thanks for shopping with {b}',
    'Your invoice #{n} is attached',
    'Subscription renewal confirmation',
    'We’ve processed your refund',
    'Your statement is ready to view',
    'Order confirmation #{n}',
  ],
};

for (const split of ['tune', 'holdout']) {
  const brands = RECEIPT_BRANDS[split];
  const subjects = RECEIPT_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 13; i++) {
    const brand = pick(brands, i);
    const subject = pick(subjects, i).replace('{b}', brand.name).replace('{n}', String(1000 + i));
    const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
    // Rotate ESP fingerprints so receipts is not tied to one sender platform.
    const espHeader =
      i % 3 === 0
        ? { name: 'X-SG-EID', value: `sg-eid-${1000 + i}` }
        : i % 3 === 1
          ? { name: 'X-MC-User', value: `mandrill-${1000 + i}` }
          : { name: 'X-SES-Outgoing', value: `2026.09.${String((i % 28) + 1).padStart(2, '0')}-10.0.0.1` };
    addEntry(split, {
      prefix: 'receipts',
      expectedFinalBucket: 'receipts',
      tags: ['receipt'],
      owner,
      account,
      authVerdicts: AUTH_PASS,
      envelopeFrom: `${brand.local}@${brand.domain}`,
      headers: [
        { name: 'From', value: `${brand.name} <${brand.local}@${brand.domain}>` },
        { name: 'To', value: owner },
        { name: 'Subject', value: subject },
        espHeader,
        { name: 'Feedback-ID', value: `receipt:${brand.domain}:esp` },
        { name: 'Date', value: nextDate(split) },
        { name: 'Message-ID', value: nextMessageId(brand.domain) },
        { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
      ],
      body: `${subject}\n\nOrder total: $${(19.99 + i).toFixed(2)}`,
    });
  }
}

// --- F. notifications: chat/PM/monitoring/calendar flavours ------------------------------------
const NOTIFICATION_BRANDS = {
  tune: [
    { name: 'Boardline', domain: 'boardline.example.com', local: 'notifications' },
    { name: 'Chatterframe', domain: 'chatterframe.example.org', local: 'alerts' },
    { name: 'Pingset', domain: 'pingset.example.net', local: 'notifications' },
    { name: 'Loopcast', domain: 'loopcast.example.com', local: 'calendar' },
    { name: 'Buildwatch', domain: 'buildwatch.example.org', local: 'ci' },
  ],
  holdout: [
    { name: 'Statusline', domain: 'statusline.example.net', local: 'status' },
    { name: 'Remindly', domain: 'remindly.example.org', local: 'calendar-notification' },
    { name: 'Deskbell', domain: 'deskbell.example.com', local: 'notifications' },
    { name: 'Watchtower', domain: 'watchtower.example.net', local: 'monitoring' },
    { name: 'Threadline', domain: 'threadline.example.org', local: 'alerts' },
  ],
};
const NOTIFICATION_SUBJECTS = {
  tune: [
    'You have a new mention',
    '3 people commented on your post',
    'Someone replied to you',
    'New activity on your board',
    'Your build passed',
    'Incident resolved: API latency',
    'New comment on your pull request',
    'You were mentioned in #general',
    'Weekly digest: what you missed',
    'Reminder: meeting starts in 15 minutes',
  ],
  holdout: [
    'Someone requested access',
    'Your report is ready',
    'New reply in your thread',
    'A teammate tagged you',
    'Your deploy finished',
    'Monitor alert: response time elevated',
    'Event starting soon',
    'You have 2 unread mentions',
    'Status changed on your ticket',
    'Someone reacted to your message',
  ],
};
// A couple of entries per split lean on the literal notification-system headers a few real tools
// send (GitHub, GitLab, Sentry, Google Calendar) instead of the local-part heuristic, so that
// pathway is covered by more than one signal shape too.
const NOTIFIER_SYSTEM_HEADERS = ['X-GitHub-Reason', 'X-Gitlab-Project', 'X-Sentry-Project', 'X-Google-Calendar-Event'];

for (const split of ['tune', 'holdout']) {
  const brands = NOTIFICATION_BRANDS[split];
  const subjects = NOTIFICATION_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 13; i++) {
    const brand = pick(brands, i);
    const subject = pick(subjects, i);
    const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
    const useSystemHeader = i % 5 === 0;
    const headers = [{ name: 'From', value: `${brand.name} <${brand.local}@${brand.domain}>` }, { name: 'To', value: owner }, { name: 'Subject', value: subject }];
    // Every notification-system message is bulk/automated in the real world too (GitHub's own
    // notification mail carries List-Id/List-Unsubscribe alongside X-GitHub-Reason) — without a
    // bulk marker a message with only a display name and no other signal reads as an ordinary
    // human sender to the rule pass, and never reaches the notifications heuristic at all.
    headers.push({ name: 'List-Unsubscribe', value: `<https://${brand.domain}/notifications/unsubscribe>` });
    if (useSystemHeader) headers.push({ name: pick(NOTIFIER_SYSTEM_HEADERS, i), value: 'mention' });
    headers.push(
      { name: 'Date', value: nextDate(split) },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    );
    addEntry(split, {
      prefix: 'notifications',
      expectedFinalBucket: 'notifications',
      tags: useSystemHeader ? ['notification', 'system-header'] : ['notification', 'local-part'],
      owner,
      account,
      authVerdicts: AUTH_PASS,
      envelopeFrom: `${brand.local}@${brand.domain}`,
      headers,
      body: `${subject}\n\nOpen ${brand.name}: https://${brand.domain}/open`,
    });
  }
}

// --- G. junk: blocked pin, or Precedence: junk from an unauthenticated sender --------------------
const JUNK_BRANDS = {
  tune: [
    { name: 'MegaSavings Now', domain: 'megasavingsnow.example.com' },
    { name: 'Prize Alert', domain: 'prizealert.example.net' },
    { name: 'CryptoBoost', domain: 'cryptoboost.example.org' },
    { name: 'Golden Ticket Offers', domain: 'goldenticket.example.com' },
    { name: 'ClearanceBlast', domain: 'clearanceblast.example.net' },
  ],
  holdout: [
    { name: 'Discount Vault', domain: 'discountvault.example.net' },
    { name: 'Lucky Winner Club', domain: 'luckywinner.example.org' },
    { name: 'FastCash Offers', domain: 'fastcashoffers.example.com' },
    { name: 'Bonus Reward Hub', domain: 'bonusrewardhub.example.net' },
    { name: 'InstantSavings Plus', domain: 'instantsavingsplus.example.org' },
  ],
};
const JUNK_SUBJECTS = {
  tune: [
    'You WON! Click to claim',
    'Limited time: 90% off everything',
    "Don't miss this once-in-a-lifetime offer",
    'Your account needs verification',
    'Act now before it’s gone',
    'You’ve been selected for a reward',
    'Urgent: your prize expires today',
    'Claim your free gift now',
    'Everything must go — today only',
    'You are pre-approved',
  ],
  holdout: [
    'Final notice: claim your prize',
    'Exclusive deal just for you',
    'This offer expires tonight',
    'Confirm your details to continue',
    'Congratulations — you qualify',
    'One click to unlock your gift',
    'Your reward is waiting',
    'Don’t wait — offer ends soon',
    'You have been chosen',
    'Verify now to unlock savings',
  ],
};

for (const split of ['tune', 'holdout']) {
  const brands = JUNK_BRANDS[split];
  const subjects = JUNK_SUBJECTS[split];
  const owner = OWNERS[split][0];
  for (let i = 0; i < 10; i++) {
    const brand = pick(brands, i);
    const from = `deals@${brand.domain}`;
    const blocked = i % 2 === 0;
    const subject = pick(subjects, i);
    const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: blocked ? [from] : [] } };
    const headers = [
      { name: 'From', value: `${brand.name} <${from}>` },
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'Date', value: nextDate(split) },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_NONE) },
    ];
    if (!blocked) headers.push({ name: 'Precedence', value: 'junk' });
    addEntry(split, {
      prefix: 'junk',
      expectedFinalBucket: 'junk',
      tags: blocked ? ['blocked-pin'] : ['precedence-junk-unauthenticated'],
      owner,
      account,
      authVerdicts: AUTH_NONE,
      envelopeFrom: from,
      headers,
      body: `${subject}\n\nClick here: https://${brand.domain}/claim`,
    });
  }
}

// =================================================================================================
// Write output: one manifest.json per split.
// =================================================================================================
for (const split of ['tune', 'holdout']) {
  writeFileSync(
    join(goldenRoot, split, 'manifest.json'),
    JSON.stringify({ seed: SEED, split, generatedBy: 'scripts/golden/generate.mjs', entries: manifests[split] }, null, 2) + '\n',
  );
}

console.log(`golden generate: wrote ${manifests.tune.length} tune + ${manifests.holdout.length} holdout message(s)`);
