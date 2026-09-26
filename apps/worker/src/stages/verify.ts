// Stage 1, verify. smtp-in already ran SPF, DKIM, DMARC, ARC and the DNSBL and decided accept or
// quarantine before it answered 250 (PST-T-2.6); nothing is re-derived here — the answer the client
// heard is final. This stage checks that what the rest of the pipeline relies on is really there:
// the verdicts, a disposition it knows, and the blob row. A missing verdict is recorded as a reason
// and the message still files (no silent loss); a missing blob is an error, and the job retries
// until it goes `failed`, visibly.
import type { StageInput, VerifyResult } from './types.js';

export const REQUIRED_VERDICTS = ['spf', 'dkim', 'dmarc', 'arc', 'decision'] as const;

export function verifyStage(input: StageInput): VerifyResult {
  const { inbound, blob } = input;
  if (blob === null) throw new Error(`blob ${inbound.blobSha256} of inbound message ${inbound.id} is missing`);
  const verdicts = typeof inbound.verdicts === 'object' && inbound.verdicts !== null && !Array.isArray(inbound.verdicts) ? inbound.verdicts : {};
  const present = REQUIRED_VERDICTS.filter((k) => k in verdicts);
  const missing = REQUIRED_VERDICTS.filter((k) => !(k in verdicts));
  const reasons: string[] = [];
  let disposition: VerifyResult['disposition'];
  if (inbound.disposition === 'accept' || inbound.disposition === 'quarantine') {
    disposition = inbound.disposition;
    reasons.push(`smtp-in disposition ${disposition}${inbound.dispositionReason === null ? '' : `: ${inbound.dispositionReason}`}`);
  } else {
    // Only 'reject' is left, and a rejected row never gets an inbound job. Treat anything else as
    // quarantine: suspicious mail lands in Junk rather than nowhere.
    disposition = 'quarantine';
    reasons.push(`unexpected smtp-in disposition "${inbound.disposition}": treated as quarantine`);
  }
  for (const k of missing) reasons.push(`verdict "${k}" missing from the spool row; filed without it`);
  if (blob.size !== inbound.size) reasons.push(`blob size ${blob.size} differs from spooled size ${inbound.size}`);
  return {
    disposition,
    present: [...present],
    missing: [...missing],
    blob: { sha256: blob.sha256, size: blob.size },
    reasons,
  };
}
