-- PST-T-19.2 (the D3 App contract): native sessions for D3 Constellation. A native session is an
-- ordinary session row — so the sessions screen, revocation and every route treat it as one —
-- marked native and named by its device, with its refresh tokens in their own table, rotated on
-- every use. Additive only.

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "native" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "device_name" TEXT,
ADD COLUMN     "device_platform" TEXT;

-- CreateTable
CREATE TABLE "native_refresh" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "replaced_at" TIMESTAMPTZ(6),

    CONSTRAINT "native_refresh_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "native_refresh_token_hash_key" ON "native_refresh"("token_hash");

-- CreateIndex
CREATE INDEX "native_refresh_session_id_idx" ON "native_refresh"("session_id");

-- AddForeignKey
ALTER TABLE "native_refresh" ADD CONSTRAINT "native_refresh_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
