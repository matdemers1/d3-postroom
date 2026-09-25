-- CreateEnum
CREATE TYPE "inbound_state" AS ENUM ('spooled', 'processing', 'filed', 'rejected', 'failed');

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "from_address" TEXT,
ADD COLUMN     "inbound_message_id" UUID,
ADD COLUMN     "message_id_header" TEXT,
ADD COLUMN     "sent_at" TIMESTAMPTZ(6),
ADD COLUMN     "subject" TEXT;

-- CreateTable
CREATE TABLE "inbound_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "client_ip" TEXT NOT NULL,
    "proxied" BOOLEAN NOT NULL DEFAULT false,
    "helo" TEXT,
    "rdns" TEXT,
    "tls" TEXT,

    CONSTRAINT "inbound_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "envelope_from" TEXT NOT NULL,
    "recipients" JSONB NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "state" "inbound_state" NOT NULL DEFAULT 'spooled',
    "verdicts" JSONB NOT NULL DEFAULT '{}',
    "disposition" TEXT NOT NULL DEFAULT 'accept',
    "disposition_reason" TEXT,
    "smtp_reply" TEXT,
    "last_error" TEXT,
    "filed_at" TIMESTAMPTZ(6),

    CONSTRAINT "inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_verdict" (
    "message_id" UUID NOT NULL,
    "auth" JSONB NOT NULL DEFAULT '{}',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "bucket" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_verdict_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "greylist_entry" (
    "key" TEXT NOT NULL,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "greylist_entry_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "inbound_session_started_at_idx" ON "inbound_session"("started_at");

-- CreateIndex
CREATE INDEX "inbound_session_client_ip_started_at_idx" ON "inbound_session"("client_ip", "started_at");

-- CreateIndex
CREATE INDEX "inbound_message_state_received_at_idx" ON "inbound_message"("state", "received_at");

-- CreateIndex
CREATE INDEX "greylist_entry_expires_at_idx" ON "greylist_entry"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_mailbox_id_inbound_message_id_key" ON "message"("mailbox_id", "inbound_message_id");

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "inbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "inbound_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_verdict" ADD CONSTRAINT "message_verdict_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written invariants ─────────────────────────────────────────────────────────────────────
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_disposition" CHECK ("disposition" IN ('accept', 'reject', 'quarantine'));
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_size_nonneg" CHECK ("size" >= 0);
