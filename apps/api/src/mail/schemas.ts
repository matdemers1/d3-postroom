// The zod schemas of the mail API (PST-T-3.9). They validate every request the routes accept, and
// the OpenAPI document (src/openapi) is generated from these same objects — so the spec cannot say
// one thing while the server checks another (PST-REQ-085). Response schemas are checked by the
// integration tests against real responses.
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Shared pieces

const Uuid = z.uuid();
/** BigInt counters (modseq) travel as decimal strings: JSON numbers stop being exact at 2^53. */
const Modseq = z.string().regex(/^\d+$/).describe('A MODSEQ (RFC 7162), as a decimal string.');
const Iso = z.iso.datetime();

/** RFC 9051 system flags the API may set. \Recent is the server's, and \Deleted is not a web path: delete is a move to Trash. */
export const SETTABLE_SYSTEM_FLAGS = ['\\Seen', '\\Answered', '\\Flagged', '\\Draft'] as const;
/** An IMAP keyword is an atom (RFC 9051): printable ASCII, no atom-specials, no backslash, 1–128 chars. */
const ATOM_SPECIALS = new Set('(){%*"\\] ');
function isKeyword(f: string): boolean {
  if (f.length === 0 || f.length > 128) return false;
  for (const ch of f) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code >= 0x7f || ATOM_SPECIALS.has(ch)) return false;
  }
  return true;
}
export const Flag = z
  .string()
  .refine((f) => (SETTABLE_SYSTEM_FLAGS as readonly string[]).includes(f) || isKeyword(f), {
    message: 'a system flag (\\Seen, \\Answered, \\Flagged, \\Draft) or an IMAP keyword atom',
  })
  .describe('A system flag (\\Seen, \\Answered, \\Flagged, \\Draft) or an IMAP keyword atom.');

export const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

// ---------------------------------------------------------------------------------------------
// Requests

export const IdParams = z.object({ id: Uuid });
export const AttachmentParams = z.object({ id: Uuid, partId: z.string().regex(/^1(?:\.\d{1,4}){0,32}$/).describe('MIME part id, e.g. 1.2 or 1.3.1.') });

export const MessageListQuery = z.object({
  cursor: z.string().regex(/^\d{1,10}$/).optional().describe('The nextCursor of the previous page.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const MessagePatch = z
  .object({
    flags: z
      .object({
        add: z.array(Flag).max(32).default([]),
        remove: z.array(Flag).max(32).default([]),
      })
      .optional(),
    mailboxId: Uuid.optional().describe('Move the message to this mailbox (one of the caller’s own).'),
  })
  .refine((p) => p.flags !== undefined || p.mailboxId !== undefined, { message: 'nothing to change' });

export const RenderQuery = z.object({
  images: z.enum(['0', '1']).default('0').describe('1 = the reader chose to load remote images, through the image proxy (PST-REQ-082).'),
});

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(1000),
  mailboxId: Uuid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------------------------
// Responses

export const Mailbox = z.object({
  id: Uuid,
  name: z.string(),
  specialUse: z.enum(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'rejects']).nullable(),
  uidvalidity: z.number().int(),
  uidnext: z.number().int(),
  highestModseq: Modseq,
  subscribed: z.boolean(),
  total: z.number().int(),
  unseen: z.number().int(),
});
export const MailboxList = z.object({ mailboxes: z.array(Mailbox) });

export const MessageSummary = z.object({
  id: Uuid,
  mailboxId: Uuid,
  uid: z.number().int(),
  modseq: Modseq,
  threadId: Uuid.nullable(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  /** The Date header when there was one, else the arrival time. */
  date: Iso,
  internalDate: Iso,
  size: z.number().int(),
  flags: z.array(z.string()),
  bucket: z.string().nullable(),
});
export const MessageList = z.object({
  messages: z.array(MessageSummary),
  nextCursor: z.string().nullable(),
});

export const MessageDetail = MessageSummary.extend({
  messageIdHeader: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  verdict: z
    .object({
      bucket: z.string().nullable(),
      reasons: z.array(z.string()),
      auth: z.unknown(),
    })
    .nullable(),
});

export const Attachment = z.object({
  partId: z.string(),
  contentType: z.string(),
  filename: z.string().nullable(),
  disposition: z.string().nullable(),
  contentId: z.string().nullable(),
  size: z.number().int(),
  sha256: z.string(),
  inMessage: z.string().nullable(),
});

export const MessageBody = z.object({
  id: Uuid,
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  html: z.string().nullable().describe('The HTML part exactly as sent. NOT sanitised: render it only on the usercontent origin (PST-T-3.12).'),
  htmlTruncated: z.boolean(),
  attachments: z.array(Attachment),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), partId: z.string().nullable() })),
});

export const RenderTicket = z.object({
  url: z.url().describe('The sanitised message on the usercontent origin: frame it with sandbox (no allow-scripts, no allow-same-origin). A capability; expires at expiresAt.'),
  expiresAt: Iso,
  images: z.boolean().describe('Whether remote images load (through the proxy) in this render.'),
  remoteImages: z.number().int().describe('Remote images in the message. Above 0 with images false means some are blocked.'),
});

export const SearchResult = z.object({
  messageId: Uuid,
  mailboxId: Uuid,
  uid: z.number().int(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  date: Iso,
  snippet: z.string(),
});
export const SearchResponse = z.object({
  results: z.array(SearchResult),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string()),
});

export const ThreadDetail = z.object({
  id: Uuid,
  subject: z.string().nullable(),
  messageCount: z.number().int(),
  lastMessageAt: Iso,
  messages: z.array(MessageSummary),
});

// ---------------------------------------------------------------------------------------------
// Server-sent events on /api/events

export const MailboxChangedEvent = z.object({
  mailboxId: Uuid,
  uidnext: z.number().int(),
  highestModseq: Modseq,
  unseen: z.number().int(),
  total: z.number().int(),
});
export const MessageNewEvent = z.object({
  mailboxId: Uuid,
  messageId: Uuid,
  uid: z.number().int(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  date: Iso,
});

export type MailboxJson = z.infer<typeof Mailbox>;
export type MessageSummaryJson = z.infer<typeof MessageSummary>;
export type MessageDetailJson = z.infer<typeof MessageDetail>;
export type MessageBodyJson = z.infer<typeof MessageBody>;
export type RenderTicketJson = z.infer<typeof RenderTicket>;
export type SearchResultJson = z.infer<typeof SearchResult>;
export type SearchResponseJson = z.infer<typeof SearchResponse>;
export type ThreadDetailJson = z.infer<typeof ThreadDetail>;
export type MailboxChangedJson = z.infer<typeof MailboxChangedEvent>;
export type MessageNewJson = z.infer<typeof MessageNewEvent>;
