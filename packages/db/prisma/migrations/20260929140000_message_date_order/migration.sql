-- PST-T-14.10: mailbox lists sort by INTERNALDATE (newest first, ties by UID), so a message that is
-- moved and moved back — which takes a new UID but keeps its INTERNALDATE — returns to its place.
-- A plain CREATE INDEX (not CONCURRENTLY): the message table is a single mailbox owner's mail, tens
-- of thousands of rows at most, and the brief write lock is over in well under a second.

-- CreateIndex
CREATE INDEX "message_mailbox_id_internal_date_uid_idx" ON "message"("mailbox_id", "internal_date" DESC, "uid" DESC);
