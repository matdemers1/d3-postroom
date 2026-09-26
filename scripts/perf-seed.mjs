#!/usr/bin/env node
// PST-T-11.3 (PST-REQ-157): bulk-load a synthetic 50,000-message INBOX so the webmail's list and
// count queries can be measured against a mailbox the size the requirement names, without a real
// corpus. This is a dev/test tool, not an API mutation path: it writes directly with set-based SQL
// (INSERT ... SELECT generate_series), not one Prisma create per row, so 50k rows land in seconds
// rather than minutes — and, because it never goes through the API, it writes no audit_event rows
// on purpose (PST-REQ-009 covers API mutations; this is the same category as `prisma db seed`).
// Never point this at a database holding the real, private corpus.
//
// Usage:
//   node scripts/perf-seed.mjs --account operator [--count 50000] [--threads 15000] [--senders 2000] [--force]
//   DATABASE_URL=postgres://pst:pst@127.0.0.1:55433/postgres node scripts/perf-seed.mjs --account operator
//
// `--account` names an existing account's primary local part (login), the same string /signin
// takes. The account must already have an INBOX mailbox (every account does, from setup or seed).
// Refuses to run against a mailbox that already has more than 1000 messages unless `--force` is
// given, so a stray run cannot quietly balloon a real mailbox.
//
// Also exported for tests: `seedInbox(db, opts)` seeds directly against a Db handed to it (an
// already-migrated throwaway database), so an integration test does not have to shell out.
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createDb, normalizeLocalPart, SpecialUse } from '../packages/db/dist/index.js';

export const DEFAULT_COUNT = 50_000;
export const DEFAULT_THREADS = 15_000;
export const DEFAULT_SENDERS = 2_000;
/** Sorting buckets a message can land in (see SenderPin's doc comment in the schema). */
export const BUCKETS = ['priority', 'people', 'newsletters', 'updates', 'receipts', 'notifications', 'junk'];
/** Fixed, obviously-synthetic content hash — one blob row, shared by every seeded message. */
export const PERF_BLOB_SHA256 = 'a'.repeat(63) + '0';

function uuidArrayLiteral(ids) {
  return `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]::uuid[]`;
}

/**
 * Bulk-loads `opts.count` synthetic messages into `opts.mailboxId` (an INBOX belonging to
 * `opts.accountId`), spread over `opts.threadCount` threads, `opts.senderCount` senders and the
 * seven sorting buckets. Refuses if the mailbox already holds more than 1000 messages, unless
 * `opts.force`. Returns what it did, for the caller to log or assert against.
 */
export async function seedInbox(db, opts) {
  const accountId = opts.accountId;
  const mailboxId = opts.mailboxId;
  const count = opts.count ?? DEFAULT_COUNT;
  const threadCount = opts.threadCount ?? DEFAULT_THREADS;
  const senderCount = opts.senderCount ?? DEFAULT_SENDERS;
  const force = opts.force ?? false;

  const existing = await db.message.count({ where: { mailboxId } });
  if (existing > 1000 && !force) {
    throw new Error(`mailbox ${mailboxId} already has ${existing} messages; pass --force (or force: true) to seed anyway`);
  }

  const mailboxRows = await db.$queryRaw`SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailboxId}::uuid FOR UPDATE`;
  const mailbox = mailboxRows[0];
  if (mailbox === undefined) throw new Error(`mailbox ${mailboxId} not found`);
  const uidStart = mailbox.uidnext;
  const modseqStart = mailbox.highest_modseq;

  // One shared, obviously-synthetic blob. refcount tracks every message row pointing at it, same
  // invariant a real filed message keeps (PST-T-0.4's schema comment).
  const wrappedDek = randomBytes(48);
  const nonce = randomBytes(12);
  await db.$executeRaw`
    INSERT INTO blob (sha256, size, wrapped_dek, kek_id, aead, nonce, refcount)
    VALUES (${PERF_BLOB_SHA256}, 1024, ${wrappedDek}, 'perf-seed', 'aes-256-gcm', ${nonce}, ${count})
    ON CONFLICT (sha256) DO UPDATE SET refcount = blob.refcount + EXCLUDED.refcount`;

  // Threads: generated client-side as plain UUIDs (trusted, always well-formed) so the message
  // insert below can index into them with O(1) array access instead of a per-row subquery.
  const threadIds = Array.from({ length: threadCount }, () => randomUUID());
  const threadIdsSql = uuidArrayLiteral(threadIds);
  await db.$executeRawUnsafe(`
    INSERT INTO thread (id, account_id, subject, base_subject, last_message_at, message_count, created_at)
    SELECT t.id, '${accountId}'::uuid, 'Perf thread ' || t.ord, 'Perf thread ' || t.ord, now(), 0, now()
    FROM unnest(${threadIdsSql}) WITH ORDINALITY AS t(id, ord)`);

  const bucketsSql = `ARRAY[${BUCKETS.map((b) => `'${b}'`).join(',')}]::text[]`;

  await db.$executeRawUnsafe(`
    INSERT INTO message (id, mailbox_id, uid, modseq, blob_sha256, size, internal_date, received_at, flags, subject, from_address, sent_at, thread_id)
    SELECT gen_random_uuid(),
           '${mailboxId}'::uuid,
           ${uidStart} + g - 1,
           ${modseqStart} + g,
           '${PERF_BLOB_SHA256}',
           1024,
           now() - (g || ' seconds')::interval,
           now() - (g || ' seconds')::interval,
           CASE WHEN g % 5 = 0 THEN ARRAY[]::text[] ELSE ARRAY['\\Seen']::text[] END,
           'Perf message ' || g,
           'perf-sender-' || (g % ${senderCount}) || '@perf.example.test',
           now() - (g || ' seconds')::interval,
           (${threadIdsSql})[(g % ${threadCount}) + 1]
    FROM generate_series(1, ${count}) AS g`);

  // Verdicts, one per message, cycling the seven buckets — the per-mailbox bucket breakdown reads
  // this the same way an IMAP-filed message's classify stage would have written it.
  await db.$executeRawUnsafe(`
    INSERT INTO message_verdict (message_id, auth, attachments, bucket, reasons, scores, created_at)
    SELECT m.id, '{}'::jsonb, '[]'::jsonb, (${bucketsSql})[(row_number() OVER (ORDER BY m.uid) % array_length(${bucketsSql}, 1)) + 1], ARRAY[]::text[], '{}'::jsonb, now()
    FROM message m
    WHERE m.mailbox_id = '${mailboxId}'::uuid AND m.uid >= ${uidStart}
    ON CONFLICT (message_id) DO NOTHING`);

  await db.$executeRaw`
    UPDATE mailbox SET uidnext = ${uidStart + count}, highest_modseq = ${modseqStart + BigInt(count)} WHERE id = ${mailboxId}::uuid`;

  // message_count per thread, matching what the filing worker maintains incrementally.
  await db.$executeRawUnsafe(`
    UPDATE thread t SET message_count = c.n, last_message_at = c.last
    FROM (SELECT thread_id, count(*) AS n, max(sent_at) AS last FROM message WHERE thread_id = ANY(${threadIdsSql}) GROUP BY thread_id) c
    WHERE t.id = c.thread_id`);

  return { inserted: count, threadCount, senderCount, blobSha256: PERF_BLOB_SHA256, uidStart, modseqStart };
}

async function findAccountAndInbox(db, login) {
  const localPart = normalizeLocalPart(login);
  const address = await db.address.findFirst({
    where: { localPart, kind: 'primary', domain: { isPrimary: true } },
    include: { account: true },
  });
  if (address === null || address.account === null) throw new Error(`no primary account for login "${login}"`);
  const mailbox = await db.mailbox.findFirst({ where: { accountId: address.account.id, specialUse: SpecialUse.inbox } });
  if (mailbox === null) throw new Error(`account "${login}" has no INBOX mailbox`);
  return { accountId: address.account.id, mailboxId: mailbox.id };
}

async function main() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      count: { type: 'string', default: String(DEFAULT_COUNT) },
      threads: { type: 'string', default: String(DEFAULT_THREADS) },
      senders: { type: 'string', default: String(DEFAULT_SENDERS) },
      force: { type: 'boolean', default: false },
      'database-url': { type: 'string' },
    },
  });
  const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('set DATABASE_URL or pass --database-url');
  if (values.account === undefined) throw new Error('--account <login> is required');

  const db = createDb(databaseUrl);
  try {
    const { accountId, mailboxId } = await findAccountAndInbox(db, values.account);
    const start = Date.now();
    const result = await seedInbox(db, {
      accountId,
      mailboxId,
      count: Number(values.count),
      threadCount: Number(values.threads),
      senderCount: Number(values.senders),
      force: values.force,
    });
    const ms = Date.now() - start;
    console.log(`perf-seed: inserted ${result.inserted} messages into ${values.account}'s INBOX (${result.threadCount} threads, ${result.senderCount} senders) in ${ms}ms`);
  } finally {
    await db.$disconnect();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
