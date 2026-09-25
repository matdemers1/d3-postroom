-- CreateEnum
CREATE TYPE "address_kind" AS ENUM ('primary', 'alias', 'masked', 'service');

-- CreateEnum
CREATE TYPE "special_use" AS ENUM ('inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'rejects');

-- CreateEnum
CREATE TYPE "app_password_scope" AS ENUM ('imap', 'smtp', 'dav', 'sieve');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('account', 'system', 'service', 'anonymous');

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "totp_secret" BYTEA,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "identity_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_password" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" "app_password_scope"[],
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_password_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_hash" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "step_up_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "domain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "local_part" TEXT NOT NULL,
    "domain_id" UUID NOT NULL,
    "kind" "address_kind" NOT NULL,
    "account_id" UUID,
    "site_tag" TEXT,
    "killed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address_target" (
    "address_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "address_target_pkey" PRIMARY KEY ("address_id","account_id")
);

-- CreateTable
CREATE TABLE "mailbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "special_use" "special_use",
    "uidvalidity" INTEGER NOT NULL,
    "uidnext" INTEGER NOT NULL DEFAULT 1,
    "highest_modseq" BIGINT NOT NULL DEFAULT 0,
    "subscribed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mailbox_id" UUID NOT NULL,
    "uid" INTEGER NOT NULL,
    "modseq" BIGINT NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "internal_date" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blob" (
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "kek_id" TEXT NOT NULL,
    "aead" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "refcount" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blob_pkey" PRIMARY KEY ("sha256")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_account_id" UUID,
    "actor_kind" "actor_kind" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_link_account_id_idx" ON "identity_link"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_link_issuer_subject_key" ON "identity_link"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "app_password_prefix_key" ON "app_password"("prefix");

-- CreateIndex
CREATE INDEX "app_password_account_id_idx" ON "app_password"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_id_hash_key" ON "session"("id_hash");

-- CreateIndex
CREATE INDEX "session_account_id_idx" ON "session"("account_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "domain_name_key" ON "domain"("name");

-- CreateIndex
CREATE INDEX "address_account_id_idx" ON "address"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "address_local_part_domain_id_key" ON "address"("local_part", "domain_id");

-- CreateIndex
CREATE INDEX "address_target_account_id_idx" ON "address_target"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_account_id_name_key" ON "mailbox"("account_id", "name");

-- CreateIndex
CREATE INDEX "message_mailbox_id_modseq_idx" ON "message"("mailbox_id", "modseq");

-- CreateIndex
CREATE INDEX "message_blob_sha256_idx" ON "message"("blob_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "message_mailbox_id_uid_key" ON "message"("mailbox_id", "uid");

-- CreateIndex
CREATE INDEX "audit_event_at_idx" ON "audit_event"("at");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_event_actor_account_id_idx" ON "audit_event"("actor_account_id");

-- AddForeignKey
ALTER TABLE "identity_link" ADD CONSTRAINT "identity_link_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_password" ADD CONSTRAINT "app_password_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address_target" ADD CONSTRAINT "address_target_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "address"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address_target" ADD CONSTRAINT "address_target_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_blob_sha256_fkey" FOREIGN KEY ("blob_sha256") REFERENCES "blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Hand-written invariants (Prisma does not model CHECKs or triggers) ─────────────────────────
-- A daemon writing raw SQL must not be able to break these either.

-- Names are stored lowercased (PST-T-0.4).
ALTER TABLE "domain" ADD CONSTRAINT "domain_name_lowercase" CHECK ("name" = lower("name") AND length("name") > 0);
ALTER TABLE "address" ADD CONSTRAINT "address_local_part_lowercase" CHECK ("local_part" = lower("local_part") AND length("local_part") > 0);

-- An alias fans out through address_target and has no single owner; every other kind has one.
ALTER TABLE "address" ADD CONSTRAINT "address_owner_by_kind" CHECK (
  ("kind" = 'alias' AND "account_id" IS NULL) OR ("kind" <> 'alias' AND "account_id" IS NOT NULL)
);

-- RFC 9051 / RFC 7162: UIDVALIDITY is a non-zero 32-bit value, UIDNEXT starts at 1, modseqs are unsigned.
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_uidvalidity_positive" CHECK ("uidvalidity" > 0);
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_uidnext_positive" CHECK ("uidnext" >= 1);
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_highest_modseq_nonnegative" CHECK ("highest_modseq" >= 0);
ALTER TABLE "message" ADD CONSTRAINT "message_uid_positive" CHECK ("uid" >= 1);
ALTER TABLE "message" ADD CONSTRAINT "message_modseq_nonnegative" CHECK ("modseq" >= 0);
ALTER TABLE "message" ADD CONSTRAINT "message_size_nonnegative" CHECK ("size" >= 0);

-- A protocol credential always names at least one protocol (PST-REQ-027).
ALTER TABLE "app_password" ADD CONSTRAINT "app_password_scopes_nonempty" CHECK ("scopes" IS NOT NULL AND cardinality("scopes") > 0);

-- Blobs are named by the lowercase hex SHA-256 of their plaintext (PST-REQ-012).
ALTER TABLE "blob" ADD CONSTRAINT "blob_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "blob" ADD CONSTRAINT "blob_refcount_nonnegative" CHECK ("refcount" >= 0);
ALTER TABLE "blob" ADD CONSTRAINT "blob_size_nonnegative" CHECK ("size" >= 0);

-- A stored blob is never modified other than its refcount (PST-REQ-012).
CREATE FUNCTION "blob_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."size" IS DISTINCT FROM OLD."size"
     OR NEW."wrapped_dek" IS DISTINCT FROM OLD."wrapped_dek"
     OR NEW."kek_id" IS DISTINCT FROM OLD."kek_id"
     OR NEW."aead" IS DISTINCT FROM OLD."aead"
     OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'blob % is immutable; only refcount may change', OLD."sha256" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "blob_immutable" BEFORE UPDATE ON "blob" FOR EACH ROW EXECUTE FUNCTION "blob_immutable"();

-- The audit log is append-only (PST-REQ-009). The one permitted update is the foreign key's own
-- ON DELETE SET NULL of actor_account_id, so removing an account never removes its history.
CREATE FUNCTION "audit_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actor_account_id" IS NOT NULL
     OR (to_jsonb(NEW) - 'actor_account_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_account_id') THEN
    RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "audit_event_append_only" BEFORE UPDATE OR DELETE ON "audit_event" FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();
