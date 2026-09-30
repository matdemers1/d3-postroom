-- PST-T-15.10 (PST-REQ-195, PST-ADR-013): files uploaded in the composer, waiting to be attached.
--
-- A row holds one reference on its blob (blob.refcount), taken by the upload's put and dropped by
-- DELETE /api/compose/uploads/:id or by the worker's sweep once last_used_at is 24 h old. Sends,
-- holds and drafts build their own message blobs with the file inside, so dropping an upload never
-- loses mail. No foreign key to blob: like pending_send.held_blob_sha256, the reference is counted,
-- and the release that takes it to zero crypto-shreds the blob.

-- CreateTable
CREATE TABLE "compose_upload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compose_upload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "compose_upload_size_check" CHECK ("size" >= 0)
);

-- CreateIndex
CREATE INDEX "compose_upload_account_id_blob_sha256_idx" ON "compose_upload"("account_id", "blob_sha256");

-- CreateIndex
CREATE INDEX "compose_upload_last_used_at_idx" ON "compose_upload"("last_used_at");

-- AddForeignKey
ALTER TABLE "compose_upload" ADD CONSTRAINT "compose_upload_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
