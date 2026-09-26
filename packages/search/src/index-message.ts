// Writes the message_search row a message's tsvector and trigram indexes are generated from
// (PST-T-3.7). Called by the worker's file stage (PST-T-3.13) after a message is filed.
import type { Db, Prisma } from '@postroom/db';

const MAX_BODY_BYTES = 256 * 1024;

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up until we're not in the middle of a UTF-8 continuation byte (10xxxxxx).
  while (end > 0 && (bytes[end] as number) >= 0x80 && (bytes[end] as number) < 0xc0) end--;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isNaN(cp) ? match : String.fromCodePoint(cp);
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isNaN(cp) ? match : String.fromCodePoint(cp);
    }
    const named = ENTITIES[code.toLowerCase()];
    return named ?? match;
  });
}

/** Minimal HTML-to-text for bodies that only have an HTML part: strip script/style, tags, decode
 * entities, and collapse whitespace left behind by block elements. Not a renderer — just enough
 * text to search over. */
export function htmlToText(html: string): string {
  const withoutScripts = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutScripts.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(withoutTags);
  return decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface IndexMessageInput {
  messageId: string;
  accountId: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachmentNames?: string[];
  hasAttachment?: boolean;
}

/** Upsert the `message_search` row for one message. Body is truncated at 256 KiB on a UTF-8
 * boundary; an HTML-only body is converted to text first. Idempotent: safe to call again for the
 * same message (e.g. a replayed job). */
export async function indexMessage(tx: Db | Prisma.TransactionClient, input: IndexMessageInput): Promise<void> {
  const bodySource = input.bodyText !== undefined && input.bodyText.length > 0 ? input.bodyText : input.bodyHtml !== undefined ? htmlToText(input.bodyHtml) : '';
  const bodyText = truncateUtf8(bodySource, MAX_BODY_BYTES);
  const toText = [input.to ?? '', input.cc ?? ''].filter((v) => v.length > 0).join(' ');
  const attachmentNames = (input.attachmentNames ?? []).join(' ');
  const hasAttachment = input.hasAttachment ?? (input.attachmentNames !== undefined && input.attachmentNames.length > 0);

  await tx.messageSearch.upsert({
    where: { messageId: input.messageId },
    create: {
      messageId: input.messageId,
      accountId: input.accountId,
      subject: input.subject ?? '',
      fromText: input.from ?? '',
      toText,
      bodyText,
      hasAttachment,
      attachmentNames,
    },
    update: {
      accountId: input.accountId,
      subject: input.subject ?? '',
      fromText: input.from ?? '',
      toText,
      bodyText,
      hasAttachment,
      attachmentNames,
    },
  });
}
