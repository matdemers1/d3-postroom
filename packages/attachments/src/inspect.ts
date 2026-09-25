// PST-REQ-065: sniff an attachment by content, not by its claimed name or type, and quarantine the
// dangerous ones with a stated reason. `inspectAttachment` never throws — a malformed or hostile
// byte string is exactly the input this function exists to look at.

import { findPdfActiveContent, findRtfObjectEmbed } from './content.js';
import type { AttachmentKind, Finding } from './magic.js';
import { nameContentMismatchFinding, nameFindings, shebangFinding, sniffMagic, sniffOpaqueArchive } from './magic.js';
import { findOleMacroStorage, isOleMagic } from './ole.js';
import { inspectZip } from './zip.js';

export interface InspectInput {
  readonly filename: string | null;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly size: number;
  /** Set when `bytes` was cut off before the full attachment could be read (over the inspection cap). */
  readonly truncated?: boolean;
}

export interface InspectResult {
  /** Computed as if the sender had no history — the worst case. Callers apply their own history rule. */
  readonly verdict: 'ok' | 'quarantine';
  readonly kind: AttachmentKind;
  readonly reasons: string[];
  readonly findings: readonly Finding[];
}

function severityRank(s: Finding['severity']): number {
  return s === 'always' ? 0 : 1;
}

export function inspectAttachment(input: InspectInput): InspectResult {
  const findings: Finding[] = [];
  try {
    collectFindings(input, findings);
  } catch (err) {
    findings.push({
      kind: 'uninspectable-archive',
      reason: `attachment could not be fully inspected: ${err instanceof Error ? err.message : 'unknown error'}`,
      severity: 'no-history',
    });
  }

  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const kind: AttachmentKind = sorted[0]?.kind ?? 'benign';
  const reasons = sorted.map((f) => f.reason);
  return { verdict: sorted.length > 0 ? 'quarantine' : 'ok', kind, reasons, findings: sorted };
}

function collectFindings(input: InspectInput, findings: Finding[]): void {
  const { filename, bytes, truncated } = input;

  findings.push(...nameFindings(filename));

  const shebang = shebangFinding(bytes);
  if (shebang !== null) findings.push(shebang);

  const magic = sniffMagic(bytes);
  if (magic !== null) {
    findings.push({ kind: magic.kind, reason: magic.reason, severity: 'always' });
    const mismatch = nameContentMismatchFinding(filename, magic.kind);
    if (mismatch !== null) findings.push(mismatch);
  }

  if (isOleMagic(bytes)) {
    const macroStorage = findOleMacroStorage(bytes);
    if (macroStorage !== null) {
      findings.push({
        kind: 'ole-macro',
        reason: `contains a VBA macro storage ("${macroStorage}") in the OLE compound document`,
        severity: 'no-history',
      });
    }
  }

  const zip = inspectZip(bytes);
  if (zip !== null) {
    if (zip.macroEntry !== null) {
      findings.push({
        kind: 'ooxml-macro',
        reason: `contains a VBA project ("${zip.macroEntry}") in the OOXML package`,
        severity: 'no-history',
      });
    }
    if (zip.encrypted) {
      findings.push({ kind: 'password-protected-archive', reason: 'is a password-protected (encrypted) ZIP archive', severity: 'no-history' });
    }
    if (zip.nestedArchiveEntry !== null) {
      findings.push({
        kind: 'nested-archive',
        reason: `contains a nested archive ("${zip.nestedArchiveEntry}")`,
        severity: 'no-history',
      });
    }
    if (zip.executableEntry !== null) {
      findings.push({
        kind: 'archive-executable',
        reason: `contains an executable ("${zip.executableEntry}") inside the archive`,
        severity: 'always',
      });
    }
  }

  const opaqueArchive = sniffOpaqueArchive(bytes);
  if (opaqueArchive !== null) {
    findings.push({
      kind: 'uninspectable-archive',
      reason: `is a ${opaqueArchive.format} archive whose contents cannot be inspected (no archive library is used here)`,
      severity: 'no-history',
    });
  }

  const pdfToken = findPdfActiveContent(bytes);
  if (pdfToken !== null) {
    findings.push({ kind: 'pdf-active-content', reason: `PDF contains an active-content marker (${pdfToken})`, severity: 'no-history' });
  }

  const rtfToken = findRtfObjectEmbed(bytes);
  if (rtfToken !== null) {
    findings.push({ kind: 'rtf-ole-embed', reason: `RTF contains an OLE object embedding marker (${rtfToken})`, severity: 'no-history' });
  }

  if (truncated === true) {
    findings.push({
      kind: 'uninspectable-archive',
      reason: 'attachment exceeds the inspection cap; its full contents could not be verified',
      severity: 'no-history',
    });
  }
}
