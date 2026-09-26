// The worker-facing entry point (PST-T-2.7 calls this): decide, per attachment, whether it needs
// deeper (whole-part) inspection beyond the 512 sniffing bytes `collectMessage` already kept, fetch
// that content bounded by a cap, and turn every attachment's findings into the sender-history rule
// PST-REQ-065 states: executables, scripts, `.lnk` and disc images are quarantined regardless of
// history; macro documents, active-content documents and risky archives are quarantined only for a
// sender without prior history.

import type { Readable } from 'node:stream';
import type { AttachmentSummary, MessageSummary } from '@postroom/mime';
import { inspectAttachment, type InspectResult } from './inspect.js';
import { needsFullScan } from './magic.js';

export type OpenPart = (partId: string) => Readable;

export interface AttachmentPolicyOptions {
  readonly senderHasHistory: boolean;
  readonly openPart: OpenPart;
  /** Per-attachment cap on bytes read for deep inspection (default 25 MiB). Larger archives are
   * reported as uninspectable rather than read. */
  readonly maxInspectBytes?: number;
}

export interface AttachmentFinding {
  readonly partId: string;
  readonly filename: string | null;
  readonly verdict: 'ok' | 'quarantine';
  readonly kind: InspectResult['kind'];
  readonly reasons: string[];
}

export interface AttachmentPolicyResult {
  readonly quarantine: boolean;
  readonly findings: readonly AttachmentFinding[];
}

const DEFAULT_MAX_INSPECT_BYTES = 25 * 1024 * 1024;

async function readCapped(stream: Readable, cap: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > cap) {
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(buf);
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function applyHistoryRule(result: InspectResult, senderHasHistory: boolean): 'ok' | 'quarantine' {
  if (!senderHasHistory) return result.verdict;
  const hasAlways = result.findings.some((f) => f.severity === 'always');
  return hasAlways ? 'quarantine' : 'ok';
}

async function inspectOne(att: AttachmentSummary, opts: AttachmentPolicyOptions, cap: number): Promise<InspectResult> {
  const shallow = inspectAttachment({ filename: att.filename, contentType: att.contentType, bytes: att.firstBytes, size: att.size });

  if (!needsFullScan(att.firstBytes, att.filename, att.contentType)) {
    return shallow;
  }

  if (att.size > cap) {
    // Never read an oversized archive into memory just to say it is oversized.
    return inspectAttachment({ filename: att.filename, contentType: att.contentType, bytes: att.firstBytes, size: att.size, truncated: true });
  }

  const stream = opts.openPart(att.partId);
  const { bytes, truncated } = await readCapped(stream, cap);
  return inspectAttachment({ filename: att.filename, contentType: att.contentType, bytes, size: att.size, truncated });
}

export async function attachmentPolicy(collected: Pick<MessageSummary, 'attachments'>, opts: AttachmentPolicyOptions): Promise<AttachmentPolicyResult> {
  const cap = opts.maxInspectBytes ?? DEFAULT_MAX_INSPECT_BYTES;
  const findings: AttachmentFinding[] = [];
  for (const att of collected.attachments) {
    const result = await inspectOne(att, opts, cap);
    findings.push({
      partId: att.partId,
      filename: att.filename,
      verdict: applyHistoryRule(result, opts.senderHasHistory),
      kind: result.kind,
      reasons: result.reasons,
    });
  }
  return { quarantine: findings.some((f) => f.verdict === 'quarantine'), findings };
}
