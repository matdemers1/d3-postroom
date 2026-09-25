import type { Db, Prisma } from '@postroom/db';
import { recordAudit } from './record.js';
import type { Actor, RequestContext } from './types.js';

export interface AuditedSpec {
  readonly action: string;
  readonly entityType: string;
  readonly context?: RequestContext;
}

export interface AuditedWrite<TResult> {
  readonly entityId: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly result: TResult;
}

/**
 * The one way domain writes happen: runs `fn` inside a transaction and writes its audit row in the
 * same transaction, so a failed audit rolls back the mutation and a failed mutation never reaches
 * the audit table. Returns `fn`'s result.
 */
export async function audited<TResult>(
  db: Db,
  actor: Actor,
  spec: AuditedSpec,
  fn: (tx: Prisma.TransactionClient) => Promise<AuditedWrite<TResult>>,
): Promise<TResult> {
  return db.$transaction(async (tx) => {
    const write = await fn(tx);
    await recordAudit(tx, {
      actor,
      action: spec.action,
      entityType: spec.entityType,
      entityId: write.entityId,
      before: write.before,
      after: write.after,
      ...(spec.context !== undefined ? { context: spec.context } : {}),
    });
    return write.result;
  });
}
