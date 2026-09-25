// RFC 5322 §3.6.4 identification fields: Message-ID, In-Reply-To, References. Ids are returned
// without their angle brackets, with comments and folding whitespace removed.

import { stripComments } from './params.js';

/** Cap on ids returned from one field: a References header is not a place to spend unbounded work. */
const MAX_IDS = 1000;

/** Parse a msg-id list. Falls back to bare `local@domain` words when no bracketed id is present. */
export function parseMessageIdList(value: string): string[] {
  const text = stripComments(value);
  const out: string[] = [];
  const bracketed = /<([^<>]*)>/g;
  for (let m = bracketed.exec(text); m !== null && out.length < MAX_IDS; m = bracketed.exec(text)) {
    const id = (m[1] as string).replace(/\s+/g, '');
    if (id !== '') out.push(id);
  }
  if (out.length > 0) return out;
  for (const word of text.split(/[\s,]+/)) {
    if (out.length >= MAX_IDS) break;
    if (/^[^@\s<>]+@[^@\s<>]+$/.test(word)) out.push(word);
  }
  return out;
}

/** The first msg-id in the value, or null. */
export function parseMessageId(value: string): string | null {
  return parseMessageIdList(value)[0] ?? null;
}
