// Stage 3, classify — a stub until the classifier lands (PST-P-4). It decides only Inbox or Junk:
//
//   · smtp-in's disposition was `quarantine` (DMARC p=quarantine, …) → junk;
//   · the dangerous-attachment policy (PST-REQ-065) quarantines an attachment → junk;
//   · otherwise → inbox.
//
// Every outcome carries its reasons (PST-ADR-007), and nothing is ever dropped: the worst this
// stage can do is put a message in Junk, where its reasons say why.
//
// "Sender history" for the attachment rule: this sender has an earlier message, not in Junk or
// Rejects, in one of the recipient accounts, received before this one. Bounded by this message's
// receivedAt, so a replay reaches the same answer it reached the first time.
import { attachmentPolicy } from '@postroom/attachments';
import type { BlobStore } from '@postroom/blobstore';
import { SpecialUse, type Db } from '@postroom/db';
import { collectBlob, openBlobPart } from './parse.js';
import type { AttachmentFindingJson, Bucket, ClassifyResult, ParseResult, StageInput, VerifyResult } from './types.js';

function authSummary(verdicts: unknown): string | null {
  if (typeof verdicts !== 'object' || verdicts === null) return null;
  const v = verdicts as Record<string, unknown>;
  const result = (x: unknown): string => (typeof x === 'object' && x !== null && 'result' in x && typeof x.result === 'string' ? x.result : 'none');
  const dkim = Array.isArray(v['dkim']) ? (v['dkim'] as unknown[]).map(result) : [];
  return `auth: spf=${result(v['spf'])} dkim=${dkim.length === 0 ? 'none' : dkim.join(',')} dmarc=${result(v['dmarc'])} arc=${result(v['arc'])}`;
}

export async function senderHasHistory(db: Db, input: { inboundMessageId: string; fromAddress: string | null; accountIds: readonly string[]; before: Date }): Promise<boolean> {
  if (input.fromAddress === null || input.accountIds.length === 0) return false;
  const prior = await db.message.findFirst({
    where: {
      fromAddress: { equals: input.fromAddress, mode: 'insensitive' },
      internalDate: { lt: input.before },
      OR: [{ inboundMessageId: null }, { inboundMessageId: { not: input.inboundMessageId } }],
      mailbox: {
        accountId: { in: [...input.accountIds] },
        OR: [{ specialUse: null }, { specialUse: { notIn: [SpecialUse.junk, SpecialUse.rejects] } }],
      },
    },
    select: { id: true },
  });
  return prior !== null;
}

export async function classifyStage(
  input: StageInput,
  deps: { db: Db; blobs: BlobStore },
  prior: { verify: VerifyResult; parse: ParseResult; accountIds: readonly string[] },
): Promise<ClassifyResult> {
  const reasons: string[] = [];
  let bucket: Bucket = 'inbox';

  const auth = authSummary(input.inbound.verdicts);
  if (auth !== null) reasons.push(auth);

  if (prior.verify.disposition === 'quarantine') {
    bucket = 'junk';
    reasons.push(`junk: smtp-in quarantined it${input.inbound.dispositionReason === null ? '' : ` (${input.inbound.dispositionReason})`}`);
  }

  const history = await senderHasHistory(deps.db, {
    inboundMessageId: input.inbound.id,
    fromAddress: prior.parse.fromAddress,
    accountIds: prior.accountIds,
    before: input.inbound.receivedAt,
  });
  let findings: AttachmentFindingJson[] = [];
  let attachmentQuarantine = false;
  if (prior.parse.attachments.length > 0) {
    // The parse stage kept only JSON; the policy needs the sniffing bytes, so collect again (streamed).
    const collected = await collectBlob(deps.blobs, input.inbound.blobSha256);
    const policy = await attachmentPolicy(collected, {
      senderHasHistory: history,
      openPart: (partId) => openBlobPart(deps.blobs, input.inbound.blobSha256, partId),
    });
    attachmentQuarantine = policy.quarantine;
    findings = policy.findings.map((f) => ({ partId: f.partId, filename: f.filename, verdict: f.verdict, kind: f.kind, reasons: [...f.reasons] }));
    for (const f of policy.findings) {
      if (f.verdict !== 'quarantine') continue;
      reasons.push(`junk: attachment ${f.filename ?? `part ${f.partId}`} quarantined (${f.reasons.join('; ')})`);
    }
    if (attachmentQuarantine) {
      bucket = 'junk';
      reasons.push(`attachment policy: sender ${history ? 'has' : 'has no'} prior history with the recipient`);
    }
  }

  if (bucket === 'inbox') reasons.push('inbox: no junk signal (classifier stub; PST-P-4 replaces it)');
  return { bucket, senderHasHistory: history, attachmentQuarantine, attachments: findings, reasons };
}
