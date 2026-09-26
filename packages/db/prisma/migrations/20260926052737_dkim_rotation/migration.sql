-- PST-T-7.4 (PST-REQ-125): DKIM rotation under dated selectors. A key is created `pending`, starts
-- signing (`active`) only once its TXT is seen in DNS, is `retiring` — still published — for 7 days
-- after it is superseded, and then `retired`. Every existing key was signing, so it starts `active`.

-- CreateEnum
CREATE TYPE "dkim_key_state" AS ENUM ('pending', 'active', 'retiring', 'retired');

-- AlterTable
ALTER TABLE "dkim_key" ADD COLUMN     "dns_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "retire_after" TIMESTAMPTZ(6),
ADD COLUMN     "state" "dkim_key_state" NOT NULL DEFAULT 'active';

-- A key already marked retired before this migration stays retired.
UPDATE "dkim_key" SET "state" = 'retired' WHERE "retired_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "dkim_key_domain_id_algorithm_state_idx" ON "dkim_key"("domain_id", "algorithm", "state");
