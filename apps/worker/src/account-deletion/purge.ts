// The account purge (PST-T-20.3, PST-ADR-016): an account that asked to be deleted, once its grace
// period has passed, goes for good — and its mailbox is crypto-shredded on the way.
//
// Deleting the account row would cascade its messages away without touching the blob store, so
// every blob would keep a reference nobody holds and never be shredded. So, for each due account:
//
//  1. Messages, in batches (each one transaction, the account row and its mailboxes locked): the rows
//     are deleted and one reference per row released through BlobStore.release — the release that
//     takes a blob to zero deletes its row, the wrapped DEK, in the same commit (PST-ADR-009). A
//     spool row still holding a reference to a blob no message names any more releases it too.
//  2. Then, in one transaction: held sends, composer uploads and finished outbound messages release
//     theirs, and the account row is deleted — taking with it (by foreign key) its mailboxes,
//     threads, DAV collections and resources (each resource's DEK is in its row: shredded), keys,
//     rules, templates, Bayes counts, addresses, recovery codes and identity links. Audit history
//     stays, its actor set null; the purge itself is audited as SYSTEM, with counts only.
//  3. Files whose row went are unlinked after each commit (BlobStore.reap); the retention sweep's
//     gc removes any a crash left behind.
//
// An account restored in the meantime (delete_after cleared) is passed by — re-checked under the row
// lock in every transaction. One whose mail is still in the outbound queue (a recipient queued,
// attempting or deferred) is deferred to a later run rather than pulled out from under delivery.
// Blobs are shared by identical bytes: a message another account also holds keeps its blob.
import { recordAudit, type Actor } from '@postroom/audit';
import { BlobNotFoundError, type BlobStore } from '@postroom/blobstore';
import type { Db, Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient;

export const PURGE_BATCH = 200;
const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;
const ACTOR: Actor = { kind: 'system', label: 'account-deletion' };

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface PurgeDeps {
  readonly db: Db;
  readonly blobs: Pick<BlobStore, 'release' | 'reap'>;
  readonly log?: Log;
  /** The test clock. */
  readonly now?: () => Date;
}

export interface PurgeResult {
  /** Accounts deleted. */
  readonly purged: number;
  /** Due accounts left for a later run (mail still in the outbound queue). */
  readonly deferred: number;
  /** Message rows removed. */
  readonly messages: number;
  /** Blobs whose last reference went: wrapped DEK deleted. */
  readonly shredded: number;
}

class Restored extends Error {}

/** Lock the account row and confirm it is still due; throws Restored when it is not. */
async function lockDue(tx: Tx, accountId: string, now: Date): Promise<void> {
  const rows = await tx.$queryRaw<{ delete_after: Date | null; disabled_at: Date | null }[]>`
    SELECT delete_after, disabled_at FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (row === undefined || row.delete_after === null || row.disabled_at === null || row.delete_after.getTime() > now.getTime()) throw new Restored();
}

const OPEN_RECIPIENT_STATES = ['queued', 'attempting', 'deferred'];

async function openOutbound(tx: Tx | Db, accountId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbound_recipient r JOIN outbound_message m ON m.id = r.outbound_message_id
    WHERE m.account_id = ${accountId}::uuid AND r.state::text = ANY(${OPEN_RECIPIENT_STATES})`;
  return Number(rows[0]?.n ?? 0);
}

export function createAccountPurger(deps: PurgeDeps): (options?: { batchSize?: number }) => Promise<PurgeResult> {
  const { db, blobs } = deps;
  const log: Log = deps.log ?? ((): void => undefined);
  const clock = deps.now ?? ((): Date => new Date());

  /** One reference released; a blob row already gone has nothing to release. True when it was the last. */
  const release = async (tx: Tx, sha: string): Promise<boolean> => {
    try {
      return (await blobs.release(sha, tx)).refcount === 0;
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
  };

  /** For each blob no message names any more, the finished spool rows still holding it let go. */
  const releaseSpool = async (tx: Tx, shas: readonly string[], now: Date, gone: string[]): Promise<void> => {
    for (const sha of [...new Set(shas)].sort()) {
      if (gone.includes(sha)) continue;
      const still = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM message WHERE blob_sha256 = ${sha}`;
      if (Number(still[0]?.n ?? 0) > 0) continue;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE inbound_message SET blob_released_at = ${now}
        WHERE blob_sha256 = ${sha} AND blob_released_at IS NULL AND state IN ('filed', 'rejected')
        RETURNING id::text AS id`;
      for (let i = 0; i < rows.length; i++) {
        if (await release(tx, sha)) {
          gone.push(sha);
          break;
        }
      }
    }
  };

  const reap = async (shas: readonly string[]): Promise<void> => {
    for (const sha of new Set(shas)) {
      try {
        await blobs.reap(sha);
      } catch (err) {
        // The row is gone, so the file is unreadable already; the retention sweep's gc removes it.
        log('account-purge-reap-error', { sha256: sha, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  /** Pass 1, one batch. Returns [messages removed, shas shredded]. */
  const messageBatch = async (accountId: string, now: Date, batch: number): Promise<[number, string[]]> =>
    db.$transaction(async (tx) => {
      await lockDue(tx, accountId, now);
      // The IMAP store's lock order: mailboxes by id.
      await tx.$queryRaw`SELECT id FROM mailbox WHERE account_id = ${accountId}::uuid ORDER BY id FOR UPDATE`;
      const rows = await tx.$queryRaw<{ id: string; blob_sha256: string }[]>`
        SELECT m.id::text AS id, m.blob_sha256 FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
        WHERE mb.account_id = ${accountId}::uuid ORDER BY m.id LIMIT ${batch}`;
      if (rows.length === 0) return [0, []];
      await tx.$executeRaw`DELETE FROM message WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
      const gone: string[] = [];
      for (const sha of rows.map((r) => r.blob_sha256).sort()) {
        if (await release(tx, sha)) gone.push(sha);
      }
      await releaseSpool(tx, rows.map((r) => r.blob_sha256), now, gone);
      return [rows.length, gone];
    }, TX_OPTIONS);

  /** Pass 2: everything else holding a blob, then the account. Returns the shas shredded, or null when deferred. */
  const finish = async (accountId: string, now: Date, messages: number): Promise<string[] | null> =>
    db.$transaction(async (tx) => {
      await lockDue(tx, accountId, now);
      if ((await openOutbound(tx, accountId)) > 0) return null;
      const gone: string[] = [];
      const take = async (sha: string): Promise<void> => {
        if (await release(tx, sha)) gone.push(sha);
      };

      // Held sends hold their message and every copy until released or cancelled.
      const held = await tx.pendingSend.findMany({ where: { accountId, state: 'held' }, select: { id: true, heldBlobSha256: true, copies: { select: { blobSha256: true } } } });
      for (const send of held) {
        const claimed = await tx.pendingSend.updateMany({ where: { id: send.id, state: 'held' }, data: { state: 'cancelled', reason: 'account deleted', finishedAt: now } });
        if (claimed.count === 0) continue;
        for (const sha of [send.heldBlobSha256, ...send.copies.map((c) => c.blobSha256)].sort()) await take(sha);
      }
      const uploads = await tx.composeUpload.findMany({ where: { accountId }, select: { id: true, blobSha256: true } });
      for (const upload of uploads) {
        await tx.composeUpload.delete({ where: { id: upload.id } });
        await take(upload.blobSha256);
      }
      const outbound = await tx.outboundMessage.findMany({ where: { accountId }, select: { id: true, blobSha256: true } });
      for (const message of outbound) {
        await tx.outboundMessage.delete({ where: { id: message.id } });
        await take(message.blobSha256);
      }

      await tx.account.delete({ where: { id: accountId } });
      await recordAudit(tx, {
        actor: ACTOR,
        action: 'account.purge',
        entityType: 'account',
        entityId: accountId,
        before: { deleted: false },
        after: { deleted: true, messages, heldSends: held.length, uploads: uploads.length, outbound: outbound.length, blobsShredded: gone.length },
      });
      return gone;
    }, TX_OPTIONS);

  return async function purge(options = {}): Promise<PurgeResult> {
    const batch = options.batchSize ?? PURGE_BATCH;
    const now = clock();
    const due = await db.account.findMany({
      where: { deleteAfter: { lte: now }, disabledAt: { not: null } },
      select: { id: true },
      orderBy: { deleteAfter: 'asc' },
    });
    let purged = 0;
    let deferred = 0;
    let removed = 0;
    let shredded = 0;
    for (const { id } of due) {
      try {
        // Checked before the messages go, too: an account whose mail is still leaving keeps it all.
        if ((await openOutbound(db, id)) > 0) {
          deferred++;
          log('account-purge-deferred', { accountId: id, reason: 'outbound queue' });
          continue;
        }
        let messages = 0;
        for (;;) {
          const [n, gone] = await messageBatch(id, now, batch);
          messages += n;
          shredded += gone.length;
          await reap(gone);
          if (n === 0) break;
        }
        removed += messages;
        const gone = await finish(id, now, messages);
        if (gone === null) {
          deferred++;
          log('account-purge-deferred', { accountId: id, reason: 'outbound queue' });
          continue;
        }
        shredded += gone.length;
        await reap(gone);
        purged++;
        log('account-purged', { accountId: id, messages, blobsShredded: gone.length });
      } catch (error) {
        if (error instanceof Restored) continue;
        // One account must not hold up the rest; it is tried again on the next run.
        log('account-purge-error', { accountId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { purged, deferred, messages: removed, shredded };
  };
}

/** Purge once at start, then on an interval. Errors are logged; the next tick tries again. */
export function startAccountPurgeLoop(deps: PurgeDeps & { intervalMs: number; log: Log }): { purge: ReturnType<typeof createAccountPurger>; stop(): Promise<void> } {
  const purge = createAccountPurger(deps);
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = purge()
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.log('account-purge-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  return {
    purge,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
