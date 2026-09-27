-- CreateTable
CREATE TABLE "pending_send_copy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pending_send_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "recipients" TEXT[],
    "blob_sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "outbound_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_send_copy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_send_copy_pending_send_id_idx" ON "pending_send_copy"("pending_send_id");

-- AddForeignKey
ALTER TABLE "pending_send_copy" ADD CONSTRAINT "pending_send_copy_pending_send_id_fkey" FOREIGN KEY ("pending_send_id") REFERENCES "pending_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;

