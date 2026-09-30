// The zod schemas of the composer API (PST-T-3.11). They validate every request, and the OpenAPI
// document is generated from these same objects (PST-REQ-085).
import { z } from 'zod';

const Uuid = z.uuid();
const Iso = z.iso.datetime();
/** One header line's worth of text: no CR or LF can reach a header. */
const Line = z.string().max(998).regex(/^[^\r\n]*$/, 'no line breaks');
const MsgId = z
  .string()
  .trim()
  .max(998)
  .regex(/^<?[\x21-\x3b\x3d\x3f-\x7e]+>?$/, 'a msg-id, e.g. <id@host>')
  .describe('A Message-ID, with or without angle brackets.');
const AddressField = z.array(Line).max(100).default([]).describe('Address-field entries ("Name <a@b>" or a comma-separated list of them).');

/** Undo send may hold a message at most this long (PST-REQ-140). */
export const MAX_UNDO_SECONDS = 30;
/** Scheduled sends at most a year out, snoozes too. */
export const MAX_AHEAD_MS = 366 * 86_400_000;
/** Remind-if-no-reply at most 90 days out. */
export const MAX_REMIND_SECONDS = 90 * 86_400;

export const ComposeMode = z.enum(['new', 'reply', 'replyall', 'forward']);

/** PST-T-9.2: plain text as always, or Markdown rendered to sanitized HTML and sent multipart/alternative. */
export const ComposeFormat = z.enum(['plain', 'markdown']);

/**
 * The largest Markdown body `renderMarkdown` will ever be asked to render (PST-T-9.2). Rendering is
 * now near-linear, but a cap keeps the worst-case work bounded regardless: a `format: 'markdown'`
 * send whose text exceeds this is refused (413) rather than rendered, so plain text (no size cap
 * beyond the existing 1,000,000-character field limit) is always the fallback for anything larger.
 */
export const MAX_MARKDOWN_CHARS = 256 * 1024;

const Fields = {
  to: AddressField,
  cc: AddressField,
  bcc: AddressField,
  subject: Line.default(''),
  text: z.string().max(1_000_000).default(''),
  inReplyTo: MsgId.nullable().optional(),
  references: z.array(MsgId).max(100).default([]),
  forwardOf: Uuid.nullable().optional().describe('Forward: the id of one of the caller’s messages, attached whole as message/rfc822.'),
  format: ComposeFormat.default('plain').describe('markdown: text is Markdown, sent multipart/alternative with sanitized HTML (PST-REQ-145).'),
  // PST-T-15.10 (PST-REQ-195, PST-ADR-013): files uploaded with POST /api/compose/uploads.
  attachments: z
    .array(Uuid)
    .max(1000)
    .optional()
    .describe(
      'Upload ids (POST /api/compose/uploads), attached in this order; an id given twice attaches the file twice, and every occurrence counts toward the limits. Each must be one of the caller’s uploads (else 404 not_found); more than maxAttachments is 400 too_many_attachments; a total over maxAttachmentBytes is 413 attachments_too_large (GET /api/compose/limits); an upload removed while the message is built is 409 attachment_gone.',
    ),
};

/**
 * PST-T-12.2 (PST-REQ-161): sign with the sender's own key, and/or encrypt to every recipient's key
 * and the sender's own. Both, when given, must be the same kind. Headers (Subject included) are not
 * protected.
 */
export const SendCrypto = z
  .object({
    sign: z.enum(['pgp', 'smime']).optional().describe('PGP/MIME (RFC 3156) or S/MIME (RFC 8551) multipart/signed, with your own key for the From address.'),
    encrypt: z.enum(['pgp', 'smime']).optional().describe('PGP/MIME multipart/encrypted or S/MIME enveloped-data, to every recipient and to you. A recipient without a key is 409 recipient_keys_missing, never a plaintext send.'),
  })
  .describe('Sign then encrypt when both are set.');

export const SendRequest = z.object({
  from: Line.min(3).max(320).describe('One of the caller’s own addresses.'),
  ...Fields,
  draftId: Uuid.nullable().optional().describe('The draft this send replaces; it is removed from Drafts in the same transaction.'),
  requestReceipt: z.boolean().default(false).describe('Add Disposition-Notification-To: the sender’s own address (PST-REQ-146).'),
  // PST-T-9.1: undo send (PST-REQ-140), scheduled send (PST-REQ-141), remind-if-no-reply (PST-REQ-143).
  undoSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_UNDO_SECONDS)
    .optional()
    .describe('Undo send: hold the message this many seconds before it is queued (0–30; the webmail sends its setting, default 10). Absent or 0 sends at once.'),
  sendAt: Iso.optional().describe('Scheduled send: hold the message until this time, then queue it (within a minute). Not with undoSeconds.'),
  remindAfterSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_REMIND_SECONDS)
    .optional()
    .describe('Remind if no reply: when nobody else has written in the thread this long after it was sent, it comes back to INBOX.'),
  // PST-T-12.2 (PST-REQ-161): sign and/or encrypt with the account's keys.
  crypto: SendCrypto.optional(),
});

export const DraftRequest = z.object({
  from: Line.min(3).max(320).optional().describe('One of the caller’s own addresses; default the primary.'),
  ...Fields,
  mode: ComposeMode.nullable().optional(),
  sourceId: Uuid.nullable().optional().describe('The message being answered or forwarded, for resuming the draft.'),
});

export const DraftQuery = z.object({
  inReplyTo: MsgId.optional().describe('Only drafts answering this Message-ID.'),
});

export const DraftParams = z.object({ id: Uuid });

// Responses

export const SendResponse = z.object({
  messageId: z.string().describe('The Message-ID header of the sent message.'),
  outboundId: Uuid.describe('The outbound queue row.'),
  sentMessageId: Uuid.describe('The copy filed in Sent.'),
  sentMailboxId: Uuid,
  threadId: Uuid.nullable().describe('The thread the Sent copy joined (null only if threading failed; the sweep retries).'),
  reminderId: Uuid.nullable().optional().describe('The remind-if-no-reply armed for it, when one was asked for.'),
});

export const DraftSaved = z.object({
  id: Uuid.describe('The draft’s message id. A save replaces the draft, so this changes every save.'),
  mailboxId: Uuid,
  uid: z.number().int(),
  savedAt: Iso,
});

export const Draft = z.object({
  id: Uuid,
  mailboxId: Uuid,
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  forwardOf: Uuid.nullable(),
  mode: ComposeMode.nullable(),
  sourceId: Uuid.nullable(),
  savedAt: Iso,
});

export const DraftList = z.object({ drafts: z.array(Draft) });

// PST-T-15.10 (PST-REQ-195, PST-ADR-013): composer attachments.

export const ComposeUpload = z.object({
  id: Uuid.describe('Pass it in `attachments` of a send or a draft save.'),
  filename: z.string().describe('The name as given (any path stripped), UTF-8.'),
  contentType: z.string().describe('type/subtype, lowercased; application/octet-stream when none usable was given.'),
  size: z.number().int().describe('Bytes, before any transfer encoding.'),
});

export const OmittedAttachment = z.object({
  filename: z.string(),
  size: z.number().int().describe('Decoded bytes.'),
  reason: z.enum(['too_large', 'too_many']).describe('too_large: over maxAttachmentBytes; too_many: past maxAttachments.'),
});

export const DraftDetail = Draft.extend({
  attachments: z.array(ComposeUpload).describe('The draft’s attachments, registered as the caller’s uploads (existing ones reused), in message order. A file the draft holds twice is listed twice.'),
  omittedAttachments: z
    .array(OmittedAttachment)
    .describe('Attachment parts of the draft that were NOT registered (and so cannot be sent on): larger than the per-file limit, or past the most a message may carry.'),
});

export const UploadParams = z.object({ id: Uuid });

export const ComposeLimits = z.object({
  maxAttachmentBytes: z.number().int().describe('The largest total of all attachments in one message (and so of one file), in bytes before encoding.'),
  maxAttachments: z.number().int().describe('The most attachments one message may carry.'),
});

export type ComposeUploadJson = z.infer<typeof ComposeUpload>;
export type DraftDetailJson = z.infer<typeof DraftDetail>;
export type ComposeLimitsJson = z.infer<typeof ComposeLimits>;

// PST-T-9.1: held (undo / scheduled) sends.

export const PendingSendState = z.enum(['held', 'released', 'cancelled', 'failed']);

export const PendingSend = z.object({
  id: Uuid,
  kind: z.enum(['undo', 'scheduled']).describe('undo: held for the undo window; scheduled: a chosen send time.'),
  state: PendingSendState,
  releaseAt: Iso.describe('When the worker queues it (within a minute of this).'),
  draftId: Uuid.nullable().describe('The copy in Drafts; it stays there while held, and after an undo.'),
  subject: z.string(),
  to: z.string().describe('The To and Cc addresses, space-separated.'),
  messageId: z.string().describe('The Message-ID header it will be sent with.'),
  remindAfterSeconds: z.number().int().nullable(),
  reason: z.string().nullable().describe('Why it was cancelled or failed.'),
  createdAt: Iso,
});

export const PendingSendList = z.object({ pending: z.array(PendingSend) });
export const PendingParams = z.object({ id: Uuid });
export const PendingPatch = z.object({ sendAt: Iso.describe('The new send time (in the future).') });

export type PendingSendJson = z.infer<typeof PendingSend>;
export type SendResponseJson = z.infer<typeof SendResponse>;
export type DraftSavedJson = z.infer<typeof DraftSaved>;
export type DraftJson = z.infer<typeof Draft>;

// PST-T-9.2: RFC 8098 read receipts (MDNs).

export const MdnParams = z.object({ id: Uuid });

export const MdnResponse = z.object({
  messageId: z.string().describe('The Message-ID header of the MDN that was sent.'),
  outboundId: Uuid,
  sentMessageId: Uuid.describe('The copy filed in Sent.'),
});

export type MdnResponseJson = z.infer<typeof MdnResponse>;
