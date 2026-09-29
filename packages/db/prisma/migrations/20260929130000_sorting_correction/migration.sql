-- PST-T-14.9: sorting corrections — a move plus a recorded sender preference, listed in Settings → Rules with Undo.

-- CreateTable
CREATE TABLE "sorting_correction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "from_bucket" TEXT,
    "to_bucket" TEXT NOT NULL,
    "message_id" UUID,
    "from_mailbox_id" UUID,
    "from_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "from_address" TEXT,
    "previous_pin" TEXT,
    "previous_pin_row" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chip',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ(6),

    CONSTRAINT "sorting_correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sorting_correction_account_id_created_at_idx" ON "sorting_correction"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "sorting_correction" ADD CONSTRAINT "sorting_correction_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

