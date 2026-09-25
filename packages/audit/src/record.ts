import { ActorKind, type Db, type Prisma } from '@postroom/db';
import { redact } from './redact.js';
import type { Actor, RequestContext } from './types.js';

export type AuditTx = Prisma.TransactionClient | Db;

export interface AuditInput {
  readonly actor: Actor;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly context?: RequestContext;
}

/** Writes one append-only audit_event row, redacting secrets out of `before`/`after`. */
export async function recordAudit(tx: AuditTx, event: AuditInput): Promise<void> {
  const before = event.before === undefined ? undefined : (redact(event.before) as Prisma.InputJsonValue);
  const after = event.after === undefined ? undefined : (redact(event.after) as Prisma.InputJsonValue);
  await tx.auditEvent.create({
    data: {
      actorKind: event.actor.kind === 'account' ? ActorKind.account : event.actor.kind,
      actorAccountId: event.actor.kind === 'account' ? event.actor.accountId : null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ip: event.context?.ip ?? null,
      userAgent: event.context?.userAgent ?? null,
      requestId: event.context?.requestId ?? null,
    },
  });
}
