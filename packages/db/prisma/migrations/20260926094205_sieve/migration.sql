-- PST-T-9.5 (PST-REQ-148, PST-REQ-149, PST-REQ-150): Sieve scripts, stored by ManageSieve and the
-- webmail rules builder, and the vacation replies the sieve stage sent (RFC 5230 :days memory).

-- CreateTable
CREATE TABLE "sieve_script" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sieve_script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sieve_vacation_reply" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "inbound_message_id" UUID,
    "outbound_message_id" UUID,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sieve_vacation_reply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sieve_script_account_id_name_key" ON "sieve_script"("account_id", "name");

-- CreateIndex
CREATE INDEX "sieve_vacation_reply_account_id_sender_handle_sent_at_idx" ON "sieve_vacation_reply"("account_id", "sender", "handle", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "sieve_vacation_reply_account_id_inbound_message_id_key" ON "sieve_vacation_reply"("account_id", "inbound_message_id");

-- AddForeignKey
ALTER TABLE "sieve_script" ADD CONSTRAINT "sieve_script_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sieve_vacation_reply" ADD CONSTRAINT "sieve_vacation_reply_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one active script per account (RFC 5804 SETACTIVE). Prisma cannot express a partial
-- unique index, so it lives here; the stores set the new one active only after clearing the old.
CREATE UNIQUE INDEX "sieve_script_one_active_per_account" ON "sieve_script"("account_id") WHERE "active";

-- A script name is 1-128 characters with no control characters (RFC 5804 §1.6), whatever wrote it.
ALTER TABLE "sieve_script" ADD CONSTRAINT "sieve_script_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 128 AND "name" !~ '[\x01-\x1f\x7f]');
