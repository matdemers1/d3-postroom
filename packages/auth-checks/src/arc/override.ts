// Local policy: may a validated ARC chain override a DMARC failure? (RFC 7489 §6.7 local policy,
// RFC 8617 §7.2.)
//
// ARC proves who handled a message and what each handler saw; it proves nothing about the message
// being genuine unless the handlers are trusted. So an override needs:
//  - DMARC failed with a disposition other than none (otherwise there is nothing to override);
//  - arc=pass;
//  - a chain of custody of trusted sealers: walking from the most recent set (i=N) down, every
//    sealer passed must be on the trusted list — an untrusted later hop could have rewritten the
//    message after a trusted one authenticated it;
//  - among those trusted sets, one whose ARC-Authentication-Results recorded dmarc=pass for this
//    same From domain (`requireDmarcPassInAar`, default true). That is the evidence the message
//    was authentic when it reached the trusted intermediary.
// The decision always carries its reason.

import type { DmarcDisposition, DmarcResult } from '../dmarc/evaluate.js';
import { normalizeDomain } from '../psl/index.js';
import type { ArcResult } from './verify.js';

export interface ArcOverrideOptions {
  /** Sealer domains (ARC-Seal d=) whose chains may override DMARC, e.g. ['google.com']. Exact match. */
  readonly trustedSealers: readonly string[];
  /** Require the trusted set's AAR to record dmarc=pass for the From domain. Default true. */
  readonly requireDmarcPassInAar?: boolean;
}

export interface ArcOverrideDecision {
  /** The final disposition after considering ARC. */
  readonly disposition: DmarcDisposition;
  readonly overridden: boolean;
  /** The trusted set whose evidence was used, when overridden. */
  readonly sealer?: { readonly instance: number; readonly domain: string };
  readonly reason: string;
}

/** dmarc= from an Authentication-Results value, with its header.from if any. */
export function dmarcFromAuthResults(value: string): { result: string; headerFrom?: string } | undefined {
  // Drop comments (not nested beyond one level in practice) so "(p=REJECT ...)" cannot confuse us.
  let text = value;
  for (let k = 0; k < 3; k++) text = text.replace(/\([^()]*\)/g, ' ');
  for (const resinfo of text.split(';')) {
    const m = /^\s*dmarc\s*=\s*([A-Za-z]+)/i.exec(resinfo);
    if (m?.[1] === undefined) continue;
    const from = /\bheader\.from\s*=\s*"?([^\s";]+)"?/i.exec(resinfo)?.[1];
    return { result: m[1].toLowerCase(), ...(from === undefined ? {} : { headerFrom: from }) };
  }
  return undefined;
}

export function dmarcWithArcOverride(
  dmarc: DmarcResult,
  arc: ArcResult,
  trusted: readonly string[] | ArcOverrideOptions,
): ArcOverrideDecision {
  const opts: ArcOverrideOptions = Array.isArray(trusted) ? { trustedSealers: trusted as readonly string[] } : (trusted as ArcOverrideOptions);
  const requireAar = opts.requireDmarcPassInAar ?? true;
  const trustedSet = new Set(opts.trustedSealers.map((d) => normalizeDomain(d) ?? d.toLowerCase()));
  const keep = (reason: string): ArcOverrideDecision => ({ disposition: dmarc.disposition, overridden: false, reason });

  if (dmarc.result !== 'fail' || dmarc.disposition === 'none') {
    return keep(`no override needed: dmarc=${dmarc.result}, disposition ${dmarc.disposition}`);
  }
  if (arc.result !== 'pass') return keep(`DMARC ${dmarc.disposition} stands: arc=${arc.result}`);

  const fromDomain = dmarc.fromDomain;
  const skipped: string[] = [];
  for (let i = arc.instances; i >= 1; i--) {
    const set = arc.sets[i - 1];
    const domain = set?.sealDomain;
    if (set === undefined || domain === undefined) return keep(`DMARC ${dmarc.disposition} stands: ARC set i=${i} has no sealer`);
    if (!trustedSet.has(domain)) {
      const after = skipped.length === 0 ? '' : `; later trusted sets did not vouch: ${skipped.join('; ')}`;
      return keep(`DMARC ${dmarc.disposition} stands: ARC set i=${i} is sealed by ${domain}, which is not trusted${after}`);
    }
    if (!requireAar) {
      return {
        disposition: 'none',
        overridden: true,
        sealer: { instance: i, domain },
        reason: `DMARC fail overridden by ARC pass sealed by ${domain} (trusted); ARC-Authentication-Results not required`,
      };
    }
    const seen = set.authResults === undefined ? undefined : dmarcFromAuthResults(set.authResults);
    const fromMatches = seen?.headerFrom === undefined || fromDomain === undefined || normalizeDomain(seen.headerFrom) === fromDomain;
    if (seen?.result === 'pass' && fromMatches) {
      return {
        disposition: 'none',
        overridden: true,
        sealer: { instance: i, domain },
        reason:
          `DMARC fail overridden by ARC pass sealed by ${domain} (trusted): ARC set i=${i} recorded dmarc=pass` +
          (seen.headerFrom === undefined ? '' : ` header.from=${seen.headerFrom}`),
      };
    }
    skipped.push(`i=${i} (${domain}: ${seen === undefined ? 'no dmarc result recorded' : `dmarc=${seen.result}${fromMatches ? '' : ` for ${seen.headerFrom ?? '?'}`}`})`);
  }
  return keep(`DMARC ${dmarc.disposition} stands: no trusted ARC set recorded dmarc=pass for ${fromDomain ?? 'the From domain'} [${skipped.join('; ')}]`);
}
