-- CreateTable
CREATE TABLE "bayes_training_event" (
    "id" BIGSERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "from_bucket" TEXT NOT NULL,
    "to_bucket" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "outcome" TEXT,

    CONSTRAINT "bayes_training_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bayes_trained_message" (
    "account_id" UUID NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "tokens" TEXT[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bayes_trained_message_pkey" PRIMARY KEY ("account_id","blob_sha256")
);

-- CreateTable
CREATE TABLE "bayes_token" (
    "account_id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "bayes_token_pkey" PRIMARY KEY ("account_id","bucket","token")
);

-- CreateTable
CREATE TABLE "bayes_bucket_total" (
    "account_id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "docs" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bayes_bucket_total_pkey" PRIMARY KEY ("account_id","bucket")
);

-- CreateIndex
CREATE INDEX "bayes_training_event_processed_at_id_idx" ON "bayes_training_event"("processed_at", "id");

-- CreateIndex
CREATE INDEX "bayes_training_event_account_id_idx" ON "bayes_training_event"("account_id");

-- CreateIndex
CREATE INDEX "bayes_token_account_id_token_idx" ON "bayes_token"("account_id", "token");

-- AddForeignKey
ALTER TABLE "bayes_training_event" ADD CONSTRAINT "bayes_training_event_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bayes_trained_message" ADD CONSTRAINT "bayes_trained_message_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bayes_token" ADD CONSTRAINT "bayes_token_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bayes_bucket_total" ADD CONSTRAINT "bayes_bucket_total_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

