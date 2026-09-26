// Cancelling a recipient (undo send, or an operator pulling a message). Only `queued` and
// `deferred` recipients can be cancelled: one in flight may already be on the remote's disk, and a
// final state is final. The result has the shape @postroom/audit's audited() expects, so the API
// (PST-T-1.13) records it as an operator action:
//
//   audited(db, actor, { action: 'outbound.recipient.cancel', entityType: 'outbound_recipient' },
//     (tx) => cancelRecipient(tx, id))
import type { Db, OutboundRecipient, Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient | Db;

export class CannotCancelError extends Error {
  constructor(readonly recipientId: string, readonly state: string | null) {
    super(state === null ? `outbound recipient ${recipientId} does not exist` : `outbound recipient ${recipientId} is ${state} and cannot be cancelled`);
    this.name = 'CannotCancelError';
  }
}

export interface CancelWrite {
  entityId: string;
  before: Pick<OutboundRecipient, 'state' | 'attempts' | 'nextAttemptAt'>;
  after: Pick<OutboundRecipient, 'state' | 'attempts' | 'nextAttemptAt'>;
  result: OutboundRecipient;
}

/** Move a queued/deferred recipient to cancelled; throws CannotCancelError otherwise (rolling back an audited() write). */
export async function cancelRecipient(tx: Tx, id: string, options: { now?: Date } = {}): Promise<CancelWrite> {
  const before = await tx.outboundRecipient.findUnique({ where: { id } });
  if (before === null) throw new CannotCancelError(id, null);
  // Guarded on the state, not on what we read: a worker may claim it between the read and here.
  const moved = await tx.outboundRecipient.updateMany({
    where: { id, state: { in: ['queued', 'deferred'] } },
    data: { state: 'cancelled', updatedAt: options.now ?? new Date() },
  });
  if (moved.count === 0) {
    const now = await tx.outboundRecipient.findUnique({ where: { id }, select: { state: true } });
    throw new CannotCancelError(id, now?.state ?? null);
  }
  const after = await tx.outboundRecipient.findUniqueOrThrow({ where: { id } });
  const pick = (r: OutboundRecipient): CancelWrite['before'] => ({ state: r.state, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt });
  return { entityId: id, before: pick(before), after: pick(after), result: after };
}
