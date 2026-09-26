-- PST-T-5.1 (PST-REQ-101, PST-REQ-103): the scores behind every sorting decision, and the four
-- bucket folders for accounts created before they were default mailboxes.

-- AlterTable
ALTER TABLE "message_verdict" ADD COLUMN     "scores" JSONB NOT NULL DEFAULT '{}';

-- Backfill: every account that has the default mailboxes (it has an INBOX) gets Newsletters,
-- Updates, Receipts and Notifications — subscribed, no special use — unless it already has a
-- mailbox by that name. Idempotent (ON CONFLICT DO NOTHING); one system audit event per account
-- that gained a folder.
WITH buckets(name, ord) AS (
    VALUES ('Newsletters', 1), ('Updates', 2), ('Receipts', 3), ('Notifications', 4)
), created AS (
    INSERT INTO "mailbox" ("account_id", "name", "special_use", "uidvalidity", "subscribed")
    SELECT a."id", b."name", NULL, 1 + floor(random() * 2147483646)::int, true
    FROM "account" a
    CROSS JOIN buckets b
    WHERE EXISTS (SELECT 1 FROM "mailbox" m WHERE m."account_id" = a."id" AND m."special_use" = 'inbox')
    ORDER BY a."id", b."ord"
    ON CONFLICT ("account_id", "name") DO NOTHING
    RETURNING "account_id", "name", "uidvalidity"
)
INSERT INTO "audit_event" ("actor_kind", "action", "entity_type", "entity_id", "after")
SELECT 'system'::"actor_kind", 'mailbox.bucket_backfill', 'account', c."account_id"::text,
       jsonb_build_object('mailboxes', jsonb_agg(jsonb_build_object('name', c."name", 'uidvalidity', c."uidvalidity") ORDER BY c."name"))
FROM created c
GROUP BY c."account_id";
