// evaluateSpf(): the public entry point. Builds the initial identity (SS4.1 - MAIL FROM, or
// postmaster@HELO when the reverse-path is null), runs check_host(), and never throws: every
// SpfPermError/SpfTempError raised while walking the record becomes a permerror/temperror
// result instead, per RFC 7208 SS2.6.

import { checkHost, newCheckHostState } from './check-host.js';
import { SpfPermError, SpfTempError } from './errors.js';
import { domainPart, localPart } from './macro.js';
import { parseIPv4, parseIPv6 } from './ip.js';
import type { EvaluateSpfOptions, EvaluateSpfResult, SpfResult } from './types.js';

function detectIpVersion(ip: string): 4 | 6 {
  return ip.includes(':') ? 6 : 4;
}

/** RFC 7208 SS4.3: a <sender>/HELO domain that is a domain-literal (e.g. "[1.2.3.4]"), that is
 * not itself a syntactically valid DNS name (a label over 63 octets, an empty label, or over 253
 * octets total), or that is not even dotted (never a real FQDN) never reaches a DNS query at
 * all - the result is "none", not an error, and not a lookup we'd otherwise have to fail loudly. */
function isValidInitialDomain(domain: string): boolean {
  if (domain.startsWith('[')) return false;
  if (!domain.includes('.')) return false;
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  return labels.every((label) => label.length >= 1 && label.length <= 63);
}

export async function evaluateSpf(options: EvaluateSpfOptions): Promise<EvaluateSpfResult> {
  const state = newCheckHostState();
  const ipVersion = detectIpVersion(options.ip);

  if (ipVersion === 4 && parseIPv4(options.ip) === undefined) {
    return { result: 'none', domain: options.helo, scope: 'helo', lookups: 0, voidLookups: 0, trace: ['invalid client IP'] };
  }
  if (ipVersion === 6) {
    const v6 = parseIPv6(options.ip);
    if (v6 === undefined) {
      return { result: 'none', domain: options.helo, scope: 'helo', lookups: 0, voidLookups: 0, trace: ['invalid client IP'] };
    }
  }

  const helo = options.helo === '' ? 'unknown' : options.helo;
  const mailFrom = options.mailFrom;
  const scope: 'mfrom' | 'helo' = mailFrom === null || mailFrom === undefined || mailFrom === '' ? 'helo' : 'mfrom';
  const sender = scope === 'helo' ? `postmaster@${helo}` : (mailFrom ?? '');
  const domain = scope === 'helo' ? helo : domainPart(sender) || helo;

  if (domain === '' || !isValidInitialDomain(domain)) {
    return { result: 'none', domain, scope, lookups: 0, voidLookups: 0, trace: [`not a usable domain to evaluate: ${domain}`] };
  }
  // A sender with no local-part (e.g. "@example.com") is treated as "postmaster" (SS4.3).
  const effectiveSender = localPart(sender) === '' ? `postmaster@${domain}` : sender;

  try {
    const outcome = await checkHost(
      domain,
      {
        ip: options.ip,
        ipVersion,
        sender: effectiveSender,
        helo,
        receivingDomain: options.receiver,
        now: options.now,
      },
      options.dns,
      state,
    );
    return {
      result: outcome.result,
      domain,
      scope,
      explanation: outcome.explanation,
      mechanism: outcome.mechanism,
      lookups: state.dnsLookups,
      voidLookups: state.voidLookups,
      trace: state.trace,
    };
  } catch (err) {
    const result: SpfResult = err instanceof SpfPermError ? 'permerror' : err instanceof SpfTempError ? 'temperror' : (() => {
      throw err;
    })();
    state.trace.push(`aborted: ${err instanceof Error ? err.message : String(err)}`);
    return { result, domain, scope, lookups: state.dnsLookups, voidLookups: state.voidLookups, trace: state.trace };
  }
}

/** The Authentication-Results method string for SPF (RFC 8601 SS2.7.3 / RFC 7208 SS9). */
export function authResultsSpf(res: EvaluateSpfResult): string {
  const identity = res.scope === 'helo' ? 'smtp.helo' : 'smtp.mailfrom';
  return `spf=${res.result} ${identity}=${res.domain}`;
}
