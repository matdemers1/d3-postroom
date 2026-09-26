// DNSBL client via our own resolver and a Spamhaus DQS key; refuses public resolvers
// (PST-REQ-058, PST-REQ-063).
export { TtlLru } from './cache.js';
export { DNSBL_ERROR_CODES, isErrorCode, listForCode, shouldReject } from './codes.js';
export type { SpamhausList } from './codes.js';
export { createDnsblChecker, publicZoneName } from './checker.js';
export type { CreateDnsblCheckerOptions, DnsblChecker, DnsblHealth, DnsblLog, DnsblLookupResult } from './checker.js';
export { dnsblQueryName, reversedAddressLabels } from './name.js';

export const PACKAGE = '@postroom/dnsbl';
