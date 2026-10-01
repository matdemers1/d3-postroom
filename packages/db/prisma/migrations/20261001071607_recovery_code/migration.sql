-- PST-T-16.7 (PST-REQ-197): single-use TOTP recovery codes. Ten per account, issued when TOTP
-- enrolment completes and again on regeneration (which deletes the old set in the same
-- transaction). Only the peppered Argon2id hash is stored. A code is spent by a conditional
-- update (`WHERE used_at IS NULL`), so two concurrent uses of one code cannot both win.

-- CreateTable
CREATE TABLE "recovery_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_code_account_id_idx" ON "recovery_code"("account_id");

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
