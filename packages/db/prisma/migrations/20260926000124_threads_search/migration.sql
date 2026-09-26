CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "in_reply_to" TEXT,
ADD COLUMN     "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "thread_id" UUID;

-- CreateTable
CREATE TABLE "thread" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "subject" TEXT,
    "base_subject" TEXT,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_search" (
    "message_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "from_text" TEXT NOT NULL DEFAULT '',
    "to_text" TEXT NOT NULL DEFAULT '',
    "body_text" TEXT NOT NULL DEFAULT '',
    "has_attachment" BOOLEAN NOT NULL DEFAULT false,
    "attachment_names" TEXT NOT NULL DEFAULT '',
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("subject", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("from_text", '') || ' ' || coalesce("to_text", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("attachment_names", '')), 'C') ||
        setweight(to_tsvector('simple', coalesce("body_text", '')), 'D')
    ) STORED,

    CONSTRAINT "message_search_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "thread_account_id_last_message_at_idx" ON "thread"("account_id", "last_message_at");

-- CreateIndex
CREATE INDEX "thread_account_id_base_subject_idx" ON "thread"("account_id", "base_subject");

-- CreateIndex
CREATE INDEX "message_search_account_id_idx" ON "message_search"("account_id");

-- CreateIndex
CREATE INDEX "message_thread_id_idx" ON "message"("thread_id");

-- CreateIndex
CREATE INDEX "message_message_id_header_idx" ON "message"("message_id_header");

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written: search indexes (PST-T-3.7) ───────────────────────────────────────────────────
-- Word search over the generated tsvector, and trigram indexes for substring / fuzzy matches on
-- the fields people search by name. 'simple' config: no stemming, so every language behaves alike.
CREATE INDEX "message_search_tsv_idx" ON "message_search" USING GIN ("tsv");
CREATE INDEX "message_search_subject_trgm_idx" ON "message_search" USING GIN ("subject" gin_trgm_ops);
CREATE INDEX "message_search_from_trgm_idx" ON "message_search" USING GIN ("from_text" gin_trgm_ops);
CREATE INDEX "message_search_body_trgm_idx" ON "message_search" USING GIN ("body_text" gin_trgm_ops);
ALTER TABLE "thread" ADD CONSTRAINT "thread_message_count_nonneg" CHECK ("message_count" >= 0);
