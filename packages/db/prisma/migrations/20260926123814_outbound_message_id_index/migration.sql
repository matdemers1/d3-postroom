-- PST-T-6.7 (PST-REQ-119): index the outbound queue by (account_id, message_id) so the mailbox
-- message → outbound lookup (a Sent copy's Message-ID header against this account's outbound rows)
-- is an index scan, not the account's full outbound history walked client-side.

-- CreateIndex
CREATE INDEX "outbound_message_account_id_message_id_idx" ON "outbound_message"("account_id", "message_id");
