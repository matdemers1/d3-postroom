// The one-line preview a message list shows under the subject (PST-T-14.2). Derived from the same
// body text the search index stores (the text/plain part, or the HTML part through htmlToText), so
// the body is never parsed twice for it.

/** The longest snippet kept, in UTF-16 code units (so `snippet.length <= 140` always holds). */
export const MAX_SNIPPET_LENGTH = 140;

/** Only this much of the body is looked at: a preview line never needs more. */
const SCAN_CHARS = 16 * 1024;

/** Lines where the quoted history (or a signature) begins; everything from here on is dropped. */
const HISTORY_STARTS: readonly RegExp[] = [
  /^On\b.{0,300}\bwrote:\s*$/i, // Gmail / Apple Mail attribution
  /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i, // Outlook / Thunderbird
  /^Begin forwarded message:/i, // Apple Mail forward
  /^_{10,}\s*$/, // Outlook's rule above a quoted header block
  /^-- $/, // RFC 3676 signature separator
];

/** Invisible characters marketing mail pads its preheader with; they would read as blank space. */
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]|\u034f|\u17b4|\u17b5/g;

/**
 * A preview of `bodyText`: quoted lines (`>`) and everything after a reply attribution, forward
 * marker or signature separator dropped, invisible padding removed, whitespace collapsed to single
 * spaces, and cut to at most 140 characters (ending in an ellipsis when cut). An OpenPGP-armoured
 * body previews as nothing — ciphertext is not a preview. Empty string when there is no text.
 */
export function snippetOf(bodyText: string): string {
  const head = bodyText.slice(0, SCAN_CHARS);
  if (/^\s*-----BEGIN PGP MESSAGE-----/.test(head)) return '';
  const kept: string[] = [];
  for (const raw of head.split(/\r\n|\r|\n/)) {
    if (HISTORY_STARTS.some((re) => re.test(raw))) break;
    if (/^\s*>/.test(raw)) continue;
    kept.push(raw);
  }
  const text = kept.join(' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_SNIPPET_LENGTH) return text;
  // Cut on a code point boundary, leaving room for the ellipsis.
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > MAX_SNIPPET_LENGTH - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}
