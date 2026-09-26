-- PST-T-7.7 (PST-REQ-129, PST-REQ-130): retention policies with a Trash clock, and the release of a
-- spool row's blob reference so the last reference can go and the blob be crypto-shredded.

-- AlterTable
ALTER TABLE "inbound_message" ADD COLUMN     "blob_released_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "trashed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "retention_policy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retention_policy_mailbox_id_key" ON "retention_policy"("mailbox_id");

-- CreateIndex
CREATE INDEX "retention_policy_account_id_idx" ON "retention_policy"("account_id");

-- CreateIndex
CREATE INDEX "message_mailbox_id_received_at_idx" ON "message"("mailbox_id", "received_at");

-- CreateIndex
CREATE INDEX "message_mailbox_id_trashed_at_idx" ON "message"("mailbox_id", "trashed_at");

-- AddForeignKey
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written invariants (Prisma does not model CHECKs or triggers) ─────────────────────────

-- A policy keeps a message at least one day; null means forever.
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_days_positive" CHECK ("days" IS NULL OR "days" >= 1);

-- The Trash clock. Every surface puts messages into Trash differently — IMAP MOVE re-homes the row
-- (UPDATE mailbox_id), IMAP COPY and APPEND and the webmail's move insert a new row — so the stamp is
-- a trigger, not something each path must remember: a row arriving in a Trash mailbox gets
-- trashed_at = now() unless the statement set it itself (the retention sweep does, from its clock);
-- a row leaving Trash has it cleared.
CREATE FUNCTION "message_trashed_at"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  into_trash boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."mailbox_id" = OLD."mailbox_id" THEN
    RETURN NEW;
  END IF;
  SELECT "special_use" = 'trash' INTO into_trash FROM "mailbox" WHERE "id" = NEW."mailbox_id";
  IF into_trash IS TRUE THEN
    IF TG_OP = 'INSERT' THEN
      NEW."trashed_at" := COALESCE(NEW."trashed_at", now());
    ELSIF NEW."trashed_at" IS NOT DISTINCT FROM OLD."trashed_at" THEN
      NEW."trashed_at" := now();
    END IF;
  ELSE
    NEW."trashed_at" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "message_trashed_at" BEFORE INSERT OR UPDATE OF "mailbox_id" ON "message"
  FOR EACH ROW EXECUTE FUNCTION "message_trashed_at"();

-- Messages already in Trash start their clock now: nothing expires sooner than a full period
-- after this migration.
UPDATE "message" SET "trashed_at" = now()
WHERE "mailbox_id" IN (SELECT "id" FROM "mailbox" WHERE "special_use" = 'trash');
