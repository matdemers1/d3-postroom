-- PST-T-14.10: mailbox lists sort by INTERNALDATE (newest first, ties by UID), so a message that is
-- moved and moved back — which takes a new UID but keeps its INTERNALDATE — returns to its place.
--
-- internal_date drops to millisecond precision. Every writer already sets it from a JS Date (ms),
-- and every reader (the API's summaries, the web list's comparator, the search cursor) sees it as
-- one; at microsecond precision two rows in the same millisecond could be ordered one way by the
-- server and another by the web list. At (3) the stored value IS the value every surface sorts on,
-- so client and server order agree by construction. Any stray sub-millisecond value is rounded.
-- IMAP's INTERNALDATE has one-second resolution, so IMAP sees no change.
--
-- Plain ALTER / CREATE INDEX (not CONCURRENTLY): the message table is one mailbox owner's mail,
-- tens of thousands of rows at most, and the rewrite's lock is over in about a second.

-- AlterTable
ALTER TABLE "message" ALTER COLUMN "internal_date" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "message_mailbox_id_internal_date_uid_idx" ON "message"("mailbox_id", "internal_date" DESC, "uid" DESC);
