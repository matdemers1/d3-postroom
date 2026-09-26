export { checkHost, newCheckHostState, type CheckHostArgs, type CheckHostOutcome, type CheckHostState } from './check-host.js';
export { adaptDnsResolver } from './dns-adapter.js';
export { authResultsSpf, evaluateSpf } from './evaluate.js';
export { SpfPermError, SpfTempError } from './errors.js';
export { ipv4CidrMatch, ipv6CidrMatch, ipv4MappedToIPv4, ipv6ToDottedNibbles, parseIPv4, parseIPv6 } from './ip.js';
export { domainPart, expandMacros, localPart, type MacroContext } from './macro.js';
export { NO_SPF_RECORD, parseRecord, parseTerm, selectSpfRecord, type Mechanism, type Modifier, type Qualifier, type Term } from './parse.js';
export type {
  EvaluateSpfOptions,
  EvaluateSpfResult,
  SpfDns,
  SpfLookupResult,
  SpfMxRecord,
  SpfResult,
} from './types.js';
