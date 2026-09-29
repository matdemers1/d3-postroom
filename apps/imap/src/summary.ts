// The list snippet for an APPENDed message (PST-T-14.2). APPEND scans only the structure as the
// literal streams in, so the body text is read back from the stored blob — bounded: a message
// over APPEND_SNIPPET_MAX_BYTES, or one that cannot be read, is filed without a snippet and the
// worker's summary sweep fills it later, off the protocol path.
import type { BlobStore } from '@postroom/blobstore';
import { collectMessage } from '@postroom/mime';
import { htmlToText, snippetOf } from '@postroom/search';

export const APPEND_SNIPPET_MAX_BYTES = 8 * 1024 * 1024;

/** The snippet of a stored message, or undefined when it is left for the summary sweep. */
export async function appendSnippet(blobs: Pick<BlobStore, 'get'>, sha256: string, size: number): Promise<string | undefined> {
  if (size > APPEND_SNIPPET_MAX_BYTES) return undefined;
  try {
    const stream = await blobs.get(sha256);
    const collected = await collectMessage(stream as AsyncIterable<Uint8Array>, { maxTextBytes: 64 * 1024, maxHtmlBytes: 512 * 1024 });
    const text = collected.text !== null ? collected.text.text : collected.html !== null ? htmlToText(collected.html.text) : '';
    return snippetOf(text);
  } catch {
    return undefined;
  }
}
