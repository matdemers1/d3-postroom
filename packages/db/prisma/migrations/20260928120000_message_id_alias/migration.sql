-- CreateTable
CREATE TABLE "message_id_alias" (
    "alias" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "outbound_message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_id_alias_pkey" PRIMARY KEY ("alias")
);

-- CreateIndex
CREATE INDEX "message_id_alias_message_id_idx" ON "message_id_alias"("message_id");

-- CreateIndex
CREATE INDEX "message_id_alias_outbound_message_id_idx" ON "message_id_alias"("outbound_message_id");

-- AddForeignKey
ALTER TABLE "message_id_alias" ADD CONSTRAINT "message_id_alias_outbound_message_id_fkey" FOREIGN KEY ("outbound_message_id") REFERENCES "outbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

