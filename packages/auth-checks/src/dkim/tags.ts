// DKIM tag=value lists (RFC 6376 §3.2), used by the DKIM-Signature field and the key record.

import { DkimError } from './errors.js';

const FWS = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Parse a tag-list into a map of tag name to value. Surrounding FWS is trimmed from names and
 * values; interior whitespace in values is kept (callers strip it from base64 values). A trailing
 * ';' is allowed. Duplicate tags are an error (§3.2: "Tags with duplicate names MUST NOT occur").
 */
export function parseTagList(text: string): Map<string, string> {
  const tags = new Map<string, string>();
  const parts = text.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part.replace(FWS, '') === '') {
      if (i === parts.length - 1) continue; // trailing ';'
      throw new DkimError('empty tag in tag-list');
    }
    const eq = part.indexOf('=');
    if (eq === -1) throw new DkimError('tag without "="');
    const name = part.slice(0, eq).replace(FWS, '');
    if (!TAG_NAME.test(name)) throw new DkimError('invalid tag name');
    if (tags.has(name)) throw new DkimError(`duplicate tag ${name}`);
    tags.set(name, part.slice(eq + 1).replace(FWS, ''));
  }
  return tags;
}

/** Remove every FWS character: for base64 values (b=, bh=, p=). */
export function stripWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, '');
}

/** Split a colon-separated list (h=), trimming FWS around each element. */
export function splitColonList(value: string): string[] {
  return value.split(':').map((s) => s.replace(FWS, '')).filter((s) => s !== '');
}

/**
 * The DKIM-Signature field with the b= tag's value (and the whitespace around it) removed, as
 * hashed by signer and verifier (§3.7). Operates on the raw field text (latin1), so folding
 * elsewhere in the field is preserved for simple canonicalization.
 */
export function withEmptyB(rawField: string): string {
  const colon = rawField.indexOf(':');
  if (colon === -1) throw new DkimError('not a header field');
  const value = rawField.slice(colon + 1);
  // Walk the tag-specs, tracking offsets, to find the one named "b" (never "bh").
  let offset = 0;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).replace(FWS, '') === 'b') {
      const start = colon + 1 + offset + eq + 1;
      const end = colon + 1 + offset + part.length;
      return rawField.slice(0, start) + rawField.slice(end);
    }
    offset += part.length + 1;
  }
  throw new DkimError('signature has no b= tag');
}
