// DMARC evaluation (RFC 7489 §3.1 alignment, §6.6 processing; RFC 9091 np=).
//
// DMARC passes when SPF passed for a domain aligned with the RFC5322.From domain, or a DKIM
// signature passed whose d= is aligned with it. Relaxed alignment compares organizational domains
// (via the Public Suffix List); strict alignment compares the domains exactly.
//
// Decisions made here:
// - A DKIM pass whose key record says t=y (testing) does NOT count toward alignment. RFC 6376
//   §3.6.1 says verifiers "MUST NOT treat messages from Signers in testing mode differently from
//   unsigned email"; a reason records that it was set aside.
// - Several From header fields, or one From field whose addresses span several domains, is a
//   permerror that is treated as a DMARC failure for every domain named: each domain's policy is
//   applied as if its check had failed, and the strictest resulting disposition wins. A signature
//   can cover one From while a reader sees another (RFC 6376 §8.15), so an aligned pass proves
//   nothing about the From that is displayed; and RFC 7489 §6.6.1 allows exactly this "most
//   strict" handling. Several addresses in ONE field, all in the same domain, evaluate normally.
// - pct= sampling uses an injectable random source. A failing message not selected by pct gets
//   the next-lower disposition: reject → quarantine, quarantine → none (§6.6.4, §6.3 pct).
// - temperror (DNS) and none leave the disposition at none; the caller decides whether a
//   temperror becomes a 4xx.

import { parseMailboxes } from '@postroom/mime';
import type { DkimResult } from '../dkim/verify.js';
import { normalizeDomain, organizationalDomain, type PslOptions } from '../psl/index.js';
import { fetchDmarcPolicy, type DmarcDns, type DmarcPolicyLookup } from './policy.js';
import type { DmarcAlignmentMode, DmarcPolicy, DmarcRecord } from './record.js';

export type DmarcResultCode = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';
export type DmarcDisposition = 'none' | 'quarantine' | 'reject';
export type AlignmentMode = 'relaxed' | 'strict';

/** The SPF input: an EvaluateSpfResult fits (only result and domain are read). */
export interface DmarcSpfInput {
  readonly result: string;
  /** The domain SPF evaluated: the MAIL FROM domain, or the HELO name when MAIL FROM was null. */
  readonly domain: string;
}

/** The DKIM input: DkimResult fits (result, domain, testing are read). */
export type DmarcDkimInput = Pick<DkimResult, 'result' | 'domain' | 'testing'>;

export interface DmarcAlignment {
  readonly spf: {
    readonly mode: AlignmentMode;
    readonly result?: string;
    readonly domain?: string;
    /** SPF passed AND its domain is aligned. */
    readonly aligned: boolean;
  };
  readonly dkim: {
    readonly mode: AlignmentMode;
    /** d= of every passing, non-testing signature aligned with the From domain. */
    readonly alignedDomains: readonly string[];
    readonly aligned: boolean;
  };
}

export interface DmarcResult {
  readonly result: DmarcResultCode;
  /** The RFC5322.From domain evaluated (header.from). Absent when there was none, or several. */
  readonly fromDomain?: string;
  /** Every distinct From domain found. */
  readonly fromDomains: readonly string[];
  readonly orgDomain?: string;
  /** Where the policy record was found. */
  readonly recordDomain?: string;
  readonly record?: DmarcRecord;
  /** The policy requested for this message, and which tag it came from. */
  readonly policy?: DmarcPolicy;
  readonly policySource?: 'p' | 'sp' | 'np';
  /** What to do with the message. Only a fail (or a multi-From permerror) is ever other than none. */
  readonly disposition: DmarcDisposition;
  /** false when pct= sampling excluded this message from the full policy. */
  readonly sampled: boolean;
  readonly alignment?: DmarcAlignment;
  /** Per-domain results when the From header named several domains. */
  readonly perDomain?: readonly DmarcResult[];
  /** Why. Never empty. */
  readonly reasons: readonly string[];
  /** The Authentication-Results method result, e.g. `dmarc=pass (p=reject sp=reject dis=none) header.from=example.com`. */
  readonly authResults: string;
}

export interface DmarcIdentifiers {
  readonly fromDomain: string;
  readonly spf?: DmarcSpfInput;
  readonly dkim: readonly DmarcDkimInput[];
  /** Returns [0, 1). Default Math.random. Only called when pct < 100 and the policy is not none. */
  readonly random?: () => number;
  readonly psl?: PslOptions;
  /** Whether the From domain exists (RFC 9091 np=); undefined when unknown. */
  readonly fromDomainExists?: boolean;
  /** Treat the message as failing even if an aligned pass exists; the reason says why. */
  readonly forceFail?: string;
}

export interface EvaluateDmarcInput {
  readonly dns: DmarcDns;
  /** The value of every From header field in the message, as written (folding allowed). */
  readonly from: readonly string[];
  readonly spf?: DmarcSpfInput;
  readonly dkim: readonly DmarcDkimInput[];
  readonly random?: () => number;
  readonly psl?: PslOptions;
}

const SEVERITY: Record<DmarcDisposition, number> = { none: 0, quarantine: 1, reject: 2 };

/** Whether two domains are aligned under the mode. */
export function domainsAligned(a: string, b: string, mode: AlignmentMode, psl: PslOptions = {}): boolean {
  const x = normalizeDomain(a);
  const y = normalizeDomain(b);
  if (x === undefined || y === undefined) return false;
  if (mode === 'strict') return x === y;
  const ox = organizationalDomain(x, psl);
  return ox !== undefined && ox === organizationalDomain(y, psl);
}

const modeOf = (m: DmarcAlignmentMode): AlignmentMode => (m === 's' ? 'strict' : 'relaxed');

/**
 * Apply a discovered policy to one From domain's authentication results. Synchronous: the policy
 * was fetched already (fetchDmarcPolicy). `evaluateDmarc` is the usual entry point.
 */
export function applyDmarcPolicy(lookup: DmarcPolicyLookup, ids: DmarcIdentifiers): DmarcResult {
  const psl = ids.psl ?? {};
  const fromDomain = normalizeDomain(ids.fromDomain) ?? ids.fromDomain.toLowerCase();
  const base = { fromDomain, fromDomains: [fromDomain], orgDomain: lookup.orgDomain };

  if (lookup.kind !== 'record') {
    return finish({ ...base, result: lookup.kind, disposition: 'none', sampled: true, reasons: [...lookup.reasons] });
  }

  const { record } = lookup;
  const reasons: string[] = [...lookup.reasons];

  // Which policy applies (§6.3 p/sp, RFC 9091 np).
  let policy: DmarcPolicy = record.p;
  let policySource: 'p' | 'sp' | 'np' = 'p';
  const isSubdomainOfOrg = lookup.recordDomain === lookup.orgDomain && fromDomain !== lookup.orgDomain;
  if (isSubdomainOfOrg) {
    if (record.np !== undefined && ids.fromDomainExists === false) {
      policy = record.np;
      policySource = 'np';
      reasons.push(`${fromDomain} does not exist: np=${record.np} applies (RFC 9091)`);
    } else if (record.sp !== undefined) {
      policy = record.sp;
      policySource = 'sp';
    }
    if (record.np !== undefined && ids.fromDomainExists === undefined) {
      reasons.push('np= published but the From domain\'s existence is unknown; np= not applied');
    }
  }

  // SPF alignment.
  const spfMode = modeOf(record.aspf);
  const spf = ids.spf;
  const spfAligned = spf !== undefined && spf.result === 'pass' && domainsAligned(spf.domain, fromDomain, spfMode, psl);
  if (spf === undefined) reasons.push('no SPF result');
  else if (spf.result !== 'pass') reasons.push(`SPF ${spf.result} for ${spf.domain}: does not count`);
  else if (spfAligned) reasons.push(`SPF pass for ${spf.domain}, ${spfMode}ly aligned with ${fromDomain}`);
  else reasons.push(`SPF pass for ${spf.domain} is not ${spfMode}ly aligned with ${fromDomain}`);

  // DKIM alignment.
  const dkimMode = modeOf(record.adkim);
  const alignedDomains: string[] = [];
  if (ids.dkim.length === 0) reasons.push('no DKIM signatures');
  for (const d of ids.dkim) {
    const dom = d.domain ?? '?';
    if (d.result !== 'pass') {
      reasons.push(`DKIM ${d.result} for d=${dom}: does not count`);
      continue;
    }
    const aligned = d.domain !== undefined && domainsAligned(d.domain, fromDomain, dkimMode, psl);
    if (!aligned) {
      reasons.push(`DKIM pass for d=${dom} is not ${dkimMode}ly aligned with ${fromDomain}`);
      continue;
    }
    if (d.testing) {
      reasons.push(`DKIM pass for d=${dom} is aligned but its key is in testing mode (t=y): not counted (RFC 6376 §3.6.1)`);
      continue;
    }
    reasons.push(`DKIM pass for d=${dom}, ${dkimMode}ly aligned with ${fromDomain}`);
    if (!alignedDomains.includes(dom)) alignedDomains.push(dom);
  }

  const alignment: DmarcAlignment = {
    spf: { mode: spfMode, ...(spf === undefined ? {} : { result: spf.result, domain: spf.domain }), aligned: spfAligned },
    dkim: { mode: dkimMode, alignedDomains, aligned: alignedDomains.length > 0 },
  };
  const common = {
    ...base,
    recordDomain: lookup.recordDomain,
    record,
    policy,
    policySource,
    alignment,
  };

  if (ids.forceFail === undefined && (spfAligned || alignedDomains.length > 0)) {
    return finish({ ...common, result: 'pass', disposition: 'none', sampled: true, reasons });
  }

  if (ids.forceFail !== undefined) reasons.push(ids.forceFail);
  else reasons.push('neither SPF nor DKIM produced an aligned pass');
  let disposition: DmarcDisposition = policy;
  let sampled = true;
  if (policy !== 'none' && record.pct < 100) {
    const draw = (ids.random ?? Math.random)() * 100;
    if (draw >= record.pct) {
      sampled = false;
      disposition = policy === 'reject' ? 'quarantine' : 'none';
      reasons.push(`pct=${record.pct}: message not sampled, ${policy} downgraded to ${disposition} (RFC 7489 §6.6.4)`);
    }
  }
  reasons.push(`policy ${policySource}=${policy} → disposition ${disposition}`);
  return finish({ ...common, result: 'fail', disposition, sampled, reasons });
}

/** Extract the From domains: distinct, lowercased. `problem` set when one cannot be read. */
export function fromDomainsOf(values: readonly string[]): { domains: string[]; problem?: string } {
  const domains: string[] = [];
  for (const value of values) {
    const boxes = parseMailboxes(value.replace(/\r\n/g, ''));
    if (boxes.length === 0) return { domains, problem: 'From header has no address' };
    for (const box of boxes) {
      const at = box.address.lastIndexOf('@');
      const domain = at === -1 ? undefined : normalizeDomain(box.address.slice(at + 1));
      if (domain === undefined) return { domains, problem: `From address "${box.address}" has no usable domain` };
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  return { domains };
}

async function domainExists(dns: DmarcDns, domain: string, reasons: string[]): Promise<boolean | undefined> {
  if (dns.exists === undefined) return undefined;
  try {
    return await dns.exists(domain);
  } catch (err) {
    reasons.push(`could not tell whether ${domain} exists (${err instanceof Error ? err.message : String(err)}); np= not applied`);
    return undefined;
  }
}

async function evaluateOne(input: EvaluateDmarcInput, fromDomain: string, forceFail?: string): Promise<DmarcResult> {
  const lookup = await fetchDmarcPolicy(input.dns, fromDomain, input.psl ?? {});
  const extra: string[] = [];
  let exists: boolean | undefined;
  if (
    lookup.kind === 'record' &&
    lookup.record.np !== undefined &&
    lookup.recordDomain === lookup.orgDomain &&
    lookup.fromDomain !== lookup.orgDomain
  ) {
    exists = await domainExists(input.dns, lookup.fromDomain, extra);
  }
  const r = applyDmarcPolicy(lookup, {
    fromDomain,
    ...(input.spf === undefined ? {} : { spf: input.spf }),
    dkim: input.dkim,
    ...(input.random === undefined ? {} : { random: input.random }),
    ...(input.psl === undefined ? {} : { psl: input.psl }),
    ...(exists === undefined ? {} : { fromDomainExists: exists }),
    ...(forceFail === undefined ? {} : { forceFail }),
  });
  return extra.length === 0 ? r : finish({ ...r, reasons: [...extra, ...r.reasons] });
}

/** Evaluate DMARC for a message: parse the From header(s), discover the policy, check alignment. */
export async function evaluateDmarc(input: EvaluateDmarcInput): Promise<DmarcResult> {
  if (input.from.length === 0) {
    return finish({ result: 'permerror', fromDomains: [], disposition: 'none', sampled: true, reasons: ['message has no From header'] });
  }
  const { domains, problem } = fromDomainsOf(input.from);
  if (problem !== undefined) {
    return finish({ result: 'permerror', fromDomains: domains, disposition: 'none', sampled: true, reasons: [problem] });
  }
  const only = domains[0];
  if (input.from.length === 1 && domains.length === 1 && only !== undefined) return evaluateOne(input, only);

  // Several From fields, or several domains in one: permerror, each domain's policy applied as a
  // failure, strictest disposition wins.
  const what =
    input.from.length > 1
      ? `message has ${input.from.length} From headers; alignment is ambiguous (RFC 6376 §8.15)`
      : `From header names ${domains.length} domains; alignment is ambiguous`;
  const forced = `${what}: treated as a DMARC failure (RFC 7489 §6.6.1)`;
  const perDomain: DmarcResult[] = [];
  for (const d of domains) perDomain.push(await evaluateOne(input, d, forced));
  let disposition: DmarcDisposition = 'none';
  for (const r of perDomain) if (SEVERITY[r.disposition] > SEVERITY[disposition]) disposition = r.disposition;
  const reasons = [
    `${what} [${domains.join(', ')}]: DMARC permerror, each domain's policy applied as a failure (RFC 7489 §6.6.1)`,
    ...perDomain.map((r) => `${r.fromDomain ?? '?'}: dmarc=${r.result}, disposition ${r.disposition}`),
    `strictest disposition applied: ${disposition}`,
  ];
  return finish({ result: 'permerror', fromDomains: domains, disposition, sampled: true, perDomain, reasons });
}

type Unfinished = Omit<DmarcResult, 'authResults'>;

function finish(r: Unfinished): DmarcResult {
  return { ...r, authResults: authResultsDmarc(r) };
}

/** Authentication-Results text for a DMARC result (RFC 7489 §11.2, the common comment form). */
export function authResultsDmarc(r: Unfinished): string {
  const parts = [`dmarc=${r.result}`];
  if (r.record !== undefined) {
    const sp = r.record.sp ?? r.record.p;
    const pct = r.sampled ? '' : ` pct=${r.record.pct} not-sampled`;
    parts.push(`(p=${r.record.p} sp=${sp} dis=${r.disposition}${pct})`);
  } else {
    const first = r.reasons[0];
    if (first !== undefined) parts.push(`(${first.replace(/\(/g, '[').replace(/\)/g, ']').replace(/[\\\r\n]/g, ' ')})`);
  }
  if (r.fromDomain !== undefined) parts.push(`header.from=${r.fromDomain}`);
  return parts.join(' ');
}
