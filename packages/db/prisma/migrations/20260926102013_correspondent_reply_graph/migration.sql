-- PST-T-5.8 (PST-REQ-102): a per-account correspondent table (address, first/last written, count),
-- indexed by (account_id, address), replacing classify.ts's OutboundRecipient scan and MessageSearch
-- substring fallback with one indexed lookup.

-- CreateTable
CREATE TABLE "correspondent" (
    "account_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "first_written_at" TIMESTAMPTZ(6) NOT NULL,
    "last_written_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "correspondent_pkey" PRIMARY KEY ("account_id","address")
);

-- AddForeignKey
ALTER TABLE "correspondent" ADD CONSTRAINT "correspondent_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from every OutboundRecipient sent so far, aggregated per (account, lowercased address).
-- Idempotent: ON CONFLICT DO NOTHING, so running this twice (e.g. a re-run of a partially applied
-- migration) never double-counts — the aggregate already reflects every row at the time it runs.
INSERT INTO "correspondent" ("account_id", "address", "first_written_at", "last_written_at", "count")
SELECT
    m.account_id,
    lower(r.address) AS address,
    min(m.created_at) AS first_written_at,
    max(m.created_at) AS last_written_at,
    count(*)::int AS count
FROM "outbound_recipient" r
JOIN "outbound_message" m ON m.id = r.outbound_message_id
GROUP BY m.account_id, lower(r.address)
ON CONFLICT ("account_id", "address") DO NOTHING;
