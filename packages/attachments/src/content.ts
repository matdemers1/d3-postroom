// Token scans over document formats that carry active content: PDF actions and RTF object
// embedding. Both formats are effectively text-with-binary-blobs, so a bounded byte scan for the
// documented markers is enough — no PDF/RTF parser required.

import { isPdfMagic } from './magic.js';

const PDF_TOKENS: readonly string[] = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile'];

export function findPdfActiveContent(bytes: Buffer): string | null {
  if (!isPdfMagic(bytes)) return null;
  const text = bytes.toString('latin1');
  for (const token of PDF_TOKENS) {
    if (text.includes(token)) return token;
  }
  return null;
}

const RTF_TOKENS: readonly string[] = ['\\objdata', '\\objupdate'];

export function isRtf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '{\\rtf';
}

export function findRtfObjectEmbed(bytes: Buffer): string | null {
  if (!isRtf(bytes)) return null;
  const text = bytes.toString('latin1');
  for (const token of RTF_TOKENS) {
    if (text.includes(token)) return token;
  }
  return null;
}
