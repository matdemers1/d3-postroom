-- PST-T-5.4 (PST-REQ-105, PST-REQ-106): sender pins (bucket overrides the classifier) and the
-- new-sender screen (Allow/Block), one row per account and normalized sender address.

-- CreateTable
CREATE TABLE "sender_pin" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "bucket" TEXT,
    "screen" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_pin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sender_pin_account_id_idx" ON "sender_pin"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sender_pin_account_id_address_key" ON "sender_pin"("account_id", "address");

-- AddForeignKey
ALTER TABLE "sender_pin" ADD CONSTRAINT "sender_pin_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

