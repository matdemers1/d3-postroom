-- AlterTable
ALTER TABLE "account" ADD COLUMN     "totp_last_step" BIGINT;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "oidc_issuer" TEXT,
ADD COLUMN     "oidc_subject" TEXT,
ADD COLUMN     "roles" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "session_oidc_issuer_oidc_subject_idx" ON "session"("oidc_issuer", "oidc_subject");

ALTER TABLE "session" ADD CONSTRAINT "session_method" CHECK ("method" IN ('password', 'oidc'));
