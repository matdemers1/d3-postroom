// SES refuses a message that carries more than one DKIM-Signature header ("554 Transaction failed:
// Duplicate header 'DKIM-Signature'", seen in production 2026-09-27/28). Postroom signs every message
// twice at submission (RSA-2048 and Ed25519, PST-T-1.8), so the SES transport drops the Ed25519
// signature on the way out and relays with the RSA one, which every receiver can verify.
//
// Dropping the field is safe: DKIM-Signature is not in the signer's h= list (DEFAULT_SIGNED_HEADERS in
// @postroom/auth-checks), so the RSA signature's header hash does not cover it, and the body is passed
// through byte for byte. Direct delivery keeps both signatures.
//
// Streaming (PST-REQ-050): only the header block is held, up to HEADER_CAP bytes; a message whose
// header block is longer than that (or never ends) is passed through unchanged rather than buffered.
import { Readable } from 'node:stream';

export const HEADER_CAP = 1024 * 1024;
const END = Buffer.from('\r\n\r\n', 'latin1');

/** A DKIM-Signature field's a= value, or null when the field is not a DKIM-Signature. */
function dkimAlgorithm(field: string): string | null {
  const colon = field.indexOf(':');
  if (colon < 0 || field.slice(0, colon).trim().toLowerCase() !== 'dkim-signature') return null;
  // The a= tag, with folding whitespace removed (RFC 6376 §3.2).
  const algo = /(?:^|;)\s*a\s*=\s*([^;]+)/i.exec(field.slice(colon + 1).replace(/[\r\n\t ]+/g, ''));
  return algo?.[1]?.toLowerCase() ?? '';
}

/**
 * Remove the Ed25519 DKIM-Signature fields from a raw header block (CRLF lines, folded or not) — but
 * only when another, non-Ed25519 signature remains: a message signed with Ed25519 alone keeps it
 * (SES accepts one signature, and DMARC needs at least one).
 */
export function dropEd25519DkimFields(block: string): string {
  const lines = block.split('\r\n');
  const fields: string[][] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && fields.length > 0) fields[fields.length - 1]?.push(line);
    else fields.push([line]);
  }
  const algos = fields.map((f) => dkimAlgorithm(f.join('\r\n')));
  if (!algos.some((a) => a !== null && a !== 'ed25519-sha256')) return block;
  return fields
    .filter((_, i) => algos[i] !== 'ed25519-sha256')
    .map((f) => f.join('\r\n'))
    .join('\r\n');
}

/** The message stream with its Ed25519 DKIM-Signature fields removed from the header block. */
export function withoutEd25519Dkim(source: AsyncIterable<Buffer | Uint8Array | string>): Readable {
  async function* filtered(): AsyncGenerator<Buffer> {
    let head: Buffer = Buffer.alloc(0);
    let passthrough = false;
    for await (const chunk of source) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      if (passthrough) {
        yield bytes;
        continue;
      }
      head = Buffer.concat([head, bytes]);
      const end = head.indexOf(END);
      if (end >= 0) {
        const block = head.subarray(0, end).toString('latin1');
        yield Buffer.from(dropEd25519DkimFields(block), 'latin1');
        yield head.subarray(end);
        passthrough = true;
      } else if (head.length > HEADER_CAP) {
        yield head;
        passthrough = true;
      }
    }
    if (!passthrough && head.length > 0) yield head;
  }
  return Readable.from(filtered());
}
