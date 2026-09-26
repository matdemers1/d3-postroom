-- PST-T-9.1: undo send and scheduled send (PST-REQ-140, PST-REQ-141), snoozed threads
-- (PST-REQ-142) and remind-if-no-reply (PST-REQ-143). Additive only: three new tables and one enum.

-- CreateEnum
CREATE TYPE "pending_send_state" AS ENUM ('held', 'released', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "pending_send" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "pending_send_state" NOT NULL DEFAULT 'held',
    "release_at" TIMESTAMPTZ(6) NOT NULL,
    "envelope_from" TEXT NOT NULL,
    "recipients" TEXT[],
    "held_blob_sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "draft_message_id" UUID,
    "message_id_header" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "to_text" TEXT NOT NULL DEFAULT '',
    "in_reply_to" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remind_after_seconds" INTEGER,
    "outbound_id" UUID,
    "sent_message_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "pending_send_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snoozed_thread" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "until" TIMESTAMPTZ(6) NOT NULL,
    "message_ids" UUID[],
    "state" TEXT NOT NULL DEFAULT 'snoozed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returned_at" TIMESTAMPTZ(6),

    CONSTRAINT "snoozed_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_reminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "sent_message_id" UUID NOT NULL,
    "message_id_header" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "resurfaced_message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMPTZ(6),

    CONSTRAINT "reply_reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_send_state_release_at_idx" ON "pending_send"("state", "release_at");

-- CreateIndex
CREATE INDEX "pending_send_account_id_state_idx" ON "pending_send"("account_id", "state");

-- CreateIndex
CREATE INDEX "snoozed_thread_state_until_idx" ON "snoozed_thread"("state", "until");

-- CreateIndex
CREATE INDEX "snoozed_thread_account_id_thread_id_idx" ON "snoozed_thread"("account_id", "thread_id");

-- CreateIndex
CREATE INDEX "reply_reminder_state_due_at_idx" ON "reply_reminder"("state", "due_at");

-- CreateIndex
CREATE INDEX "reply_reminder_account_id_sent_message_id_idx" ON "reply_reminder"("account_id", "sent_message_id");

-- AddForeignKey
ALTER TABLE "pending_send" ADD CONSTRAINT "pending_send_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snoozed_thread" ADD CONSTRAINT "snoozed_thread_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_reminder" ADD CONSTRAINT "reply_reminder_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

