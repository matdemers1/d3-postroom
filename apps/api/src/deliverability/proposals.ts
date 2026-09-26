// DMARC progression proposals (PST-T-7.2, PST-REQ-123): "When 14 consecutive days of aggregate
// reports show only aligned passes from authorized sources, the system shall propose moving the
// DMARC policy one stage (none, quarantine, reject) with the evidence attached."
//
// The window is the 14 whole UTC days before today (today itself is excluded — it is not over yet,
// so a receiver's report for it cannot exist). A day is "clean" only if at least one report covers
// it and every record in every report for that day is: disposition none, an aligned DKIM or SPF
// pass, and from a source `isAuthorizedSource` recognizes as ours (authorized.ts) — a passing but
// *unauthorized* source (someone else's aligned mail, or a forwarder) never counts toward the
// streak, because a policy tightened on the strength of it would break that unrecognized source.
// One unclean row, or one missing day, resets the streak and the response says which day and why.
//
// Postroom never edits DNS (CLAUDE.md): the proposal names the exact new TXT value to publish and
// stops there.
import type { Db } from '@postroom/db';
import { isAuthorizedSource } from './authorized.js';

/** none | quarantine | reject (RFC 7489 policy_published/p) — restated here rather than imported
 * from `@postroom/reports` because the API app does not otherwise depend on that package. */
export type DmarcDisposition = 'none' | 'quarantine' | 'reject';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;
const STAGES: readonly DmarcDisposition[] = ['none', 'quarantine', 'reject'];
const PCT_STEP = 25;

export interface ProposalEvidenceDay {
  /** YYYY-MM-DD, UTC. */
  readonly day: string;
  readonly reports: number;
  readonly messages: number;
  readonly sources: readonly string[];
  readonly orgs: readonly string[];
}

export interface DmarcProposal {
  readonly domain: string;
  readonly currentStage: DmarcDisposition;
  readonly currentPct: number;
  /** The stage the new record proposes — the same stage as current when only `pct` moves. */
  readonly proposedStage: DmarcDisposition;
  readonly proposedPct: number;
  /** The exact TXT value to publish at `_dmarc.<domain>`. Never published by Postroom itself. */
  readonly txtValue: string;
  readonly evidence: { readonly from: string; readonly to: string; readonly days: readonly ProposalEvidenceDay[] };
}

export interface ProposalResult {
  readonly domain: string;
  readonly eligible: boolean;
  readonly proposal: DmarcProposal | null;
  /** Why there is no proposal. Null when `eligible`. */
  readonly reason: string | null;
}

interface PolicyPublishedJson {
  readonly p?: string;
  readonly sp?: string;
  readonly pct?: number;
  readonly adkim?: string;
  readonly aspf?: string;
  readonly fo?: string;
}

function isDisposition(v: unknown): v is DmarcDisposition {
  return v === 'none' || v === 'quarantine' || v === 'reject';
}

/** The DMARC report address to publish as `rua`: REPORTS_MAILBOX, else dmarc@<domain>. Mirrors
 * index.ts's reportAddress, applied to the domain the proposal is for (not necessarily primary). */
async function ruaAddress(db: Db, env: NodeJS.ProcessEnv, domain: string): Promise<string | null> {
  const configured = (env['REPORTS_MAILBOX'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .find((s) => s.includes('@'));
  if (configured !== undefined) return configured;
  const row = await db.domain.findUnique({ where: { name: domain } });
  return row === null ? null : `dmarc@${domain}`;
}

function buildTxtValue(policy: PolicyPublishedJson, proposedStage: DmarcDisposition, proposedPct: number, rua: string | null): string {
  const parts = [`v=DMARC1`, `p=${proposedStage}`];
  if (typeof policy.sp === 'string' && policy.sp !== '') parts.push(`sp=${policy.sp}`);
  parts.push(`pct=${String(proposedPct)}`);
  if (typeof policy.adkim === 'string' && policy.adkim !== '') parts.push(`adkim=${policy.adkim}`);
  if (typeof policy.aspf === 'string' && policy.aspf !== '') parts.push(`aspf=${policy.aspf}`);
  if (rua !== null) parts.push(`rua=mailto:${rua}`);
  if (typeof policy.fo === 'string' && policy.fo !== '') parts.push(`fo=${policy.fo}`);
  return parts.join('; ');
}

/** The [from, to) window of the last 14 whole UTC days before `now`'s UTC day. */
function window(now: Date): { from: Date; to: Date; days: string[] } {
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = to - WINDOW_DAYS * DAY_MS;
  const days: string[] = [];
  for (let t = from; t < to; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return { from: new Date(from), to: new Date(to), days };
}

async function proposalForDomain(db: Db, env: NodeJS.ProcessEnv, domain: string, now: Date): Promise<ProposalResult> {
  const { from, to, days } = window(now);
  const reports = await db.dmarcReport.findMany({
    where: { domain: { equals: domain, mode: 'insensitive' }, status: 'ours', rangeBegin: { gte: from, lt: to } },
    include: { records: true },
    orderBy: { rangeBegin: 'asc' },
  });
  const byDay = new Map<string, typeof reports>();
  for (const r of reports) {
    const day = r.rangeBegin.toISOString().slice(0, 10);
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [r]);
    else list.push(r);
  }

  const evidenceDays: ProposalEvidenceDay[] = [];
  for (const day of days) {
    const dayReports = byDay.get(day);
    if (dayReports === undefined || dayReports.length === 0) {
      return { domain, eligible: false, proposal: null, reason: `no report covers ${day} (UTC) — the streak needs all ${String(WINDOW_DAYS)} days` };
    }
    let messages = 0;
    const sources = new Set<string>();
    const orgs = new Set<string>();
    for (const r of dayReports) {
      orgs.add(r.orgName);
      for (const rec of r.records) {
        messages += rec.count;
        sources.add(rec.sourceIp);
        const aligned = rec.dkim === 'pass' || rec.spf === 'pass';
        const authorized = isAuthorizedSource(rec.sourceIp, env);
        if (rec.disposition !== 'none') return { domain, eligible: false, proposal: null, reason: `${day} (UTC): ${rec.sourceIp} was not disposed "none" (${rec.disposition})` };
        if (!aligned) return { domain, eligible: false, proposal: null, reason: `${day} (UTC): ${rec.sourceIp} had no aligned DKIM or SPF pass` };
        if (!authorized) return { domain, eligible: false, proposal: null, reason: `${day} (UTC): ${rec.sourceIp} is not an authorized source` };
      }
    }
    evidenceDays.push({ day, reports: dayReports.length, messages, sources: [...sources].sort(), orgs: [...orgs].sort() });
  }

  const latest = reports.at(-1);
  if (latest === undefined) return { domain, eligible: false, proposal: null, reason: `no reports in the last ${String(WINDOW_DAYS)} days` };
  const policy = latest.policyPublished as PolicyPublishedJson;
  const currentStage = isDisposition(policy.p) ? policy.p : 'none';
  const currentPct = typeof policy.pct === 'number' && Number.isFinite(policy.pct) ? policy.pct : 100;

  let proposedStage: DmarcDisposition;
  let proposedPct: number;
  if (currentPct < 100) {
    // Ramping the current stage up before moving to the next one — a 14-day clean streak at a
    // partial rollout earns more of the same stage, not a jump to a stricter one.
    proposedStage = currentStage;
    proposedPct = Math.min(100, currentPct + PCT_STEP);
  } else {
    const idx = STAGES.indexOf(currentStage);
    if (idx >= STAGES.length - 1) return { domain, eligible: false, proposal: null, reason: `${domain} is already at "reject" and 100% — there is no stricter stage to propose` };
    proposedStage = STAGES[idx + 1] ?? 'reject';
    proposedPct = 100;
  }

  const rua = await ruaAddress(db, env, domain);
  const txtValue = buildTxtValue(policy, proposedStage, proposedPct, rua);
  return {
    domain,
    eligible: true,
    reason: null,
    proposal: {
      domain,
      currentStage,
      currentPct,
      proposedStage,
      proposedPct,
      txtValue,
      evidence: { from: from.toISOString(), to: to.toISOString(), days: evidenceDays },
    },
  };
}

/** One result per our Domain row (PST-T-7.2, PST-REQ-123). */
export async function computeProposals(db: Db, env: NodeJS.ProcessEnv, now: Date): Promise<ProposalResult[]> {
  const domains = await db.domain.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
  const out: ProposalResult[] = [];
  for (const d of domains) out.push(await proposalForDomain(db, env, d.name.toLowerCase(), now));
  return out;
}
