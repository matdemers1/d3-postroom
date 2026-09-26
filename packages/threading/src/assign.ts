// Incremental thread assignment for messages arriving one at a time (PST-REQ-078): find the
// thread by Message-ID/References/In-Reply-To linkage against the same account's other messages,
// falling back to base subject + overlapping participants within 14 days only when the message
// carries no References and no In-Reply-To at all.
import type { Db, Prisma } from '@postroom/db';
import { baseSubject, normalizeMsgId } from './jwz.js';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export interface AssignThreadInput {
  accountId: string;
  /** The already-inserted Message row this assignment is for. */
  messageId: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  from: string;
  to: string;
  date: Date;
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => {
      const angle = /<([^>]+)>/.exec(part);
      const addr = angle?.[1] ?? part;
      return addr.trim().toLowerCase();
    })
    .filter((a) => a.length > 0);
}

function participantsOf(from: string, to: string): Set<string> {
  return new Set([...splitAddresses(from), ...splitAddresses(to)]);
}

/** Assign (or create) the thread for one message, inside its own transaction. Safe for concurrent
 * callers on the same account: a per-account advisory lock (held only for this transaction)
 * serializes assignment so two concurrent replies to the same root can't each create a thread, or
 * split one thread in half. */
export async function assignThread(db: Db, input: AssignThreadInput): Promise<string> {
  return db.$transaction(async (tx) => {
    // pg_advisory_xact_lock is released automatically at commit/rollback; hashtext(accountId)
    // keys it to this account only, so unrelated accounts never contend.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.accountId}))`;

    // Message-ID / References / In-Reply-To are stored normalized (no "<...>", no folding
    // whitespace) so that lookups and comparisons never depend on how a header happened to be
    // folded on the wire.
    const ownKey = input.messageIdHeader !== undefined ? normalizeMsgId(input.messageIdHeader) : undefined;
    const normalizedReferences = input.references.map(normalizeMsgId).filter((r) => r !== '');
    const normalizedInReplyTo = input.inReplyTo !== undefined ? normalizeMsgId(input.inReplyTo) : undefined;
    const refKeys = new Set<string>(normalizedReferences);
    if (normalizedInReplyTo !== undefined && normalizedInReplyTo !== '') refKeys.add(normalizedInReplyTo);
    const hasThreadingHeaders = input.references.length > 0 || input.inReplyTo !== undefined;

    const orClauses: Prisma.MessageWhereInput[] = [];
    if (refKeys.size > 0) orClauses.push({ messageIdHeader: { in: [...refKeys] } });
    if (ownKey !== undefined && ownKey !== '') {
      orClauses.push({ references: { has: ownKey } });
      orClauses.push({ inReplyTo: ownKey });
    }

    let threadIds: string[] = [];
    if (orClauses.length > 0) {
      const matches = await tx.message.findMany({
        where: {
          mailbox: { accountId: input.accountId },
          id: { not: input.messageId },
          threadId: { not: null },
          OR: orClauses,
        },
        select: { threadId: true },
      });
      threadIds = [...new Set(matches.map((m) => m.threadId).filter((t): t is string => t !== null))];
    }

    // The subject/participant fallback applies only when the message has no References and no
    // In-Reply-To at all (PST-REQ-078), never as a second chance after a header search comes up
    // empty.
    if (threadIds.length === 0 && !hasThreadingHeaders) {
      const base = baseSubject(input.subject);
      if (base !== '') {
        const participants = participantsOf(input.from, input.to);
        const windowStart = new Date(input.date.getTime() - FOURTEEN_DAYS_MS);
        const windowEnd = new Date(input.date.getTime() + FOURTEEN_DAYS_MS);
        const candidates = await tx.message.findMany({
          where: {
            mailbox: { accountId: input.accountId },
            id: { not: input.messageId },
            threadId: { not: null },
            thread: { baseSubject: base },
            sentAt: { gte: windowStart, lte: windowEnd },
          },
          select: { threadId: true, fromAddress: true },
        });
        const match = candidates.find((c) => c.fromAddress !== null && participants.has(c.fromAddress.toLowerCase()));
        if (match?.threadId !== null && match?.threadId !== undefined) threadIds = [match.threadId];
      }
    }

    let threadId: string;
    if (threadIds.length === 0) {
      const thread = await tx.thread.create({
        data: {
          accountId: input.accountId,
          subject: input.subject,
          baseSubject: baseSubject(input.subject),
          lastMessageAt: input.date,
          messageCount: 1,
        },
      });
      threadId = thread.id;
    } else {
      // Row-lock every thread this message touches (in a fixed order, by id, to avoid a
      // deadlock against a concurrent transaction locking the same set) before merging.
      const sorted = [...threadIds].sort();
      const rows = await tx.$queryRaw<{ id: string; created_at: Date; message_count: number; last_message_at: Date }[]>`
        SELECT id, created_at, message_count, last_message_at FROM thread WHERE id = ANY(${sorted}) ORDER BY id FOR UPDATE`;
      const byAge = [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      const target = byAge[0];
      if (target === undefined) {
        // The rows this message linked to were deleted concurrently (shouldn't happen under the
        // advisory lock, but fall back to a fresh thread rather than crash).
        const thread = await tx.thread.create({
          data: {
            accountId: input.accountId,
            subject: input.subject,
            baseSubject: baseSubject(input.subject),
            lastMessageAt: input.date,
            messageCount: 1,
          },
        });
        threadId = thread.id;
      } else {
        threadId = target.id;
        let mergedCount = target.message_count;
        let mergedLast = target.last_message_at;
        for (const other of byAge.slice(1)) {
          await tx.message.updateMany({ where: { threadId: other.id }, data: { threadId } });
          await tx.thread.delete({ where: { id: other.id } });
          mergedCount += other.message_count;
          if (other.last_message_at.getTime() > mergedLast.getTime()) mergedLast = other.last_message_at;
        }
        const nextLast = input.date.getTime() > mergedLast.getTime() ? input.date : mergedLast;
        await tx.thread.update({
          where: { id: threadId },
          data: { messageCount: mergedCount + 1, lastMessageAt: nextLast },
        });
      }
    }

    await tx.message.update({
      where: { id: input.messageId },
      data: {
        threadId,
        messageIdHeader: ownKey !== undefined && ownKey !== '' ? ownKey : null,
        inReplyTo: normalizedInReplyTo !== undefined && normalizedInReplyTo !== '' ? normalizedInReplyTo : null,
        references: normalizedReferences,
        subject: input.subject,
        fromAddress: splitAddresses(input.from)[0] ?? null,
        sentAt: input.date,
      },
    });

    return threadId;
  });
}
