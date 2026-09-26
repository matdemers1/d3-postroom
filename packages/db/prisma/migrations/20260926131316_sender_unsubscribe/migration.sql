-- PST-T-5.6 (PST-REQ-110): one-click unsubscribe (RFC 8058) results, recorded on the sender's pin
-- row. Purely additive — no existing column touched, no data migrated.

-- AlterTable
ALTER TABLE "sender_pin"
  ADD COLUMN "unsubscribed_at" TIMESTAMPTZ(6),
  ADD COLUMN "unsubscribe_method" TEXT,
  ADD COLUMN "unsubscribe_result" TEXT,
  ADD COLUMN "unsubscribe_detail" TEXT;
