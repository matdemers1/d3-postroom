#!/usr/bin/env node
// Deterministically generates the ~200-message synthetic golden set for PST-T-5.5 / PST-REQ-107
// into fixtures/golden/*.eml plus fixtures/golden/manifest.json. Re-run any time this file changes
// (`node scripts/golden/generate.mjs`) — it overwrites its own output byte-for-byte given the same
// seed, so a diff in fixtures/golden/ after running it is either an intentional change to this
// script or a bug in it, never nondeterminism.
//
// Every address is at example.com/.org/.net (RFC 2606 reserved) or a d3cloud.io test account
// (dana@d3cloud.io, sam@d3cloud.io) — none of this is real mail or a real person (PST-REQ-108's
// companion rule: only *synthetic* fixtures are ever committed).
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 20260926; // the day this generator was written — change only alongside a reviewed diff

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

const rng = mulberry32(SEED);
function pick(arr, i) {
  return arr[i % arr.length];
}

const goldenDir = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));

const FIRST_NAMES = ['Jane', 'Alex', 'Priya', 'Marco', 'Yuki', 'Sam', 'Lena', 'Omar', 'Grace', 'Noah', 'Ivy', 'Deshawn', 'Maria', 'Felix', 'Nadia', 'Owen', 'Rosa', 'Theo', 'Wren', 'Kian'];
const LAST_NAMES = ['Doe', 'Chen', 'Patel', 'Rossi', 'Tanaka', 'Reyes', 'Novak', 'Haddad', 'Kim', 'Brooks', 'Silva', 'Okafor', 'Lund', 'Ortiz', 'Blake'];
const PERSON_DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example.com'];
const OWNERS = ['dana@d3cloud.io', 'sam@d3cloud.io'];

const NEWSLETTER_BRANDS = [
  { name: 'Weekly Signal', domain: 'weeklysignal.example.com' },
  { name: 'The Long Read', domain: 'thelongread.example.org' },
  { name: 'Founders Digest', domain: 'foundersdigest.example.com' },
  { name: 'Kitchen Table', domain: 'kitchentable.example.net' },
  { name: 'Trailhead Weekly', domain: 'trailhead.example.org' },
];

const UPDATE_BRANDS = [
  { name: 'ParcelHop', domain: 'parcelhop.example.com' },
  { name: 'FreightWise', domain: 'freightwise.example.net' },
  { name: 'CloudBoard CI', domain: 'cloudboard.example.org' },
  { name: 'RidePool', domain: 'ridepool.example.com' },
];

const RECEIPT_BRANDS = [
  { name: 'Northbend Market', domain: 'northbendmarket.example.com' },
  { name: 'Anchorline Books', domain: 'anchorline.example.org' },
  { name: 'Fernwood Coffee', domain: 'fernwood.example.net' },
  { name: 'Pixel & Thread', domain: 'pixelthread.example.com' },
];

const NOTIFICATION_BRANDS = [
  { name: 'Boardline', domain: 'boardline.example.com' },
  { name: 'Chatterframe', domain: 'chatterframe.example.org' },
  { name: 'Pingset', domain: 'pingset.example.net' },
  { name: 'Loopcast', domain: 'loopcast.example.com' },
];

const JUNK_BRANDS = [
  { name: 'MegaSavings Now', domain: 'megasavingsnow.example.com' },
  { name: 'Prize Alert', domain: 'prizealert.example.net' },
  { name: 'CryptoBoost', domain: 'cryptoboost.example.org' },
];

const AUTH_PASS = { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass' }, arc: { result: 'none' } };
const AUTH_FAIL = { spf: { result: 'fail' }, dkim: [{ result: 'fail' }], dmarc: { result: 'fail' }, arc: { result: 'none' } };
const AUTH_NONE = { spf: { result: 'none' }, dkim: [{ result: 'none' }], dmarc: { result: 'none' }, arc: { result: 'none' } };

let dateCursor = Date.UTC(2026, 8, 1, 12, 0, 0);
function nextDate() {
  // A seeded-random stride (5 minutes to just under 3 hours) instead of a fixed one, so the
  // generated Date headers look like a real mailbox's arrival times rather than a metronome —
  // still perfectly deterministic given SEED.
  dateCursor += Math.floor(rng() * (1000 * 60 * 170)) + 1000 * 60 * 5;
  return new Date(dateCursor).toUTCString().replace('GMT', '+0000');
}

let msgIdCounter = 0;
function nextMessageId(domain) {
  msgIdCounter += 1;
  return `<golden-${String(msgIdCounter).padStart(4, '0')}.${SEED}@${domain}>`;
}

function crlf(lines) {
  return lines.join('\r\n');
}

function buildEml({ headers, body }) {
  const headerBlock = headers
    .filter((h) => h.value !== null && h.value !== undefined)
    .map((h) => `${h.name}: ${h.value}`);
  return crlf([...headerBlock, '', ...body.split('\n')]) + '\r\n';
}

function authResultsHeader(domain, verdicts) {
  const spf = verdicts.spf?.result ?? 'none';
  const dkim = verdicts.dkim?.[0]?.result ?? 'none';
  const dmarc = verdicts.dmarc?.result ?? 'none';
  return `mx.d3cloud.io; spf=${spf} smtp.mailfrom=${domain}; dkim=${dkim} header.d=${domain}; dmarc=${dmarc} header.from=${domain}`;
}

mkdirSync(goldenDir, { recursive: true });
for (const existing of readdirSync(goldenDir)) {
  if (existing.endsWith('.eml')) unlinkSync(join(goldenDir, existing));
}

const entries = [];
let fileCounter = 0;
function nextFile(prefix) {
  fileCounter += 1;
  return `${prefix}-${String(fileCounter).padStart(3, '0')}.eml`;
}

function personName(i) {
  const first = pick(FIRST_NAMES, i);
  const last = pick(LAST_NAMES, Math.floor(i / FIRST_NAMES.length));
  return { first, last, full: `${first} ${last}` };
}

// FIRST_NAMES x LAST_NAMES gives 300 combinations, well above the largest per-category loop count
// (140), so `personName(i)` alone is enough to keep every generated address unique.
function personAddress(i) {
  const { first, last } = personName(i);
  const domain = pick(PERSON_DOMAINS, Math.floor(i / 7));
  return `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
}

function addEntry({ prefix, expectedRuleBucket, expectedFinalBucket, tags, owner, headers, body, account, authVerdicts, envelopeFrom }) {
  const file = nextFile(prefix);
  const eml = buildEml({ headers, body });
  writeFileSync(join(goldenDir, file), eml);
  entries.push({
    file,
    expectedRuleBucket,
    expectedFinalBucket,
    tags,
    owner,
    account,
    authVerdicts,
    envelopeFrom: envelopeFrom ?? null,
  });
}

// --- A. inbox-priority (40): human, known sender, addressed To, not bulk -------------------------
const PRIORITY_SUBTYPES = ['reply-graph', 'contact', 'vip-authenticated'];
for (let i = 0; i < 40; i++) {
  const owner = pick(OWNERS, i);
  const subtype = pick(PRIORITY_SUBTYPES, i);
  const { full } = personName(i);
  const from = personAddress(i);
  const subject = pick(
    ['Re: project timeline', 'Quick question about Saturday', 'Notes from our call', 'Following up', 'Can you take a look?'],
    i,
  );
  const account = {
    addresses: [owner],
    replyGraph: subtype === 'reply-graph' ? [from] : [],
    contacts: subtype === 'contact' ? [from] : [],
    pins: { vip: subtype === 'vip-authenticated' ? [from] : [], blocked: [] },
  };
  addEntry({
    prefix: 'inbox-priority',
    expectedRuleBucket: 'priority',
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
      { name: 'Date', value: nextDate() },
      { name: 'Message-ID', value: nextMessageId(from.split('@')[1]) },
      { name: 'Authentication-Results', value: authResultsHeader(from.split('@')[1], AUTH_PASS) },
    ],
    body: `Hi,\n\n${subject}\n\n${full}`,
  });
}

// --- B. inbox-people (40): human, but not "known" through Priority's channel, or known but not
// addressed directly ------------------------------------------------------------------------------
const PEOPLE_SUBTYPES = ['first-time-human', 'cc-only', 'vip-spoof-dmarc-fail'];
for (let i = 0; i < 40; i++) {
  const owner = pick(OWNERS, i + 1);
  const subtype = pick(PEOPLE_SUBTYPES, i);
  const { full } = personName(i + 100);
  const from = personAddress(i + 100);
  const subject = pick(
    ['Nice to e-meet you', 'Introduction from the conference', 'Cc-ing you on this thread', 'Loved your talk', 'Reaching out about a collab'],
    i,
  );

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
      { name: 'To', value: 'team-list@example.org' },
      { name: 'Cc', value: owner },
      { name: 'Subject', value: subject },
    ];
  } else {
    // vip-spoof-dmarc-fail: the sender is pinned VIP, but DMARC failed — the pin must not count.
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
    { name: 'Date', value: nextDate() },
    { name: 'Message-ID', value: nextMessageId(from.split('@')[1]) },
    { name: 'Authentication-Results', value: authResultsHeader(from.split('@')[1], authVerdicts) },
  );

  addEntry({
    prefix: 'inbox-people',
    expectedRuleBucket: 'people',
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

// --- C. newsletters (25): bulk via List-Id, not human -----------------------------------------
for (let i = 0; i < 25; i++) {
  const owner = pick(OWNERS, i);
  const brand = pick(NEWSLETTER_BRANDS, i);
  const from = `newsletter@${brand.domain}`;
  const subject = pick(
    ['This week: five things worth your time', 'Issue #{n}', 'What we read this week', 'The Sunday edition'],
    i,
  ).replace('{n}', String(i + 1));
  const bulkFromContact = i === 0; // one edge case: a contact who also runs a mailing list
  const account = {
    addresses: [owner],
    replyGraph: [],
    contacts: bulkFromContact ? [from] : [],
    pins: { vip: [], blocked: [] },
  };
  addEntry({
    prefix: 'newsletters',
    expectedRuleBucket: 'other',
    expectedFinalBucket: 'newsletters',
    tags: bulkFromContact ? ['bulk-from-contact'] : ['newsletter'],
    owner,
    account,
    authVerdicts: AUTH_PASS,
    envelopeFrom: `bounce+${i}@${brand.domain}`,
    headers: [
      { name: 'From', value: `${brand.name} <${from}>` },
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'List-Id', value: `${brand.name} <newsletter.${brand.domain}>` },
      { name: 'List-Unsubscribe', value: `<https://${brand.domain}/unsubscribe>` },
      { name: 'Precedence', value: 'bulk' },
      { name: 'Date', value: nextDate() },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    ],
    body: `${subject}\n\nRead online: https://${brand.domain}/issues/${i + 1}`,
  });
}

// --- D. updates (25): automated transactional status/shipping updates --------------------------
for (let i = 0; i < 25; i++) {
  const owner = pick(OWNERS, i + 1);
  const brand = pick(UPDATE_BRANDS, i);
  const from = `updates@${brand.domain}`;
  const subject = pick(
    ['Your package is out for delivery', 'Build #{n} passed', 'Your ride is 3 minutes away', 'Delivery scheduled for tomorrow'],
    i,
  ).replace('{n}', String(100 + i));
  const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
  addEntry({
    prefix: 'updates',
    expectedRuleBucket: 'other',
    expectedFinalBucket: 'updates',
    tags: ['update', i % 5 === 0 ? 'noreply' : 'automated'],
    owner,
    account,
    authVerdicts: AUTH_PASS,
    envelopeFrom: from,
    headers: [
      { name: 'From', value: `${brand.name} <${i % 5 === 0 ? `no-reply@${brand.domain}` : from}>` },
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'Auto-Submitted', value: 'auto-generated' },
      { name: 'X-SES-Outgoing', value: `2026.09.${String((i % 28) + 1).padStart(2, '0')}-10.0.0.1` },
      { name: 'Date', value: nextDate() },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    ],
    body: `${subject}\n\nTrack it: https://${brand.domain}/track/${1000 + i}`,
  });
}

// --- E. receipts (25): automated order/payment receipts ----------------------------------------
for (let i = 0; i < 25; i++) {
  const owner = pick(OWNERS, i);
  const brand = pick(RECEIPT_BRANDS, i);
  const from = `orders@${brand.domain}`;
  const subject = pick(
    ['Your receipt from {b}', 'Order confirmed', 'Payment received — thank you', 'Your invoice is ready'],
    i,
  ).replace('{b}', brand.name);
  const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
  addEntry({
    prefix: 'receipts',
    expectedRuleBucket: 'other',
    expectedFinalBucket: 'receipts',
    tags: ['receipt'],
    owner,
    account,
    authVerdicts: AUTH_PASS,
    envelopeFrom: from,
    headers: [
      { name: 'From', value: `${brand.name} <${from}>` },
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'X-SG-EID', value: `sg-eid-${1000 + i}` },
      { name: 'Feedback-ID', value: `receipt:${brand.domain}:sendgrid` },
      { name: 'Date', value: nextDate() },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    ],
    body: `${subject}\n\nOrder total: $${(19.99 + i).toFixed(2)}`,
  });
}

// --- F. notifications (25): app/social notifications, automated by local-part -------------------
for (let i = 0; i < 25; i++) {
  const owner = pick(OWNERS, i + 1);
  const brand = pick(NOTIFICATION_BRANDS, i);
  const from = `notifications@${brand.domain}`;
  const subject = pick(
    ['You have a new mention', '3 people commented on your post', 'Someone replied to you', 'New activity on your board'],
    i,
  );
  const account = { addresses: [owner], replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } };
  addEntry({
    prefix: 'notifications',
    expectedRuleBucket: 'other',
    expectedFinalBucket: 'notifications',
    tags: ['notification'],
    owner,
    account,
    authVerdicts: AUTH_PASS,
    envelopeFrom: from,
    headers: [
      { name: 'From', value: `${brand.name} <${from}>` },
      { name: 'To', value: owner },
      { name: 'Subject', value: subject },
      { name: 'List-Unsubscribe', value: `<https://${brand.domain}/notifications/unsubscribe>` },
      { name: 'Date', value: nextDate() },
      { name: 'Message-ID', value: nextMessageId(brand.domain) },
      { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_PASS) },
    ],
    body: `${subject}\n\nOpen ${brand.name}: https://${brand.domain}/open`,
  });
}

// --- G. junk (20): blocked pin, or bulk marketing spam -------------------------------------------
for (let i = 0; i < 20; i++) {
  const owner = pick(OWNERS, i);
  const brand = pick(JUNK_BRANDS, i);
  const from = `deals@${brand.domain}`;
  const blocked = i % 2 === 0;
  const subject = pick(
    ['You WON! Click to claim', 'Limited time: 90% off everything', "Don't miss this once-in-a-lifetime offer", 'Your account needs verification'],
    i,
  );
  const account = {
    addresses: [owner],
    replyGraph: [],
    contacts: [],
    pins: { vip: [], blocked: blocked ? [from] : [] },
  };
  const headers = [
    { name: 'From', value: `${brand.name} <${from}>` },
    { name: 'To', value: owner },
    { name: 'Subject', value: subject },
    { name: 'Date', value: nextDate() },
    { name: 'Message-ID', value: nextMessageId(brand.domain) },
    { name: 'Authentication-Results', value: authResultsHeader(brand.domain, AUTH_NONE) },
  ];
  if (!blocked) headers.push({ name: 'Precedence', value: 'junk' });
  addEntry({
    prefix: 'junk',
    expectedRuleBucket: 'other',
    expectedFinalBucket: 'junk',
    tags: blocked ? ['blocked-pin'] : ['bulk-junk'],
    owner,
    account,
    authVerdicts: AUTH_NONE,
    envelopeFrom: from,
    headers,
    body: `${subject}\n\nClick here: https://${brand.domain}/claim`,
  });
}

// --- write manifest ----------------------------------------------------------------------------
rmSync(join(goldenDir, '.gitkeep'), { force: true });
writeFileSync(join(goldenDir, '.gitkeep'), '');

writeFileSync(join(goldenDir, 'manifest.json'), JSON.stringify({ seed: SEED, generatedBy: 'scripts/golden/generate.mjs', entries }, null, 2) + '\n');

console.log(`golden generate: wrote ${entries.length} messages to fixtures/golden/`);
