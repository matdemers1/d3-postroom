-- CreateEnum
CREATE TYPE "account_kind" AS ENUM ('person', 'service');

-- CreateEnum
CREATE TYPE "dkim_algorithm" AS ENUM ('rsa-sha256', 'ed25519-sha256');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('pending', 'running', 'done', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "recipient_state" AS ENUM ('queued', 'attempting', 'deferred', 'delivered', 'bounced', 'cancelled');

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "kind" "account_kind" NOT NULL DEFAULT 'person';

-- AlterTable
ALTER TABLE "app_password" ADD COLUMN     "daily_recipient_cap" INTEGER,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "dkim_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_id" UUID NOT NULL,
    "selector" TEXT NOT NULL,
    "algorithm" "dkim_algorithm" NOT NULL,
    "dns_record" TEXT NOT NULL,
    "sealed_private" BYTEA NOT NULL,
    "kek_id" TEXT NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dkim_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'pending',
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 10,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "last_error" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "app_password_id" UUID,
    "envelope_from" TEXT NOT NULL,
    "header_from" TEXT NOT NULL,
    "message_id" TEXT,
    "subject" TEXT,
    "blob_sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "dsn_ret" TEXT,
    "dsn_envid" TEXT,
    "submitted_via" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_recipient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "outbound_message_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "state" "recipient_state" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_code" INTEGER,
    "last_enhanced" TEXT,
    "last_text" TEXT,
    "delivered_at" TIMESTAMPTZ(6),
    "delay_dsn_sent_at" TIMESTAMPTZ(6),
    "failure_dsn_sent_at" TIMESTAMPTZ(6),
    "dsn_notify" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'direct',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "transport" TEXT NOT NULL,
    "mx_host" TEXT,
    "mx_ip" TEXT,
    "local_ip" TEXT,
    "tls_version" TEXT,
    "tls_cipher" TEXT,
    "tls_peer" TEXT,
    "remote_code" INTEGER,
    "remote_enhanced" TEXT,
    "remote_text" TEXT,
    "outcome" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dkim_key_domain_id_selector_key" ON "dkim_key"("domain_id", "selector");

-- CreateIndex
CREATE UNIQUE INDEX "job_idempotency_key_key" ON "job"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_queue_status_run_at_idx" ON "job"("queue", "status", "run_at");

-- CreateIndex
CREATE INDEX "outbound_message_account_id_created_at_idx" ON "outbound_message"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_recipient_state_next_attempt_at_idx" ON "outbound_recipient"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbound_recipient_outbound_message_id_idx" ON "outbound_recipient"("outbound_message_id");

-- CreateIndex
CREATE INDEX "delivery_attempt_recipient_id_started_at_idx" ON "delivery_attempt"("recipient_id", "started_at");

-- AddForeignKey
ALTER TABLE "dkim_key" ADD CONSTRAINT "dkim_key_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_app_password_id_fkey" FOREIGN KEY ("app_password_id") REFERENCES "app_password"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_recipient" ADD CONSTRAINT "outbound_recipient_outbound_message_id_fkey" FOREIGN KEY ("outbound_message_id") REFERENCES "outbound_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "outbound_recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written invariants (Prisma does not model CHECKs or triggers) ─────────────────────────

ALTER TABLE "job" ADD CONSTRAINT "job_attempts_nonneg" CHECK ("attempts" >= 0 AND "max_attempts" >= 1);
ALTER TABLE "outbound_recipient" ADD CONSTRAINT "outbound_recipient_attempts_nonneg" CHECK ("attempts" >= 0);
ALTER TABLE "outbound_recipient" ADD CONSTRAINT "outbound_recipient_address_lower" CHECK ("domain" = lower("domain"));
ALTER TABLE "outbound_recipient" ADD CONSTRAINT "outbound_recipient_transport" CHECK ("transport" IN ('direct', 'ses'));
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_outcome" CHECK ("outcome" IN ('delivered', 'deferred', 'bounced', 'error'));
ALTER TABLE "dkim_key" ADD CONSTRAINT "dkim_key_selector" CHECK ("selector" ~ '^[a-z0-9][a-z0-9-]{0,62}$');
ALTER TABLE "app_password" ADD CONSTRAINT "app_password_cap_positive" CHECK ("daily_recipient_cap" IS NULL OR "daily_recipient_cap" > 0);

-- A worker blocked in LISTEN wakes as soon as work is enqueued, instead of polling (PST-T-2.7).
CREATE FUNCTION "job_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('postroom_job', NEW."queue");
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_notify" AFTER INSERT ON "job" FOR EACH ROW EXECUTE FUNCTION "job_notify"();
