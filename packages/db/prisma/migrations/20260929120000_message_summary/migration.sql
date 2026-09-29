-- PST-T-14.2: list summaries carry the sender's display name and a one-line snippet.
-- AlterTable
ALTER TABLE "message" ADD COLUMN     "from_name" TEXT,
ADD COLUMN     "snippet" TEXT;

-- The worker's summary sweep walks the rows not yet summarised (snippet IS NULL) by id: existing
-- mail after this migration, and anything a filing path left for it. A partial index keeps that
-- lookup cheap once the backfill is done and the set is (nearly) empty.
-- Built inside the migration's transaction (Prisma cannot run CREATE INDEX CONCURRENTLY there), so
-- it holds a SHARE lock on message while it builds: writes to message wait for it. At the expected
-- size — tens of thousands of rows on a single-operator server — that is a sub-second pause during
-- the deploy, which is acceptable; a table orders of magnitude larger would want a CONCURRENTLY
-- build outside the migration instead.
CREATE INDEX "message_summary_pending_idx" ON "message"("id") WHERE "snippet" IS NULL;
