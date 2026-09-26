-- PST-T-8.2 (PST-REQ-132, PST-REQ-133): CalDAV calendars, CardDAV address books, their encrypted
-- resources and the RFC 6578 sync-collection change log. Default "Calendar" and "Contacts" for
-- every person account: a trigger for new accounts, and a backfill for existing ones.

-- CreateEnum
CREATE TYPE "dav_collection_kind" AS ENUM ('calendar', 'addressbook');

-- CreateTable
CREATE TABLE "dav_collection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "kind" "dav_collection_kind" NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "sort_order" INTEGER,
    "components" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dead_props" JSONB NOT NULL DEFAULT '{}',
    "sync_seq" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dav_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dav_resource" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "component_type" TEXT,
    "etag" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "kek_id" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mod_seq" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dav_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dav_change" (
    "collection_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dav_change_pkey" PRIMARY KEY ("collection_id","seq")
);

-- CreateIndex
CREATE INDEX "dav_collection_account_id_idx" ON "dav_collection"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "dav_collection_account_id_kind_slug_key" ON "dav_collection"("account_id", "kind", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "dav_resource_collection_id_name_key" ON "dav_resource"("collection_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dav_resource_collection_id_uid_key" ON "dav_resource"("collection_id", "uid");

-- CreateIndex
CREATE INDEX "dav_change_collection_id_name_idx" ON "dav_change"("collection_id", "name");

-- AddForeignKey
ALTER TABLE "dav_collection" ADD CONSTRAINT "dav_collection_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dav_resource" ADD CONSTRAINT "dav_resource_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "dav_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dav_change" ADD CONSTRAINT "dav_change_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "dav_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariants a daemon writing raw SQL must not break either.
ALTER TABLE "dav_collection" ADD CONSTRAINT "dav_collection_sync_seq_check" CHECK ("sync_seq" >= 0);
ALTER TABLE "dav_collection" ADD CONSTRAINT "dav_collection_slug_check" CHECK ("slug" <> '' AND "slug" NOT IN ('.', '..') AND position('/' in "slug") = 0);
ALTER TABLE "dav_collection" ADD CONSTRAINT "dav_collection_components_check"
    CHECK ("components" IS NOT NULL AND "components" <@ ARRAY['VEVENT', 'VTODO', 'VJOURNAL']::TEXT[]);
ALTER TABLE "dav_resource" ADD CONSTRAINT "dav_resource_name_check" CHECK ("name" <> '' AND "name" NOT IN ('.', '..') AND position('/' in "name") = 0);
ALTER TABLE "dav_resource" ADD CONSTRAINT "dav_resource_size_check" CHECK ("size" >= 0 AND "mod_seq" >= 1);
ALTER TABLE "dav_change" ADD CONSTRAINT "dav_change_seq_check" CHECK ("seq" >= 1);

-- Every new person account starts with one calendar and one address book, whichever surface
-- created it (setup, OIDC first sign-in, admin). Part of the account's creation, which that
-- surface audits; a service account (PST-T-1.12) gets neither.
CREATE FUNCTION "dav_default_collections"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'person' THEN
    INSERT INTO "dav_collection" ("account_id", "kind", "slug", "display_name", "components")
    VALUES (NEW."id", 'calendar', 'calendar', 'Calendar', ARRAY['VEVENT', 'VTODO']),
           (NEW."id", 'addressbook', 'contacts', 'Contacts', ARRAY[]::TEXT[])
    ON CONFLICT ("account_id", "kind", "slug") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "dav_default_collections" AFTER INSERT ON "account" FOR EACH ROW EXECUTE FUNCTION "dav_default_collections"();

-- Backfill: every existing person account gets both, with one system audit event per account.
WITH created AS (
    INSERT INTO "dav_collection" ("account_id", "kind", "slug", "display_name", "components")
    SELECT a."id", d."kind"::"dav_collection_kind", d."slug", d."display_name", d."components"
    FROM "account" a
    CROSS JOIN (VALUES ('calendar', 'calendar', 'Calendar', ARRAY['VEVENT', 'VTODO']::TEXT[]),
                       ('addressbook', 'contacts', 'Contacts', ARRAY[]::TEXT[])) AS d("kind", "slug", "display_name", "components")
    WHERE a."kind" = 'person'
    ON CONFLICT ("account_id", "kind", "slug") DO NOTHING
    RETURNING "account_id", "id", "kind", "slug"
)
INSERT INTO "audit_event" ("actor_kind", "action", "entity_type", "entity_id", "after")
SELECT 'system'::"actor_kind", 'dav.collection.backfill', 'account', c."account_id"::text,
       jsonb_build_object('collections', jsonb_agg(jsonb_build_object('id', c."id", 'kind', c."kind", 'slug', c."slug") ORDER BY c."kind"))
FROM created c
GROUP BY c."account_id";
