// check_host(), RFC 7208 SS4-SS6: the recursive core of SPF evaluation, including the
// SS4.6.4 processing limits (10 DNS-lookup terms, 10 MX names, 2 void lookups).

import { SpfPermError, SpfTempError } from './errors.js';
import { expandMacros, type MacroContext } from './macro.js';
import { ipv4CidrMatch, ipv6CidrMatch, ipv4MappedToIPv4, parseIPv4, parseIPv6 } from './ip.js';
import { NO_SPF_RECORD, parseRecord, selectSpfRecord, type Mechanism, type Qualifier, type Term } from './parse.js';
import type { SpfDns, SpfMxRecord, SpfResult } from './types.js';

const MAX_DNS_LOOKUPS = 10;
const MAX_VOID_LOOKUPS = 2;
const MAX_MX_NAMES = 10;
const MAX_PTR_NAMES = 10;

export interface CheckHostArgs {
  ip: string;
  ipVersion: 4 | 6;
  sender: string;
  helo: string;
  receivingDomain?: string | undefined;
  now?: number | undefined;
}

export interface CheckHostState {
  dnsLookups: number;
  voidLookups: number;
  trace: string[];
}

export function newCheckHostState(): CheckHostState {
  return { dnsLookups: 0, voidLookups: 0, trace: [] };
}

export interface CheckHostOutcome {
  result: SpfResult;
  mechanism?: string | undefined;
  explanation?: string | undefined;
}

function qualifierResult(qualifier: Qualifier): SpfResult {
  switch (qualifier) {
    case '+':
      return 'pass';
    case '-':
      return 'fail';
    case '~':
      return 'softfail';
    case '?':
      return 'neutral';
  }
}

function countLookup(state: CheckHostState, label: string): void {
  state.dnsLookups++;
  if (state.dnsLookups > MAX_DNS_LOOKUPS) {
    throw new SpfPermError(`exceeded the ${String(MAX_DNS_LOOKUPS)}-lookup limit at ${label} (RFC 7208 SS4.6.4)`);
  }
}

function countVoid(state: CheckHostState, wasVoid: boolean, label: string): void {
  if (!wasVoid) return;
  state.voidLookups++;
  if (state.voidLookups > MAX_VOID_LOOKUPS) {
    throw new SpfPermError(`exceeded the ${String(MAX_VOID_LOOKUPS)}-void-lookup limit at ${label} (RFC 7208 SS4.6.4)`);
  }
}

function macroContext(domain: string, args: CheckHostArgs): MacroContext {
  return {
    sender: args.sender,
    domain,
    ip: args.ip,
    ipVersion: args.ipVersion,
    helo: args.helo,
    receivingDomain: args.receivingDomain,
    timestamp: args.now,
    inExp: false,
  };
}

function expandDomainSpec(spec: string | undefined, domain: string, args: CheckHostArgs): string {
  const template = spec === undefined || spec === '' ? '%{d}' : spec;
  const expanded = expandMacros(template, macroContext(domain, args));
  if (expanded === '') throw new SpfPermError('domain-spec expanded to the empty string');
  return expanded;
}

async function safeDns<T>(promise: Promise<T>, label: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof SpfTempError) throw err;
    if (err instanceof SpfPermError) throw err;
    throw new SpfTempError(`DNS error during ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function clientAsIPv4(args: CheckHostArgs): number | undefined {
  if (args.ipVersion === 4) return parseIPv4(args.ip);
  const v6 = parseIPv6(args.ip);
  if (v6 === undefined) return undefined;
  return ipv4MappedToIPv4(v6);
}

async function matchesA(
  name: string,
  ip4Prefix: number,
  ip6Prefix: number,
  args: CheckHostArgs,
  dns: SpfDns,
  state: CheckHostState,
  label: string,
): Promise<boolean> {
  const mappedV4 = clientAsIPv4(args);
  if (mappedV4 !== undefined) {
    const { records, void: isVoid } = await safeDns(dns.a(name), label);
    countVoid(state, isVoid, label);
    return records.some((addr) => {
      const candidate = parseIPv4(addr);
      return candidate !== undefined && ipv4CidrMatch(mappedV4, candidate, ip4Prefix);
    });
  }
  const clientV6 = parseIPv6(args.ip);
  if (clientV6 === undefined) return false;
  const { records, void: isVoid } = await safeDns(dns.aaaa(name), label);
  countVoid(state, isVoid, label);
  return records.some((addr) => {
    const candidate = parseIPv6(addr);
    return candidate !== undefined && ipv6CidrMatch(clientV6, candidate, ip6Prefix);
  });
}

function evalAll(): boolean {
  return true;
}

function evalIp4(mechanism: Extract<Mechanism, { type: 'ip4' }>, args: CheckHostArgs): boolean {
  const network = parseIPv4(mechanism.ip);
  if (network === undefined) throw new SpfPermError(`invalid ip4 network: ${mechanism.ip}`);
  const clientV4 = clientAsIPv4(args);
  if (clientV4 === undefined) return false;
  return ipv4CidrMatch(clientV4, network, mechanism.prefix);
}

function evalIp6(mechanism: Extract<Mechanism, { type: 'ip6' }>, args: CheckHostArgs): boolean {
  if (clientAsIPv4(args) !== undefined) return false;
  const network = parseIPv6(mechanism.ip);
  if (network === undefined) throw new SpfPermError(`invalid ip6 network: ${mechanism.ip}`);
  const clientV6 = parseIPv6(args.ip);
  if (clientV6 === undefined) return false;
  return ipv6CidrMatch(clientV6, network, mechanism.prefix);
}

async function evalExists(
  mechanism: Extract<Mechanism, { type: 'exists' }>,
  domain: string,
  args: CheckHostArgs,
  dns: SpfDns,
  state: CheckHostState,
): Promise<boolean> {
  const name = expandDomainSpec(mechanism.domainSpec, domain, args);
  const { records, void: isVoid } = await safeDns(dns.a(name), `exists:${name}`);
  countVoid(state, isVoid, `exists:${name}`);
  return records.length > 0;
}

async function evalA(
  mechanism: Extract<Mechanism, { type: 'a' }>,
  domain: string,
  args: CheckHostArgs,
  dns: SpfDns,
  state: CheckHostState,
): Promise<boolean> {
  const name = expandDomainSpec(mechanism.domainSpec, domain, args);
  return matchesA(name, mechanism.ip4Prefix, mechanism.ip6Prefix, args, dns, state, `a:${name}`);
}

async function evalMx(
  mechanism: Extract<Mechanism, { type: 'mx' }>,
  domain: string,
  args: CheckHostArgs,
  dns: SpfDns,
  state: CheckHostState,
): Promise<boolean> {
  const name = expandDomainSpec(mechanism.domainSpec, domain, args);
  const { records, void: isVoid } = await safeDns(dns.mx(name), `mx:${name}`);
  countVoid(state, isVoid, `mx:${name}`);
  if (records.length > MAX_MX_NAMES) {
    throw new SpfPermError(`mx:${name} resulted in more than ${String(MAX_MX_NAMES)} MX records (RFC 7208 SS4.6.4)`);
  }
  const sorted: SpfMxRecord[] = [...records].sort((a, b) => a.preference - b.preference);
  for (const mx of sorted) {
    const matched = await matchesA(mx.exchange, mechanism.ip4Prefix, mechanism.ip6Prefix, args, dns, state, `mx:${name}:${mx.exchange}`);
    if (matched) return true;
  }
  return false;
}

async function evalPtr(
  mechanism: Extract<Mechanism, { type: 'ptr' }>,
  domain: string,
  args: CheckHostArgs,
  dns: SpfDns,
  state: CheckHostState,
): Promise<boolean> {
  const target = expandDomainSpec(mechanism.domainSpec, domain, args);
  const { records, void: isVoid } = await safeDns(dns.ptr(args.ip), `ptr:${args.ip}`);
  countVoid(state, isVoid, `ptr:${args.ip}`);
  const candidates = records.slice(0, MAX_PTR_NAMES);
  for (const name of candidates) {
    const normalized = name.replace(/\.$/, '').toLowerCase();
    const wanted = target.replace(/\.$/, '').toLowerCase();
    if (normalized === wanted || normalized.endsWith(`.${wanted}`)) {
      // Forward-confirm: the candidate name must itself resolve back to the client IP.
      const confirmed = await matchesA(name, 32, 128, args, dns, state, `ptr:${name}`);
      if (confirmed) return true;
    }
  }
  return false;
}

/** RFC 7208 SS4-SS6: fetch and evaluate the SPF record published for `domain`. */
export async function checkHost(domain: string, args: CheckHostArgs, dns: SpfDns, state: CheckHostState): Promise<CheckHostOutcome> {
  state.trace.push(`check_host(${domain})`);

  let record: string;
  try {
    const { records: txt, void: isVoid } = await safeDns(dns.txt(domain), `txt:${domain}`);
    countVoid(state, isVoid, `txt:${domain}`);
    const selected = selectSpfRecord(txt);
    if (selected === NO_SPF_RECORD) {
      state.trace.push(`${domain}: no v=spf1 record -> none`);
      return { result: 'none' };
    }
    record = selected;
  } catch (err) {
    if (err instanceof SpfTempError) {
      state.trace.push(`${domain}: temporary DNS error fetching TXT: ${err.message}`);
      return { result: 'temperror' };
    }
    throw err;
  }

  let terms: Term[];
  try {
    terms = parseRecord(record);
  } catch (err) {
    if (err instanceof SpfPermError) {
      state.trace.push(`${domain}: permerror parsing record: ${err.message}`);
      return { result: 'permerror' };
    }
    throw err;
  }

  // Modifiers apply to the whole record regardless of where they appear relative to the
  // mechanism that ends up matching (RFC 7208 SS6), so they are collected before any mechanism
  // is evaluated.
  let explanationSpec: string | undefined;
  let redirectSpec: string | undefined;
  for (const term of terms) {
    if (term.kind === 'modifier') {
      if (term.modifier.type === 'exp') explanationSpec = term.modifier.domainSpec;
      if (term.modifier.type === 'redirect') redirectSpec = term.modifier.domainSpec;
    }
  }

  for (const term of terms) {
    if (term.kind === 'modifier') continue;

    const mechanism = term.mechanism;
    const mechanismText = `${mechanism.qualifier === '+' ? '' : mechanism.qualifier}${mechanism.type}`;
    let matched: boolean;

    switch (mechanism.type) {
      case 'all': {
        matched = evalAll();
        break;
      }
      case 'ip4': {
        matched = evalIp4(mechanism, args);
        break;
      }
      case 'ip6': {
        matched = evalIp6(mechanism, args);
        break;
      }
      case 'a': {
        countLookup(state, `a:${domain}`);
        matched = await evalA(mechanism, domain, args, dns, state);
        break;
      }
      case 'mx': {
        countLookup(state, `mx:${domain}`);
        matched = await evalMx(mechanism, domain, args, dns, state);
        break;
      }
      case 'ptr': {
        countLookup(state, `ptr:${domain}`);
        matched = await evalPtr(mechanism, domain, args, dns, state);
        break;
      }
      case 'exists': {
        countLookup(state, `exists:${domain}`);
        matched = await evalExists(mechanism, domain, args, dns, state);
        break;
      }
      case 'include': {
        countLookup(state, `include:${domain}`);
        const includedDomain = expandDomainSpec(mechanism.domainSpec, domain, args);
        const outcome = await checkHost(includedDomain, args, dns, state);
        // RFC 7208 SS5.2: map the included check_host() result to a match/no-match decision.
        if (outcome.result === 'pass') {
          matched = true;
        } else if (outcome.result === 'fail' || outcome.result === 'softfail' || outcome.result === 'neutral') {
          matched = false;
        } else if (outcome.result === 'temperror') {
          return { result: 'temperror' };
        } else {
          // "none" from the included domain (no record, or included record fell through) is a
          // permerror at the including mechanism.
          return { result: 'permerror' };
        }
        break;
      }
    }

    if (matched) {
      state.trace.push(`${domain}: matched ${mechanismText}`);
      const result = qualifierResult(mechanism.qualifier);
      if (result === 'fail' && explanationSpec !== undefined) {
        const explanation = await resolveExplanation(explanationSpec, domain, args, dns);
        return { result, mechanism: mechanismText, explanation };
      }
      return { result, mechanism: mechanismText };
    }
  }

  if (redirectSpec !== undefined) {
    countLookup(state, `redirect:${domain}`);
    const redirectDomain = expandDomainSpec(redirectSpec, domain, args);
    if (redirectDomain === domain) {
      throw new SpfPermError(`redirect= points back at the same domain: ${domain}`);
    }
    const outcome = await checkHost(redirectDomain, args, dns, state);
    // A "none" from the redirect target is itself a permerror (RFC 7208 SS6.1).
    if (outcome.result === 'none') return { result: 'permerror' };
    return outcome;
  }

  state.trace.push(`${domain}: fell off the end of the record -> neutral`);
  return { result: 'neutral' };
}

async function resolveExplanation(spec: string, domain: string, args: CheckHostArgs, dns: SpfDns): Promise<string | undefined> {
  try {
    const target = expandDomainSpec(spec, domain, args);
    const { records } = await safeDns(dns.txt(target), `exp:${target}`);
    const first = records[0];
    if (first === undefined) return undefined;
    const ctx = macroContext(domain, args);
    ctx.inExp = true;
    return expandMacros(first, ctx);
  } catch {
    // A broken exp= must never turn a well-formed "fail" into a temperror/permerror (SS6.2).
    return undefined;
  }
}
