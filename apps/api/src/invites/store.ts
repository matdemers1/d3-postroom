// Finding a message's text/calendar part (PST-T-8.4, PST-REQ-134): streamed through the same
// @postroom/mime parser the attachment route uses, never buffering more than one part.
import type { Readable } from 'node:stream';
import { parseMessage } from '@postroom/mime';

/** The first `text/calendar` leaf part's transfer-decoded bytes, or null when the message has none. */
export async function findCalendarPart(stream: Readable): Promise<Buffer | null> {
  let partId: string | null = null;
  const chunks: Buffer[] = [];
  for await (const event of parseMessage(stream)) {
    if (event.type === 'headers' && event.part.kind === 'leaf' && event.part.contentType === 'text/calendar' && partId === null) {
      partId = event.part.id;
    } else if (partId !== null && event.type === 'body' && event.part.id === partId) {
      chunks.push(event.chunk);
    } else if (partId !== null && event.type === 'end-part' && event.part.id === partId) {
      break;
    }
  }
  return partId === null ? null : Buffer.concat(chunks);
}
