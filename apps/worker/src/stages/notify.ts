// Stage 6, notify: wake whoever watches the mailboxes that just changed. `pg_notify` on the
// `postroom_mailbox` channel with the mailbox id as payload — IMAP IDLE (PST-P-3) and the web
// app's live updates LISTEN there. A NOTIFY is only a hint (they re-read state when woken), so
// sending it again on a replay is harmless, and that is what makes this stage idempotent.
import type { Db } from '@postroom/db';
import type { FileResult, NotifyResult } from './types.js';

export const MAILBOX_CHANNEL = 'postroom_mailbox';

export async function notifyStage(db: Db, filed: FileResult): Promise<NotifyResult> {
  const mailboxes = [...new Set(filed.copies.map((c) => c.mailboxId))].sort();
  for (const id of mailboxes) {
    await db.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${id})`;
  }
  return { mailboxes };
}
