-- PST-T-7.9 (PST-REQ-122): dmarc_report and tlsrpt_report each get a status (ours | foreign)
-- and a reason. A foreign report -- policy_published/domain (DMARC) or every
-- policies[].policy-domain (TLS-RPT) not one of our Domain rows -- is still stored (visible,
-- auditable) but excluded from every Deliverability aggregate. Existing rows default to
-- "ours".

-- AlterTable
ALTER TABLE "dmarc_report" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ours';

-- AlterTable
ALTER TABLE "tlsrpt_report" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ours';

-- CreateIndex
CREATE INDEX "dmarc_report_status_idx" ON "dmarc_report"("status");

-- CreateIndex
CREATE INDEX "tlsrpt_report_status_idx" ON "tlsrpt_report"("status");

