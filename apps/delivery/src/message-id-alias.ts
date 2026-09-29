// Message-ID aliases (PST-T-11.20): SES replaces the Message-ID of every message it relays and
// names its own in the 250 to DATA. A reply from outside then cites SES's id in In-Reply-To and
// References, which no message of ours carries, so it would start a new thread. The worker records
// SES's id as an alias of ours, in the same commit as the delivered outcome, and @postroom/threading
// resolves an alias to our id when it assigns a thread.
import { recordAudit, type RequestContext } from '@postroom/audit';
import type { Db, Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient | Db;

/** A Message-ID as Message.messageIdHeader stores it: unfolded, trimmed, without angle brackets. */
export function normalizeMessageId(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
  return (/^<([^>]*)>$/.exec(unfolded)?.[1] ?? unfolded).trim();
}

export interface MessageIdAliasInput {
  /** The relay-assigned id, normalized (sesMessageIdFromReply). */
  alias: string;
  /** Our Message-ID header for the message, as stored on OutboundMessage (`<id>`). */
  messageIdHeader: string;
  outboundMessageId: string;
  /** Who assigned it: 'ses'. */
  source: string;
  /** The recipient whose delivered attempt carried it, for the audit row's request id. */
  recipientId: string;
  at: Date;
}

/**
 * Insert the alias and audit it, through `tx` (the worker's outcome transaction). Idempotent: one
 * SES transaction to several recipients gives one id, recorded once; a replayed attempt is a no-op
 * and writes no second audit row. An alias already mapped elsewhere is never repointed. Returns
 * whether a row was written.
 */
export async function recordMessageIdAlias(tx: Tx, input: MessageIdAliasInput): Promise<boolean> {
  const messageId = normalizeMessageId(input.messageIdHeader);
  if (messageId === '' || input.alias === '' || messageId === input.alias) return false;
  const rows = await tx.$queryRaw<{ alias: string }[]>`
    INSERT INTO message_id_alias (alias, message_id, source, outbound_message_id, created_at)
    VALUES (${input.alias}, ${messageId}, ${input.source}, ${input.outboundMessageId}::uuid, ${input.at})
    ON CONFLICT (alias) DO NOTHING
    RETURNING alias`;
  if (rows.length === 0) return false;
  await recordAudit(tx, {
    actor: { kind: 'system', label: 'delivery' },
    action: 'message_id_alias.add',
    entityType: 'message_id_alias',
    entityId: input.alias,
    before: null,
    after: { alias: input.alias, messageId, source: input.source, outboundMessageId: input.outboundMessageId },
    context: { requestId: `delivery:${input.recipientId}` } satisfies RequestContext,
  });
  return true;
}
