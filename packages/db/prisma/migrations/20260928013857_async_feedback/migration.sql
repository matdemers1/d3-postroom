-- CreateTable
CREATE TABLE "delivery_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "address" TEXT,
    "outbound_message_id" UUID,
    "outbound_recipient_id" UUID,
    "inbound_message_id" UUID,
    "status" TEXT,
    "feedback_type" TEXT,
    "diagnostic" TEXT,
    "action" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "reported_at" TIMESTAMPTZ(6) NOT NULL,
    "alerted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_feedback_dedupe_key_key" ON "delivery_feedback"("dedupe_key");

-- CreateIndex
CREATE INDEX "delivery_feedback_outbound_message_id_idx" ON "delivery_feedback"("outbound_message_id");

-- CreateIndex
CREATE INDEX "delivery_feedback_kind_created_at_idx" ON "delivery_feedback"("kind", "created_at");

-- AddForeignKey
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_outbound_message_id_fkey" FOREIGN KEY ("outbound_message_id") REFERENCES "outbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_outbound_recipient_id_fkey" FOREIGN KEY ("outbound_recipient_id") REFERENCES "outbound_recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "inbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
