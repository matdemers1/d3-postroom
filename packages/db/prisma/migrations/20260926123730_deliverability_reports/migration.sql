-- PST-T-7.1 (PST-REQ-122): DMARC aggregate and TLS-RPT reports read out of the report mailbox,
-- normalized for the Deliverability screen, and the per-message ingest record the worker's sweep
-- keys on. Unique (org_name, report_id) makes a re-delivered report a no-op.

-- CreateTable
CREATE TABLE "report_ingest" (
    "message_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_ingest_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "dmarc_report" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_name" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "email" TEXT,
    "domain" TEXT NOT NULL,
    "range_begin" TIMESTAMPTZ(6) NOT NULL,
    "range_end" TIMESTAMPTZ(6) NOT NULL,
    "policy_published" JSONB NOT NULL,
    "message_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dmarc_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dmarc_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "source_ip" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL,
    "dkim" TEXT,
    "spf" TEXT,
    "header_from" TEXT NOT NULL,
    "envelope_from" TEXT,
    "auth_results" JSONB NOT NULL,

    CONSTRAINT "dmarc_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tlsrpt_report" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_name" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "contact_info" TEXT,
    "range_begin" TIMESTAMPTZ(6) NOT NULL,
    "range_end" TIMESTAMPTZ(6) NOT NULL,
    "message_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tlsrpt_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tlsrpt_policy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "policy_type" TEXT NOT NULL,
    "policy_domain" TEXT NOT NULL,
    "policy_string" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mx_host" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "success_count" INTEGER NOT NULL,
    "failure_count" INTEGER NOT NULL,

    CONSTRAINT "tlsrpt_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tlsrpt_failure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "result_type" TEXT NOT NULL,
    "sending_mta_ip" TEXT,
    "receiving_mx_hostname" TEXT,
    "receiving_ip" TEXT,
    "failed_session_count" INTEGER NOT NULL,
    "additional_info" TEXT,
    "failure_reason_code" TEXT,

    CONSTRAINT "tlsrpt_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dmarc_report_range_begin_idx" ON "dmarc_report"("range_begin");

-- CreateIndex
CREATE UNIQUE INDEX "dmarc_report_org_name_report_id_key" ON "dmarc_report"("org_name", "report_id");

-- CreateIndex
CREATE INDEX "dmarc_record_report_id_idx" ON "dmarc_record"("report_id");

-- CreateIndex
CREATE INDEX "dmarc_record_source_ip_idx" ON "dmarc_record"("source_ip");

-- CreateIndex
CREATE INDEX "tlsrpt_report_range_begin_idx" ON "tlsrpt_report"("range_begin");

-- CreateIndex
CREATE UNIQUE INDEX "tlsrpt_report_org_name_report_id_key" ON "tlsrpt_report"("org_name", "report_id");

-- CreateIndex
CREATE INDEX "tlsrpt_policy_report_id_idx" ON "tlsrpt_policy"("report_id");

-- CreateIndex
CREATE INDEX "tlsrpt_failure_policy_id_idx" ON "tlsrpt_failure"("policy_id");

-- AddForeignKey
ALTER TABLE "report_ingest" ADD CONSTRAINT "report_ingest_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmarc_report" ADD CONSTRAINT "dmarc_report_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmarc_record" ADD CONSTRAINT "dmarc_record_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "dmarc_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tlsrpt_report" ADD CONSTRAINT "tlsrpt_report_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tlsrpt_policy" ADD CONSTRAINT "tlsrpt_policy_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "tlsrpt_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tlsrpt_failure" ADD CONSTRAINT "tlsrpt_failure_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "tlsrpt_policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

