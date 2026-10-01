-- PST-T-16.12 (PST-REQ-199): Sent and Drafts name the recipients — a stored to-summary on the row.
-- AlterTable
ALTER TABLE "message" ADD COLUMN     "to_count" INTEGER,
ADD COLUMN     "to_name" TEXT;

-- The worker's to-summary sweep walks the rows not yet summarised (to_count IS NULL) by id: every
-- existing row after this migration, and anything a filing path left for it. A partial index keeps
-- that lookup cheap once the backfill is done and the set is (nearly) empty. Built inside the
-- migration's transaction, as message_summary_pending_idx was (20260929120000_message_summary): a
-- sub-second SHARE lock at a single-operator server's size.
CREATE INDEX "message_to_summary_pending_idx" ON "message"("id") WHERE "to_count" IS NULL;
