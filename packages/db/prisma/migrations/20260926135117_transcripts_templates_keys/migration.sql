-- CreateTable
CREATE TABLE "smtp_transcript" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "daemon" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "client_ip" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "raw_bytes" INTEGER NOT NULL DEFAULT 0,
    "compressed_bytes" INTEGER NOT NULL DEFAULT 0,
    "compression" TEXT NOT NULL,
    "body" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smtp_transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compose_template" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compose_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crypto_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "sealed_private" BYTEA,
    "wrapped_dek" BYTEA,
    "kek_id" TEXT,
    "nonce" BYTEA,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crypto_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "smtp_transcript_started_at_idx" ON "smtp_transcript"("started_at");

-- CreateIndex
CREATE INDEX "smtp_transcript_client_ip_started_at_idx" ON "smtp_transcript"("client_ip", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "smtp_transcript_daemon_session_id_key" ON "smtp_transcript"("daemon", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "compose_template_account_id_shortcut_key" ON "compose_template"("account_id", "shortcut");

-- CreateIndex
CREATE INDEX "crypto_key_account_id_address_idx" ON "crypto_key"("account_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_key_account_id_kind_fingerprint_key" ON "crypto_key"("account_id", "kind", "fingerprint");

-- AddForeignKey
ALTER TABLE "compose_template" ADD CONSTRAINT "compose_template_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_key" ADD CONSTRAINT "crypto_key_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

