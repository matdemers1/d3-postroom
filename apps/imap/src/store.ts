// Every database read and write the IMAP daemon makes (PST-REQ-072, PST-REQ-009).
//
// Invariants, held by locking the mailbox row (SELECT ... FOR UPDATE) at the start of every
// transaction that changes a mailbox:
//   - UIDs come from mailbox.uidnext and only ever grow; a UID is never reused within a UIDVALIDITY
//     (new messages are filed through @postroom/dsn's fileLocalMessage, which takes the same lock).
//   - Every change — a flag, an arrival, an expunge, a move out — sets mailbox.highest_modseq to a
//     new, larger value, and every changed message's modseq to that value.
//   - When two mailboxes are locked (COPY, MOVE) they are locked in id order; blob locks come after
//     mailbox locks, in SHA-256 order. So two transactions never wait on each other in a cycle.
//
// Auditing (PST-REQ-009): mailbox create, rename and delete, and every EXPUNGE, write an audit row
// in the same transaction. Flag changes and moves are not audited one by one (a client marking a
// thousand messages read would drown the log); their record is the modseq they bump.
//
// No silent deletion: EXPUNGE (and CLOSE) removes only messages the client itself flagged \Deleted,
// and DELETE removes a mailbox only on the client's explicit command — never INBOX or a special-use
// mailbox — each with an audit row naming how many messages went.
//
// QRESYNC needs the UIDs an EXPUNGE removed, with their modseq, to answer VANISHED (EARLIER): they
// are kept in expunged_message by `recordExpunged` below — the one place that writes it.
//
// Every transaction that changes a mailbox's messages ends with pg_notify('postroom_mailbox', id)
// (`notifyMailbox`), so IDLE sessions — in this process and any other — and webmail tabs wake.
//
// Training (PST-T-5.3, PST-REQ-104): a MOVE between two sorting buckets (see @postroom/classifier's
// trainingMove), and an EXPUNGE of a message whose copy already sits in a different bucket (the
// COPY-then-EXPUNGE move older clients make), write a bayes_training_event in the same transaction.
// The table is insert-only here and takes no lock of its own, so the locking order above is unchanged;
// the worker applies the events later. Like the move itself, the event is its own record — not audited.
import { randomInt, randomUUID } from 'node:crypto';
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore } from '@postroom/blobstore';
import { trainingMove, type TrainingMove } from '@postroom/classifier';
import { Prisma, randomUidValidity, type Db, type SpecialUse } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import type { StoreOperation } from '@postroom/imap-proto';
import { parseDate, parseMailboxes, parseMessageId, parseMessageIdList, type HeaderList } from '@postroom/mime';
import { applyFlags, DELETED, isKeyword, normalizeFlags, sameFlags, SEEN } from './flags.js';
import { MAILBOX_CHANNEL } from './extensions/notify.js';
import { isSelfOrChild, parentsOf } from './names.js';

type Tx = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

export interface MailboxInfo {
  readonly id: string;
  readonly name: string;
  readonly specialUse: SpecialUse | null;
  readonly uidvalidity: number;
  readonly uidnext: number;
  readonly highestModseq: bigint;
  readonly subscribed: boolean;
}

export interface MessageRow {
  readonly id: string;
  readonly uid: number;
  readonly modseq: bigint;
  readonly flags: string[];
  readonly size: number;
  readonly internalDate: Date;
  readonly sentAt: Date | null;
  readonly blobSha256: string;
}

export interface FlagRow {
  readonly uid: number;
  readonly flags: string[];
  readonly modseq: bigint;
}

export interface MailboxCounts {
  readonly messages: number;
  readonly unseen: number;
  readonly deleted: number;
  readonly size: number;
}

/** Who is acting, for audit rows. */
export interface ActorMeta {
  readonly accountId: string;
  readonly ip: string | null;
}

export interface Denormalised {
  readonly messageIdHeader: string | null;
  readonly subject: string | null;
  readonly fromAddress: string | null;
  readonly sentAt: Date | null;
  readonly inReplyTo: string | null;
  readonly references: string[];
  /** To/Cc addresses (lowercased local@domain), for the reply-graph harvest on a \Sent APPEND (PST-T-5.8). */
  readonly recipientAddresses: string[];
}

/** The same columns smtp-in and the worker fill at filing time, from a message's top-level headers. */
export function denormalise(headers: HeaderList): Denormalised {
  const mid = headers.get('message-id');
  const subject = headers.getDecoded('subject');
  const from = headers.get('from');
  const date = headers.get('date');
  const irt = headers.get('in-reply-to');
  const refs = headers.get('references');
  const to = headers.get('to');
  const cc = headers.get('cc');
  const sent = date === null ? null : parseDate(date);
  const recipients = new Set<string>();
  for (const field of [to, cc]) {
    if (field === null) continue;
    for (const m of parseMailboxes(field)) if (m.address !== '') recipients.add(m.address.toLowerCase());
  }
  return {
    messageIdHeader: mid === null ? null : parseMessageId(mid),
    subject: subject === null ? null : subject.slice(0, 998),
    fromAddress: from === null ? null : (parseMailboxes(from)[0]?.address ?? null),
    sentAt: sent === null || Number.isNaN(sent.getTime()) ? null : sent,
    inReplyTo: irt === null ? null : (parseMessageIdList(irt)[0] ?? null),
    references: refs === null ? [] : parseMessageIdList(refs).slice(0, 100),
    recipientAddresses: [...recipients],
  };
}

export class MailboxGoneError extends Error {
  constructor() {
    super('mailbox no longer exists');
  }
}

class Rollback extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface MailboxDbRow {
  id: string;
  name: string;
  special_use: SpecialUse | null;
  uidvalidity: number;
  uidnext: number;
  highest_modseq: bigint;
  subscribed: boolean;
}

function toInfo(r: MailboxDbRow): MailboxInfo {
  return {
    id: r.id,
    name: r.name,
    specialUse: r.special_use,
    uidvalidity: r.uidvalidity,
    uidnext: r.uidnext,
    highestModseq: r.highest_modseq,
    subscribed: r.subscribed,
  };
}

const MAILBOX_COLUMNS = Prisma.sql`id::text AS id, name, special_use, uidvalidity, uidnext, highest_modseq, subscribed`;

function actor(meta: ActorMeta): Actor {
  return { kind: 'account', accountId: meta.accountId };
}

function context(meta: ActorMeta): { requestId: string; ip: string | null } {
  return { requestId: randomUUID(), ip: meta.ip };
}

export type CreateResult = { readonly ok: true; readonly mailbox: MailboxInfo } | { readonly ok: false; readonly reason: 'exists' };
export type DeleteResult = 'ok' | 'nonexistent' | 'inbox' | 'special' | 'children';
export type RenameResult = 'ok' | 'nonexistent' | 'exists' | 'into-self';

export interface StoreFlagsResult {
  /** Every targeted message still present, with its flags and modseq after the STORE. */
  readonly rows: FlagRow[];
  /** UIDs whose flags actually changed. */
  readonly changed: Set<number>;
  /** UNCHANGEDSINCE failures (RFC 7162 [MODIFIED]). */
  readonly modified: number[];
  readonly modseq: bigint | null;
}

export interface CopyResult {
  readonly uidvalidity: number;
  /** [source UID, destination UID], in source UID order. */
  readonly pairs: [number, number][];
}

export class MailStore {
  constructor(
    readonly db: Db,
    private readonly blobs: Pick<BlobStore, 'release' | 'reap'>,
  ) {}

  // --- reads -----------------------------------------------------------------------------------

  async listMailboxes(accountId: string): Promise<MailboxInfo[]> {
    const rows = await this.db.$queryRaw<MailboxDbRow[]>`
      SELECT ${MAILBOX_COLUMNS} FROM mailbox WHERE account_id = ${accountId}::uuid ORDER BY name`;
    return rows.map(toInfo);
  }

  async findMailbox(accountId: string, name: string): Promise<MailboxInfo | null> {
    const rows = await this.db.$queryRaw<MailboxDbRow[]>`
      SELECT ${MAILBOX_COLUMNS} FROM mailbox WHERE account_id = ${accountId}::uuid AND name = ${name}`;
    const r = rows[0];
    return r === undefined ? null : toInfo(r);
  }

  /** uidnext and highest_modseq, or null when the mailbox is gone. */
  async probe(mailboxId: string): Promise<{ uidnext: number; highestModseq: bigint } | null> {
    const rows = await this.db.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`
      SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailboxId}::uuid`;
    const r = rows[0];
    return r === undefined ? null : { uidnext: r.uidnext, highestModseq: r.highest_modseq };
  }

  /** Every message's UID and modseq, in UID order (a SELECT snapshot). */
  async snapshot(mailboxId: string): Promise<{ uid: number; modseq: bigint; seen: boolean }[]> {
    const rows = await this.db.$queryRaw<{ uid: number; modseq: bigint; seen: boolean }[]>`
      SELECT uid, modseq, ${SEEN} = ANY(flags) AS seen FROM message WHERE mailbox_id = ${mailboxId}::uuid ORDER BY uid`;
    return rows.map((r) => ({ uid: r.uid, modseq: r.modseq, seen: r.seen }));
  }

  async changedSince(mailboxId: string, modseq: bigint): Promise<FlagRow[]> {
    const rows = await this.db.$queryRaw<FlagRow[]>`
      SELECT uid, flags, modseq FROM message
      WHERE mailbox_id = ${mailboxId}::uuid AND modseq > ${modseq} ORDER BY uid`;
    return rows.map((r) => ({ uid: r.uid, flags: r.flags, modseq: r.modseq }));
  }

  /** UIDs expunged (or moved out) after `modseq`, ascending — QRESYNC's VANISHED (EARLIER). */
  async expungedSince(mailboxId: string, modseq: bigint): Promise<number[]> {
    const rows = await this.db.$queryRaw<{ uid: number }[]>`
      SELECT uid FROM expunged_message WHERE mailbox_id = ${mailboxId}::uuid AND modseq > ${modseq} ORDER BY uid`;
    return rows.map((r) => r.uid);
  }

  async uidsUpTo(mailboxId: string, maxUid: number): Promise<number[]> {
    const rows = await this.db.$queryRaw<{ uid: number }[]>`
      SELECT uid FROM message WHERE mailbox_id = ${mailboxId}::uuid AND uid <= ${maxUid} ORDER BY uid`;
    return rows.map((r) => r.uid);
  }

  async countUpTo(mailboxId: string, maxUid: number): Promise<number> {
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM message WHERE mailbox_id = ${mailboxId}::uuid AND uid <= ${maxUid}`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Keywords in use in the mailbox, for FLAGS / PERMANENTFLAGS. */
  async keywords(mailboxId: string): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ f: string }[]>`
      SELECT DISTINCT f FROM message, unnest(flags) AS f WHERE mailbox_id = ${mailboxId}::uuid ORDER BY f LIMIT 200`;
    return normalizeFlags(rows.map((r) => r.f).filter(isKeyword));
  }

  async counts(mailboxId: string): Promise<MailboxCounts> {
    const rows = await this.db.$queryRaw<{ messages: bigint; unseen: bigint; deleted: bigint; size: bigint | null }[]>`
      SELECT count(*) AS messages,
             count(*) FILTER (WHERE NOT (${SEEN} = ANY(flags))) AS unseen,
             count(*) FILTER (WHERE ${DELETED} = ANY(flags)) AS deleted,
             sum(size)::bigint AS size
      FROM message WHERE mailbox_id = ${mailboxId}::uuid`;
    const r = rows[0];
    return {
      messages: Number(r?.messages ?? 0),
      unseen: Number(r?.unseen ?? 0),
      deleted: Number(r?.deleted ?? 0),
      size: Number(r?.size ?? 0),
    };
  }

  async rowsByUids(mailboxId: string, uids: readonly number[]): Promise<MessageRow[]> {
    if (uids.length === 0) return [];
    const rows = await this.db.$queryRaw<
      { id: string; uid: number; modseq: bigint; flags: string[]; size: number; internal_date: Date; sent_at: Date | null; blob_sha256: string }[]
    >`
      SELECT id::text AS id, uid, modseq, flags, size, internal_date, sent_at, blob_sha256 FROM message
      WHERE mailbox_id = ${mailboxId}::uuid AND uid = ANY(${[...uids]}::int[]) ORDER BY uid`;
    return rows.map((r) => ({
      id: r.id,
      uid: r.uid,
      modseq: r.modseq,
      flags: r.flags,
      size: r.size,
      internalDate: r.internal_date,
      sentAt: r.sent_at,
      blobSha256: r.blob_sha256,
    }));
  }

  /** Indexed text for SEARCH (PST-T-3.7 writes it; absent until the worker's parse stage has). */
  async searchText(messageId: string): Promise<{ bodyText: string } | null> {
    const rows = await this.db.$queryRaw<{ body_text: string }[]>`
      SELECT body_text FROM message_search WHERE message_id = ${messageId}::uuid`;
    const r = rows[0];
    return r === undefined ? null : { bodyText: r.body_text };
  }

  // --- flags ------------------------------------------------------------------------------------

  async storeFlags(
    mailboxId: string,
    uids: readonly number[],
    op: StoreOperation,
    flags: readonly string[],
    unchangedSince: bigint | null = null,
  ): Promise<StoreFlagsResult> {
    if (uids.length === 0) return { rows: [], changed: new Set(), modified: [], modseq: null };
    return this.db.$transaction(async (tx) => {
      const hm = await lockMailbox(tx, mailboxId);
      const current = await tx.$queryRaw<FlagRow[]>`
        SELECT uid, flags, modseq FROM message
        WHERE mailbox_id = ${mailboxId}::uuid AND uid = ANY(${[...uids]}::int[]) ORDER BY uid`;
      const modified: number[] = [];
      const updates: { uid: number; flags: string[] }[] = [];
      for (const r of current) {
        if (unchangedSince !== null && r.modseq > unchangedSince) {
          modified.push(r.uid);
          continue;
        }
        const next = applyFlags(r.flags, op, flags);
        if (!sameFlags(next, r.flags)) updates.push({ uid: r.uid, flags: next });
      }
      let modseq: bigint | null = null;
      if (updates.length > 0) {
        modseq = hm.highestModseq + 1n;
        await tx.$executeRaw`
          UPDATE message AS m SET flags = v.flags, modseq = ${modseq}
          FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS v(uid int, flags text[])
          WHERE m.mailbox_id = ${mailboxId}::uuid AND m.uid = v.uid`;
        await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${mailboxId}::uuid`;
        await notifyMailbox(tx, mailboxId);
      }
      const byUid = new Map(updates.map((u) => [u.uid, u.flags]));
      const rows = current
        .filter((r) => !modified.includes(r.uid))
        .map((r) => {
          const f = byUid.get(r.uid);
          return f === undefined || modseq === null ? { uid: r.uid, flags: r.flags, modseq: r.modseq } : { uid: r.uid, flags: f, modseq };
        });
      return { rows, changed: new Set(byUid.keys()), modified, modseq };
    }, TX_OPTIONS);
  }

  // --- expunge, copy, move, append --------------------------------------------------------------

  /** Remove the \Deleted messages (of `uids`, when given). Returns the UIDs removed, ascending. */
  async expunge(meta: ActorMeta, mailboxId: string, uids: readonly number[] | null, reason: 'EXPUNGE' | 'UID EXPUNGE' | 'CLOSE'): Promise<number[]> {
    if (uids !== null && uids.length === 0) return [];
    const released: string[] = [];
    const removed = await this.db.$transaction(async (tx) => {
      const hm = await lockMailbox(tx, mailboxId);
      const only = uids === null ? Prisma.empty : Prisma.sql`AND uid = ANY(${[...uids]}::int[])`;
      const rows = await tx.$queryRaw<{ uid: number; blob_sha256: string }[]>`
        DELETE FROM message WHERE mailbox_id = ${mailboxId}::uuid AND ${DELETED} = ANY(flags) ${only}
        RETURNING uid, blob_sha256`;
      if (rows.length === 0) return [];
      await recordCopyMoves(tx, meta.accountId, mailboxId, rows.map((r) => r.blob_sha256));
      const modseq = hm.highestModseq + 1n;
      await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${mailboxId}::uuid`;
      released.push(...(await this.releaseBlobs(tx, rows.map((r) => r.blob_sha256))));
      const removedUids = rows.map((r) => r.uid).sort((a, b) => a - b);
      await recordExpunged(tx, mailboxId, removedUids, modseq);
      await recordAudit(tx, {
        actor: actor(meta),
        action: 'message.expunge',
        entityType: 'mailbox',
        entityId: mailboxId,
        before: { uids: removedUids, count: removedUids.length, via: reason },
        context: context(meta),
      });
      await notifyMailbox(tx, mailboxId);
      return removedUids;
    }, TX_OPTIONS);
    await this.reap(released);
    return removed;
  }

  async copy(sourceId: string, uids: readonly number[], targetId: string): Promise<CopyResult> {
    return this.db.$transaction(async (tx) => {
      const locked = await lockMailboxes(tx, [sourceId, targetId]);
      const target = locked.get(targetId);
      if (target === undefined) throw new MailboxGoneError();
      const rows = await tx.$queryRaw<
        {
          id: string;
          uid: number;
          blob_sha256: string;
          size: number;
          internal_date: Date;
          flags: string[];
          message_id_header: string | null;
          subject: string | null;
          from_address: string | null;
          sent_at: Date | null;
          in_reply_to: string | null;
          references: string[];
        }[]
      >`
        SELECT id::text AS id, uid, blob_sha256, size, internal_date, flags, message_id_header, subject,
               from_address, sent_at, in_reply_to, "references"
        FROM message WHERE mailbox_id = ${sourceId}::uuid AND uid = ANY(${[...uids]}::int[]) ORDER BY uid`;
      if (rows.length === 0) return { uidvalidity: target.uidvalidity, pairs: [] };
      // One more reference per copy (PST-REQ-012: the blob itself is never touched).
      const perBlob = new Map<string, number>();
      for (const r of rows) perBlob.set(r.blob_sha256, (perBlob.get(r.blob_sha256) ?? 0) + 1);
      for (const sha of [...perBlob.keys()].sort()) {
        await lockBlob(tx, sha);
        await tx.$executeRaw`UPDATE blob SET refcount = refcount + ${perBlob.get(sha) ?? 0} WHERE sha256 = ${sha}`;
      }
      const pairs: [number, number][] = [];
      for (const r of rows) {
        const filed = await fileLocalMessage(tx, {
          accountId: target.accountId,
          mailbox: target.name,
          blobSha256: r.blob_sha256,
          size: r.size,
          internalDate: r.internal_date,
          flags: r.flags,
        });
        await tx.message.update({
          where: { id: filed.id },
          data: {
            messageIdHeader: r.message_id_header,
            subject: r.subject,
            fromAddress: r.from_address,
            sentAt: r.sent_at,
            inReplyTo: r.in_reply_to,
            references: r.references,
          },
        });
        await tx.$executeRaw`
          INSERT INTO message_search (message_id, account_id, subject, from_text, to_text, body_text, has_attachment, attachment_names)
          SELECT ${filed.id}::uuid, account_id, subject, from_text, to_text, body_text, has_attachment, attachment_names
          FROM message_search WHERE message_id = ${r.id}::uuid`;
        await tx.$executeRaw`
          INSERT INTO message_verdict (message_id, auth, attachments, bucket, reasons)
          SELECT ${filed.id}::uuid, auth, attachments, bucket, reasons FROM message_verdict WHERE message_id = ${r.id}::uuid`;
        pairs.push([r.uid, filed.uid]);
      }
      await notifyMailbox(tx, targetId);
      return { uidvalidity: target.uidvalidity, pairs };
    }, TX_OPTIONS);
  }

  /**
   * RFC 6851 MOVE, atomically: each message row is re-homed (new UID and modseq in the target, the
   * source's modseq bumped), so its verdict, search text and thread go with it and its blob's
   * reference count is unchanged.
   */
  async move(sourceId: string, uids: readonly number[], targetId: string): Promise<CopyResult> {
    return this.db.$transaction(async (tx) => {
      const locked = await lockMailboxes(tx, [sourceId, targetId]);
      const target = locked.get(targetId);
      const source = locked.get(sourceId);
      if (target === undefined || source === undefined) throw new MailboxGoneError();
      const rows = await tx.$queryRaw<{ id: string; uid: number; blob_sha256: string }[]>`
        SELECT id::text AS id, uid, blob_sha256 FROM message
        WHERE mailbox_id = ${sourceId}::uuid AND uid = ANY(${[...uids]}::int[]) ORDER BY uid`;
      if (rows.length === 0) return { uidvalidity: target.uidvalidity, pairs: [] };
      const modseq = (target.highestModseq > source.highestModseq ? target.highestModseq : source.highestModseq) + 1n;
      const pairs: [number, number][] = [];
      let next = target.uidnext;
      for (const r of rows) {
        await tx.$executeRaw`
          UPDATE message AS m SET mailbox_id = ${targetId}::uuid, uid = ${next}, modseq = ${modseq},
            inbound_message_id = CASE WHEN EXISTS (
              SELECT 1 FROM message o WHERE o.mailbox_id = ${targetId}::uuid AND o.inbound_message_id = m.inbound_message_id
            ) THEN NULL ELSE m.inbound_message_id END
          WHERE m.id = ${r.id}::uuid`;
        pairs.push([r.uid, next]);
        next++;
      }
      await tx.$executeRaw`UPDATE mailbox SET uidnext = ${next}, highest_modseq = ${modseq} WHERE id = ${targetId}::uuid`;
      if (sourceId !== targetId) {
        await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${sourceId}::uuid`;
      }
      await recordExpunged(
        tx,
        sourceId,
        pairs.map(([s]) => s),
        modseq,
      );
      const training = trainingMove(source, target);
      if (training !== null) {
        await recordTraining(tx, source.accountId, training, 'imap-move', rows.map((r) => ({ messageId: r.id, blobSha256: r.blob_sha256 })));
      }
      await notifyMailbox(tx, targetId);
      if (sourceId !== targetId) await notifyMailbox(tx, sourceId);
      return { uidvalidity: target.uidvalidity, pairs };
    }, TX_OPTIONS);
  }

  /** File an already-stored blob (whose one reference this message now owns). */
  async append(
    accountId: string,
    mailboxId: string,
    input: { sha256: string; size: number; flags: readonly string[]; internalDate: Date; denorm: Denormalised | null },
  ): Promise<{ uid: number; uidvalidity: number }> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ name: string; uidvalidity: number; special_use: SpecialUse | null }[]>`
        SELECT name, uidvalidity, special_use FROM mailbox WHERE id = ${mailboxId}::uuid AND account_id = ${accountId}::uuid FOR UPDATE`;
      const mb = rows[0];
      if (mb === undefined) throw new MailboxGoneError();
      const filed = await fileLocalMessage(tx, {
        accountId,
        mailbox: mb.name,
        blobSha256: input.sha256,
        size: input.size,
        internalDate: input.internalDate,
        flags: normalizeFlags(input.flags),
      });
      if (input.denorm !== null) {
        const { recipientAddresses, ...denormColumns } = input.denorm;
        await tx.message.update({ where: { id: filed.id }, data: { ...denormColumns } });
        // A client filing its own Sent copy (PST-T-5.8): harvest To/Cc into the reply graph too, the
        // same table acceptSubmission maintains for messages sent through Postroom itself.
        if (mb.special_use === 'sent' && recipientAddresses.length > 0) {
          await harvestSentRecipients(tx, accountId, recipientAddresses, input.internalDate);
        }
      }
      await notifyMailbox(tx, mailboxId);
      return { uid: filed.uid, uidvalidity: mb.uidvalidity };
    }, TX_OPTIONS);
  }

  // --- mailboxes --------------------------------------------------------------------------------

  async createMailbox(meta: ActorMeta, name: string, specialUse: SpecialUse | null): Promise<CreateResult> {
    try {
      const created = await this.db.$transaction(async (tx) => {
        let made: MailboxInfo | null = null;
        for (const n of [...parentsOf(name), name]) {
          const use = n === name ? specialUse : null;
          const rows = await tx.$queryRaw<MailboxDbRow[]>`
            INSERT INTO mailbox (account_id, name, special_use, uidvalidity)
            VALUES (${meta.accountId}::uuid, ${n}, ${use}::special_use, ${randomUidValidity(randomInt)})
            ON CONFLICT (account_id, name) DO NOTHING
            RETURNING ${MAILBOX_COLUMNS}`;
          const row = rows[0];
          if (row === undefined) {
            if (n === name) throw new Rollback('exists');
            continue;
          }
          await recordAudit(tx, {
            actor: actor(meta),
            action: 'mailbox.create',
            entityType: 'mailbox',
            entityId: row.id,
            after: { name: row.name, specialUse: row.special_use, uidvalidity: row.uidvalidity, via: 'imap' },
            context: context(meta),
          });
          if (n === name) made = toInfo(row);
        }
        if (made === null) throw new Rollback('exists');
        return made;
      }, TX_OPTIONS);
      return { ok: true, mailbox: created };
    } catch (err) {
      if (err instanceof Rollback) return { ok: false, reason: 'exists' };
      throw err;
    }
  }

  async deleteMailbox(meta: ActorMeta, name: string): Promise<DeleteResult> {
    const mb = await this.findMailbox(meta.accountId, name);
    if (mb === null) return 'nonexistent';
    if (mb.name === 'INBOX') return 'inbox';
    if (mb.specialUse !== null) return 'special';
    const released: string[] = [];
    const result = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM mailbox WHERE id = ${mb.id}::uuid FOR UPDATE`;
      if (locked.length === 0) return 'nonexistent' as const;
      const children = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM mailbox
        WHERE account_id = ${meta.accountId}::uuid AND left(name, ${name.length + 1}) = ${`${name}/`}`;
      if (Number(children[0]?.n ?? 0) > 0) return 'children' as const;
      const rows = await tx.$queryRaw<{ uid: number; blob_sha256: string }[]>`
        DELETE FROM message WHERE mailbox_id = ${mb.id}::uuid RETURNING uid, blob_sha256`;
      released.push(...(await this.releaseBlobs(tx, rows.map((r) => r.blob_sha256))));
      await tx.$executeRaw`DELETE FROM mailbox WHERE id = ${mb.id}::uuid`;
      await recordAudit(tx, {
        actor: actor(meta),
        action: 'mailbox.delete',
        entityType: 'mailbox',
        entityId: mb.id,
        before: { name: mb.name, uidvalidity: mb.uidvalidity, messages: rows.length, via: 'imap' },
        context: context(meta),
      });
      await notifyMailbox(tx, mb.id);
      return 'ok' as const;
    }, TX_OPTIONS);
    await this.reap(released);
    return result;
  }

  async renameMailbox(meta: ActorMeta, from: string, to: string): Promise<RenameResult> {
    if (from === to) return 'exists';
    if (from !== 'INBOX' && isSelfOrChild(to, from)) return 'into-self';
    const src = await this.findMailbox(meta.accountId, from);
    if (src === null) return 'nonexistent';
    try {
      await this.db.$transaction(async (tx) => {
        const locked = await lockMailbox(tx, src.id);
        if (from === 'INBOX') {
          // RFC 3501 §6.3.6: INBOX's messages move to a new mailbox; INBOX stays, empty.
          await this.createParents(tx, meta, to, new Set());
          const created = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO mailbox (account_id, name, uidvalidity, uidnext, highest_modseq)
            VALUES (${meta.accountId}::uuid, ${to}, ${randomUidValidity(randomInt)}, ${src.uidnext}, ${src.highestModseq})
            ON CONFLICT (account_id, name) DO NOTHING RETURNING id::text AS id`;
          const target = created[0];
          if (target === undefined) throw new Rollback('exists');
          const moved = await tx.$queryRaw<{ uid: number }[]>`
            UPDATE message SET mailbox_id = ${target.id}::uuid WHERE mailbox_id = ${src.id}::uuid RETURNING uid`;
          await tx.$executeRaw`UPDATE mailbox SET highest_modseq = highest_modseq + 1 WHERE id = ${src.id}::uuid`;
          // To a QRESYNC client of INBOX, its messages vanished.
          await recordExpunged(
            tx,
            src.id,
            moved.map((m) => m.uid).sort((a, b) => a - b),
            locked.highestModseq + 1n,
          );
          await notifyMailbox(tx, src.id);
          await notifyMailbox(tx, target.id);
          await recordAudit(tx, {
            actor: actor(meta),
            action: 'mailbox.rename',
            entityType: 'mailbox',
            entityId: target.id,
            before: { name: from },
            after: { name: to, inboxMessagesMoved: true, via: 'imap' },
            context: context(meta),
          });
          return;
        }
        const moving = await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text AS id, name FROM mailbox
          WHERE account_id = ${meta.accountId}::uuid AND (name = ${from} OR left(name, ${from.length + 1}) = ${`${from}/`})
          ORDER BY id FOR UPDATE`;
        const renamed = moving.map((m) => ({ id: m.id, before: m.name, after: to + m.name.slice(from.length) }));
        const clash = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM mailbox
          WHERE account_id = ${meta.accountId}::uuid AND name = ANY(${renamed.map((r) => r.after)}::text[])`;
        if (Number(clash[0]?.n ?? 0) > 0) throw new Rollback('exists');
        for (const r of renamed) await tx.$executeRaw`UPDATE mailbox SET name = ${r.after} WHERE id = ${r.id}::uuid`;
        await this.createParents(tx, meta, to, new Set(renamed.map((r) => r.after)));
        await recordAudit(tx, {
          actor: actor(meta),
          action: 'mailbox.rename',
          entityType: 'mailbox',
          entityId: src.id,
          before: { name: from },
          after: { name: to, children: renamed.length - 1, via: 'imap' },
          context: context(meta),
        });
      }, TX_OPTIONS);
      return 'ok';
    } catch (err) {
      if (err instanceof Rollback) return 'exists';
      throw err;
    }
  }

  async setSubscribed(accountId: string, name: string, subscribed: boolean): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE mailbox SET subscribed = ${subscribed} WHERE account_id = ${accountId}::uuid AND name = ${name}`;
    return n > 0;
  }

  // --- helpers ------------------------------------------------------------------------------------

  private async createParents(tx: Tx, meta: ActorMeta, name: string, skip: ReadonlySet<string>): Promise<void> {
    for (const p of parentsOf(name)) {
      if (skip.has(p)) continue;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO mailbox (account_id, name, uidvalidity)
        VALUES (${meta.accountId}::uuid, ${p}, ${randomUidValidity(randomInt)})
        ON CONFLICT (account_id, name) DO NOTHING RETURNING id::text AS id`;
      const row = rows[0];
      if (row !== undefined) {
        await recordAudit(tx, {
          actor: actor(meta),
          action: 'mailbox.create',
          entityType: 'mailbox',
          entityId: row.id,
          after: { name: p, via: 'imap', implied: true },
          context: context(meta),
        });
      }
    }
  }

  /** Drop one reference per removed message; returns the blobs whose last reference went. */
  private async releaseBlobs(tx: Tx, shas: readonly string[]): Promise<string[]> {
    const gone: string[] = [];
    for (const sha of [...shas].sort()) {
      const r = await this.blobs.release(sha, tx);
      if (r.refcount === 0) gone.push(sha);
    }
    return gone;
  }

  /** After the commit: unlink files whose row went (gc() would, later, if this fails). */
  private async reap(shas: readonly string[]): Promise<void> {
    for (const sha of new Set(shas)) await this.blobs.reap(sha);
  }
}

async function lockMailbox(tx: Tx, mailboxId: string): Promise<{ highestModseq: bigint; uidnext: number }> {
  const rows = await tx.$queryRaw<{ highest_modseq: bigint; uidnext: number }[]>`
    SELECT highest_modseq, uidnext FROM mailbox WHERE id = ${mailboxId}::uuid FOR UPDATE`;
  const r = rows[0];
  if (r === undefined) throw new MailboxGoneError();
  return { highestModseq: r.highest_modseq, uidnext: r.uidnext };
}

interface LockedMailbox {
  readonly accountId: string;
  readonly name: string;
  readonly specialUse: SpecialUse | null;
  readonly uidvalidity: number;
  readonly uidnext: number;
  readonly highestModseq: bigint;
}

async function lockMailboxes(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedMailbox>> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string; account_id: string; name: string; special_use: SpecialUse | null; uidvalidity: number; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, account_id::text AS account_id, name, special_use, uidvalidity, uidnext, highest_modseq FROM mailbox
    WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
  return new Map(
    rows.map((r) => [
      r.id,
      { accountId: r.account_id, name: r.name, specialUse: r.special_use, uidvalidity: r.uidvalidity, uidnext: r.uidnext, highestModseq: r.highest_modseq },
    ]),
  );
}

async function lockBlob(tx: Tx, sha256: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-blob:' + sha256}, 0))`;
}

/**
 * Wake whoever watches the mailbox — IMAP IDLE sessions in every daemon process and the webmail's
 * live updates (PST-REQ-073). Inside the transaction, so it is delivered on commit and never for a
 * change that rolled back.
 */
async function notifyMailbox(tx: Tx, mailboxId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${mailboxId})`;
}

/**
 * Lowercase, strip a `+tag` from the local part, and strip a trailing dot from the domain — the same
 * normalization @postroom/classifier's `normalizeAddress` applies (kept local to avoid a new
 * workspace dependency; PST-T-5.8, PST-REQ-102).
 */
function normalizeCorrespondentAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  const domain = trimmed.slice(at + 1).replace(/\.+$/, '');
  return `${local}@${domain}`;
}

/**
 * A client filing its own copy into \Sent (rather than sending through acceptSubmission) still
 * counts as writing to its To/Cc addresses (PST-T-5.8, PST-REQ-102): upsert the correspondent table
 * the same way, in the same transaction as the APPEND.
 */
async function harvestSentRecipients(tx: Tx, accountId: string, addresses: readonly string[], sentAt: Date): Promise<void> {
  const normalized = new Set(addresses.map(normalizeCorrespondentAddress).filter((a) => a !== ''));
  for (const address of normalized) {
    await tx.correspondent.upsert({
      where: { accountId_address: { accountId, address } },
      create: { accountId, address, firstWrittenAt: sentAt, lastWrittenAt: sentAt, count: 1 },
      update: { lastWrittenAt: sentAt, count: { increment: 1 } },
    });
  }
}

/**
 * QRESYNC's VANISHED (EARLIER) record: the UIDs a transaction removed from a mailbox and the modseq
 * that removal was given, in expunged_message (primary key (mailbox_id, uid)).
 */
async function recordExpunged(tx: Tx, mailboxId: string, uids: readonly number[], modseq: bigint): Promise<void> {
  if (uids.length === 0) return;
  // A UID is never reused within a UIDVALIDITY, so a second insert for the same (mailbox, uid) can
  // only come from a replay of the same removal; keep the first.
  await tx.expungedMessage.createMany({
    data: uids.map((uid) => ({ mailboxId, uid, modseq })),
    skipDuplicates: true,
  });
}

/** One bayes_training_event per moved message (PST-REQ-104), in the move's transaction. */
async function recordTraining(
  tx: Tx,
  accountId: string,
  move: TrainingMove,
  via: 'imap-move' | 'imap-copy-expunge',
  messages: readonly { messageId: string; blobSha256: string }[],
): Promise<void> {
  if (messages.length === 0) return;
  await tx.bayesTrainingEvent.createMany({
    data: messages.map((m) => ({ accountId, messageId: m.messageId, blobSha256: m.blobSha256, fromBucket: move.fromBucket, toBucket: move.toBucket, via })),
  });
}

/**
 * COPY then EXPUNGE is how a client without MOVE moves a message: when an expunged message's bytes
 * (the same blob — a COPY shares it) already sit in another mailbox of the account that is a
 * different bucket, the user moved it there. The newest such copy is the one trained. A message
 * expunged with no copy elsewhere, or whose copy is not in a bucket (Trash, Archive), teaches nothing.
 */
async function recordCopyMoves(tx: Tx, accountId: string, sourceId: string, blobs: readonly string[]): Promise<void> {
  const src = await tx.$queryRaw<{ name: string; special_use: SpecialUse | null }[]>`
    SELECT name, special_use FROM mailbox WHERE id = ${sourceId}::uuid`;
  const source = src[0];
  if (source === undefined || blobs.length === 0) return;
  const copies = await tx.$queryRaw<{ id: string; blob_sha256: string; name: string; special_use: SpecialUse | null }[]>`
    SELECT m.id::text AS id, m.blob_sha256, mb.name, mb.special_use
    FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
    WHERE mb.account_id = ${accountId}::uuid AND m.mailbox_id <> ${sourceId}::uuid AND m.blob_sha256 = ANY(${[...new Set(blobs)]}::text[])
    ORDER BY m.received_at DESC, m.id`;
  const done = new Set<string>();
  for (const c of copies) {
    if (done.has(c.blob_sha256)) continue;
    const move = trainingMove({ name: source.name, specialUse: source.special_use }, { name: c.name, specialUse: c.special_use });
    if (move === null) continue;
    done.add(c.blob_sha256);
    await recordTraining(tx, accountId, move, 'imap-copy-expunge', [{ messageId: c.id, blobSha256: c.blob_sha256 }]);
  }
}
