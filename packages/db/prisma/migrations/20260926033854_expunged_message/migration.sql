-- CreateTable
CREATE TABLE "expunged_message" (
    "mailbox_id" UUID NOT NULL,
    "uid" INTEGER NOT NULL,
    "modseq" BIGINT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expunged_message_pkey" PRIMARY KEY ("mailbox_id","uid")
);

-- CreateIndex
CREATE INDEX "expunged_message_mailbox_id_modseq_idx" ON "expunged_message"("mailbox_id", "modseq");

-- AddForeignKey
ALTER TABLE "expunged_message" ADD CONSTRAINT "expunged_message_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

