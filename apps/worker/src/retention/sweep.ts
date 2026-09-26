// The retention sweep (PST-T-7.7, PST-REQ-129, PST-REQ-130).
//
// Four passes, each in bounded batches, each batch one transaction, each safe to run twice:
//
//  1. Move to Trash. For every mailbox that is neither Trash nor Rejects and has a policy (Junk by
//     default, see policy.ts), messages RECEIVED more than `days` ago move to the account's Trash.
//     received_at, not internal_date: internal_date is whatever an IMAP APPEND said it was, so it
//     can be years old for a message filed a minute ago; received_at is when this server took it.
//     The move is the IMAP MOVE of apps/imap/src/store.ts — the row is re-homed (new UID from the
//     target's uidnext, one new modseq for both mailboxes), the source gets an expunged_message row
//     per UID (QRESYNC VANISHED), both mailboxes are pg_notify'd (IDLE, webmail SSE) — and the row's
//     trashed_at is stamped with the sweep's clock. The blob reference moves with the row.
//     An account with no Trash mailbox is skipped (logged): never delete instead.
//  2. Expire Trash. Messages whose trashed_at is more than `days` old are expunged — the IMAP
//     EXPUNGE semantics again (modseq bump, expunged_message, notify) and one reference released
//     per message through BlobStore.release, which deletes the blob row — the wrapped DEK — when it
//     was the last (the crypto-shred), in the same transaction. A Trash message with no trashed_at
//     (it cannot happen after the migration's trigger, but) gets one stamped now, never expunged.
//  3. Expire Rejects. The same, by received_at.
//     In 2 and 3, when a blob has no Message rows left, the spool rows (inbound_message) that still
//     hold their reference to it release it too, so the last reference really goes.
//  4. Release spool references of mail the user expunged themselves (IMAP \Deleted + EXPUNGE takes
//     the Message's reference but not the spool row's), after a grace period and only for spool
//     rows that were filed into at least one mailbox — never for mail no mailbox ever showed.
// Then files: every blob whose row went is unlinked after the commit (BlobStore.reap), and a
// BlobStore.gc() pass removes any file left behind by a crash between the two (unreadable
// ciphertext: its DEK is gone).
//
// Nothing is ever deleted outside Trash and Rejects. Every batch writes one audit row as SYSTEM
// (actor 'retention') with its counts.
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore, GcResult } from '@postroom/blobstore';
import { Prisma, type Db, type SpecialUse } from '@postroom/db';
import { DAY_MS, retentionAction, type RetentionAction } from './policy.js';

type Tx = Prisma.TransactionClient;

/** The channel IMAP IDLE sessions and the webmail's SSE listen on (apps/imap, apps/api). */
export const MAILBOX_CHANNEL = 'postroom_mailbox';
export const DEFAULT_BATCH = 200;
/** Batches per mailbox per pass, so one huge mailbox never starves the rest; the next run goes on. */
export const DEFAULT_MAX_BATCHES = 50;
/** A spool row's reference is only released this long after it was received (pass 4). */
export const DEFAULT_SPOOL_GRACE_MS = DAY_MS;

const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;
const ACTOR: Actor = { kind: 'system', label: 'retention' };

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface RetentionDeps {
  readonly db: Db;
  readonly blobs: Pick<BlobStore, 'release' | 'reap' | 'gc'>;
  readonly log?: Log;
  readonly now?: () => Date;
}

export interface RetentionOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly spoolGraceMs?: number;
  /** Passed to BlobStore.gc (files younger than this are left alone). */
  readonly gcOlderThanMs?: number;
  /** Skip the gc pass (tests that look at files in between). */
  readonly skipGc?: boolean;
}

export interface RetentionResult {
  /** Messages moved to Trash. */
  readonly moved: number;
  /** Messages expunged from Trash or Rejects. */
  readonly expunged: number;
  /** Spool-row references released. */
  readonly spoolReleased: number;
  /** Blobs whose last reference went: row (and wrapped DEK) deleted. */
  readonly shredded: number;
  /** Trash messages found with no clock and given one. */
  readonly clocked: number;
  /** Mailboxes skipped because their account has no Trash. */
  readonly noTrash: number;
  readonly gc: GcResult | null;
}

interface MailboxRow {
  id: string;
  account_id: string;
  name: string;
  special_use: SpecialUse | null;
  has_policy: boolean;
  days: number | null;
}

interface Counters {
  moved: number;
  expunged: number;
  spoolReleased: number;
  shredded: number;
  clocked: number;
  noTrash: number;
}

async function notifyMailbox(tx: Tx, mailboxId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${mailboxId})`;
}

async function recordExpunged(tx: Tx, mailboxId: string, uids: readonly number[], modseq: bigint): Promise<void> {
  if (uids.length === 0) return;
  await tx.expungedMessage.createMany({ data: uids.map((uid) => ({ mailboxId, uid, modseq })), skipDuplicates: true });
}

interface Locked {
  accountId: string;
  specialUse: SpecialUse | null;
  uidnext: number;
  highestModseq: bigint;
}

/** Lock mailboxes in id order (the IMAP store's order), so the sweep never deadlocks with a client. */
async function lockMailboxes(tx: Tx, ids: readonly string[]): Promise<Map<string, Locked>> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string; account_id: string; special_use: SpecialUse | null; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, account_id::text AS account_id, special_use, uidnext, highest_modseq FROM mailbox
    WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, { accountId: r.account_id, specialUse: r.special_use, uidnext: r.uidnext, highestModseq: r.highest_modseq }]));
}

export interface RetentionSweeper {
  (options?: RetentionOptions): Promise<RetentionResult>;
}

export function createRetentionSweeper(deps: RetentionDeps): RetentionSweeper {
  const { db, blobs } = deps;
  const log: Log = deps.log ?? ((): void => undefined);
  const clock = deps.now ?? ((): Date => new Date());

  /** One reference per sha (sorted, the blob-lock order); returns the shas whose row went. */
  const release = async (tx: Tx, shas: readonly string[]): Promise<string[]> => {
    const gone: string[] = [];
    for (const sha of [...shas].sort()) {
      const r = await blobs.release(sha, tx);
      if (r.refcount === 0) gone.push(sha);
    }
    return gone;
  };

  /**
   * After messages went: for each blob no Message row names any more, release the references still
   * held by finished spool rows. Returns [released spool rows, shas whose row went].
   */
  const releaseSpool = async (tx: Tx, shas: readonly string[], now: Date): Promise<[number, string[]]> => {
    let released = 0;
    const gone: string[] = [];
    for (const sha of [...new Set(shas)].sort()) {
      const still = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM message WHERE blob_sha256 = ${sha}`;
      if (Number(still[0]?.n ?? 0) > 0) continue;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE inbound_message SET blob_released_at = ${now}
        WHERE blob_sha256 = ${sha} AND blob_released_at IS NULL AND state IN ('filed', 'rejected')
        RETURNING id::text AS id`;
      // A blob row already gone (refcounts out of step) has nothing left to release or shred.
      const blob = await tx.blob.findUnique({ where: { sha256: sha }, select: { refcount: true } });
      if (blob === null) continue;
      for (let i = 0; i < rows.length; i++) {
        const r = await blobs.release(sha, tx);
        released++;
        if (r.refcount === 0) {
          gone.push(sha);
          break;
        }
      }
    }
    return [released, gone];
  };

  const reap = async (shas: readonly string[]): Promise<void> => {
    for (const sha of new Set(shas)) {
      try {
        await blobs.reap(sha);
      } catch (err) {
        // The row is gone, so the file is unreadable already; gc() removes it on a later pass.
        log('retention-reap-error', { sha256: sha, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  /** Pass 1, one batch. Returns messages moved (0 = done). */
  const moveBatch = async (mb: MailboxRow, action: RetentionAction, trashId: string, now: Date, batch: number): Promise<number> => {
    const cutoff = new Date(now.getTime() - action.days * DAY_MS);
    return db.$transaction(async (tx) => {
      const locked = await lockMailboxes(tx, [mb.id, trashId]);
      const source = locked.get(mb.id);
      const target = locked.get(trashId);
      if (source === undefined || target === undefined || target.specialUse !== 'trash' || source.specialUse === 'trash') return 0;
      const rows = await tx.$queryRaw<{ id: string; uid: number }[]>`
        SELECT id::text AS id, uid FROM message
        WHERE mailbox_id = ${mb.id}::uuid AND received_at < ${cutoff}
        ORDER BY uid LIMIT ${batch}`;
      if (rows.length === 0) return 0;
      const modseq = (target.highestModseq > source.highestModseq ? target.highestModseq : source.highestModseq) + 1n;
      let next = target.uidnext;
      for (const r of rows) {
        await tx.$executeRaw`
          UPDATE message AS m SET mailbox_id = ${trashId}::uuid, uid = ${next}, modseq = ${modseq}, trashed_at = ${now},
            inbound_message_id = CASE WHEN EXISTS (
              SELECT 1 FROM message o WHERE o.mailbox_id = ${trashId}::uuid AND o.inbound_message_id = m.inbound_message_id
            ) THEN NULL ELSE m.inbound_message_id END
          WHERE m.id = ${r.id}::uuid`;
        next++;
      }
      await tx.$executeRaw`UPDATE mailbox SET uidnext = ${next}, highest_modseq = ${modseq} WHERE id = ${trashId}::uuid`;
      await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${mb.id}::uuid`;
      const uids = rows.map((r) => r.uid);
      await recordExpunged(tx, mb.id, uids, modseq);
      await recordAudit(tx, {
        actor: ACTOR,
        action: 'retention.move-to-trash',
        entityType: 'mailbox',
        entityId: mb.id,
        after: { accountId: mb.account_id, mailbox: mb.name, trashMailboxId: trashId, count: rows.length, uids, days: action.days, receivedBefore: cutoff.toISOString() },
      });
      await notifyMailbox(tx, trashId);
      await notifyMailbox(tx, mb.id);
      return rows.length;
    }, TX_OPTIONS);
  };

  /** Passes 2 and 3, one batch. Returns messages expunged (0 = done). */
  const expireBatch = async (mb: MailboxRow, action: RetentionAction, now: Date, batch: number, c: Counters): Promise<number> => {
    const cutoff = new Date(now.getTime() - action.days * DAY_MS);
    const shredded: string[] = [];
    const n = await db.$transaction(async (tx) => {
      const locked = await lockMailboxes(tx, [mb.id]);
      const box = locked.get(mb.id);
      if (box === undefined) return 0;
      // The special use is re-read under the lock: only Trash and Rejects may ever expunge.
      if (!(action.kind === 'expire-trash' ? box.specialUse === 'trash' : action.kind === 'expire-rejects' && box.specialUse === 'rejects')) return 0;
      if (action.kind === 'expire-trash') {
        // Defensive: a Trash row with no clock gets one now, and is not expired on this pass.
        const clocked = await tx.$executeRaw`UPDATE message SET trashed_at = ${now} WHERE mailbox_id = ${mb.id}::uuid AND trashed_at IS NULL`;
        c.clocked += clocked;
      }
      const due =
        action.kind === 'expire-trash'
          ? Prisma.sql`trashed_at < ${cutoff}`
          : Prisma.sql`received_at < ${cutoff}`;
      const rows = await tx.$queryRaw<{ uid: number; blob_sha256: string }[]>`
        DELETE FROM message WHERE id IN (
          SELECT id FROM message WHERE mailbox_id = ${mb.id}::uuid AND ${due} ORDER BY uid LIMIT ${batch}
        ) RETURNING uid, blob_sha256`;
      if (rows.length === 0) return 0;
      const modseq = box.highestModseq + 1n;
      await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${mb.id}::uuid`;
      const uids = rows.map((r) => r.uid).sort((a, b) => a - b);
      await recordExpunged(tx, mb.id, uids, modseq);
      const shas = rows.map((r) => r.blob_sha256);
      shredded.push(...(await release(tx, shas)));
      const [spool, spoolGone] = await releaseSpool(tx, shas, now);
      shredded.push(...spoolGone);
      c.spoolReleased += spool;
      await recordAudit(tx, {
        actor: ACTOR,
        action: 'retention.expunge',
        entityType: 'mailbox',
        entityId: mb.id,
        before: { accountId: mb.account_id, mailbox: mb.name, specialUse: box.specialUse, count: rows.length, uids },
        after: {
          days: action.days,
          [action.kind === 'expire-trash' ? 'trashedBefore' : 'receivedBefore']: cutoff.toISOString(),
          spoolReferencesReleased: spool,
          blobsShredded: shredded.length,
        },
      });
      await notifyMailbox(tx, mb.id);
      return rows.length;
    }, TX_OPTIONS);
    c.shredded += shredded.length;
    await reap(shredded);
    return n;
  };

  /** Pass 4, one batch. Returns spool rows released (0 = done). */
  const spoolBatch = async (now: Date, graceMs: number, batch: number, c: Counters): Promise<number> => {
    const cutoff = new Date(now.getTime() - graceMs);
    const shredded: string[] = [];
    const n = await db.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ blob_sha256: string }[]>`
        SELECT DISTINCT i.blob_sha256 FROM inbound_message i
        WHERE i.blob_released_at IS NULL AND i.received_at < ${cutoff}
          AND (i.state = 'rejected' OR (i.state = 'filed' AND CASE
                WHEN jsonb_typeof(i.verdicts #> '{pipeline,stages,file,result,copies}') = 'array'
                THEN jsonb_array_length(i.verdicts #> '{pipeline,stages,file,result,copies}') ELSE 0 END > 0))
          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.blob_sha256 = i.blob_sha256)
        ORDER BY i.blob_sha256 LIMIT ${batch}`;
      if (candidates.length === 0) return 0;
      const shas = candidates.map((r) => r.blob_sha256);
      // releaseSpool re-checks each blob has no Message rows inside this transaction.
      const [released, gone] = await releaseSpool(tx, shas, now);
      shredded.push(...gone);
      if (released > 0) {
        await recordAudit(tx, {
          actor: ACTOR,
          action: 'retention.release-spool',
          entityType: 'blob',
          after: { blobs: shas.length, spoolReferencesReleased: released, blobsShredded: gone.length, receivedBefore: cutoff.toISOString() },
        });
      }
      c.spoolReleased += released;
      return candidates.length;
    }, TX_OPTIONS);
    c.shredded += shredded.length;
    await reap(shredded);
    return n;
  };

  return async (options: RetentionOptions = {}): Promise<RetentionResult> => {
    const batch = options.batchSize ?? DEFAULT_BATCH;
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
    const now = clock();
    const c: Counters = { moved: 0, expunged: 0, spoolReleased: 0, shredded: 0, clocked: 0, noTrash: 0 };

    // No sweep-wide lock: every batch re-selects its rows under the mailbox locks, and a spool row
    // is released by an UPDATE ... WHERE blob_released_at IS NULL, so two sweeps (two workers, or a
    // slow run overlapping the next tick) can only ever do the work once.
    {
      const boxes = await db.$queryRaw<MailboxRow[]>`
        SELECT mb.id::text AS id, mb.account_id::text AS account_id, mb.name, mb.special_use,
               (rp.id IS NOT NULL) AS has_policy, rp.days
        FROM mailbox mb LEFT JOIN retention_policy rp ON rp.mailbox_id = mb.id
        ORDER BY mb.account_id, mb.id`;
      const trashOf = new Map<string, string>();
      for (const mb of boxes) if (mb.special_use === 'trash' && !trashOf.has(mb.account_id)) trashOf.set(mb.account_id, mb.id);

      // Pass 1 before 2: a message moved to Trash now starts a full Trash period, it is never
      // expunged in the same run.
      for (const mb of boxes) {
        const action = retentionAction(mb.special_use, mb.has_policy ? mb.days : undefined);
        if (action?.kind !== 'to-trash') continue;
        const trashId = trashOf.get(mb.account_id);
        if (trashId === undefined) {
          c.noTrash++;
          log('retention-no-trash', { accountId: mb.account_id, mailbox: mb.name });
          continue;
        }
        for (let i = 0; i < maxBatches; i++) {
          const n = await moveBatch(mb, action, trashId, now, batch);
          c.moved += n;
          if (n < batch) break;
        }
      }
      for (const mb of boxes) {
        const action = retentionAction(mb.special_use, mb.has_policy ? mb.days : undefined);
        if (action === null || action.kind === 'to-trash') continue;
        for (let i = 0; i < maxBatches; i++) {
          const n = await expireBatch(mb, action, now, batch, c);
          c.expunged += n;
          if (n < batch) break;
        }
      }
      for (let i = 0; i < maxBatches; i++) {
        const n = await spoolBatch(now, options.spoolGraceMs ?? DEFAULT_SPOOL_GRACE_MS, batch, c);
        if (n < batch) break;
      }
    }

    const gc = options.skipGc === true ? null : await blobs.gc(options.gcOlderThanMs === undefined ? {} : { olderThanMs: options.gcOlderThanMs });
    const result: RetentionResult = { ...c, gc };
    if (c.moved + c.expunged + c.spoolReleased + c.clocked > 0 || (gc !== null && gc.orphans + gc.temps > 0)) log('retention-sweep', { ...result });
    return result;
  };
}
