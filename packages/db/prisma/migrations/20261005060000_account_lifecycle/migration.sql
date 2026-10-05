-- Account lifecycle for the D3 App contract (PST-T-20.2, PST-T-20.3). Expand only: two nullable
-- columns on account and one new table.

-- A deletion the account asked for: disabled now, purged (mailbox crypto-shredded) after delete_after.
ALTER TABLE "account" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(6),
ADD COLUMN "delete_after" TIMESTAMPTZ(6);

-- Invitations to make an account. Only the token's SHA-256 is stored.
CREATE TABLE "account_invite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "local_part" TEXT NOT NULL,
    "display_name" TEXT,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "account_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "account_invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_invite_token_hash_key" ON "account_invite"("token_hash");
CREATE INDEX "account_invite_created_at_idx" ON "account_invite"("created_at");
CREATE INDEX "account_invite_account_id_idx" ON "account_invite"("account_id");

ALTER TABLE "account_invite" ADD CONSTRAINT "account_invite_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "account_invite" ADD CONSTRAINT "account_invite_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "account_invite" ADD CONSTRAINT "account_invite_local_part_lowercase" CHECK ("local_part" = lower("local_part") AND length("local_part") > 0);
