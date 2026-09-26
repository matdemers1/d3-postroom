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

const Fields = {
  to: AddressField,
  cc: AddressField,
  bcc: AddressField,
  subject: Line.default(''),
  text: z.string().max(1_000_000).default(''),
  inReplyTo: MsgId.nullable().optional(),
  references: z.array(MsgId).max(100).default([]),
  forwardOf: Uuid.nullable().optional().describe('Forward: the id of one of the caller’s messages, attached whole as message/rfc822.'),
};

export const SendRequest = z.object({
  from: Line.min(3).max(320).describe('One of the caller’s own addresses.'),
  ...Fields,
  draftId: Uuid.nullable().optional().describe('The draft this send replaces; it is removed from Drafts in the same transaction.'),
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
