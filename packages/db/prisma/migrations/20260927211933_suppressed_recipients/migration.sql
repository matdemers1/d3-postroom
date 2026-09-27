-- CreateTable
CREATE TABLE "suppressed_recipient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "code" INTEGER,
    "enhanced" TEXT,
    "text" TEXT,
    "source_recipient_id" UUID,
    "bounce_count" INTEGER NOT NULL DEFAULT 1,
    "first_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_account_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressed_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppressed_recipient_address_key" ON "suppressed_recipient"("address");

-- CreateIndex
CREATE INDEX "suppressed_recipient_last_at_idx" ON "suppressed_recipient"("last_at");

-- AddForeignKey
ALTER TABLE "suppressed_recipient" ADD CONSTRAINT "suppressed_recipient_source_recipient_id_fkey" FOREIGN KEY ("source_recipient_id") REFERENCES "outbound_recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
