// Stub DNS resolver client to the local validating Unbound: MX/A/AAAA/TXT/TLSA with AD-bit
// handling (PST-REQ-031, PST-REQ-064). Hand-rolled wire format, no DNS libraries.
export { DnsProtocolError, DnsPublicResolverRefusedError, DnsServfailError, DnsTimeoutError } from './errors.js';
export { resolveMxTargets } from './mx.js';
export type { MxResolution, MxTarget, ResolveMxOptions } from './mx.js';
export { decodeName, encodeName, normalizeName } from './name.js';
export { createResolver, reverseDnsName } from './resolver.js';
export type { ResolverOptions } from './resolver.js';
export { isTrustedResolverAddress, parseServer, refuseIfPublicResolver } from './trust.js';
export type { ParsedServer } from './trust.js';
export { DNS_CLASS_IN, RCode, RRType } from './types.js';
export type {
  DecodeResult,
  DnsAnswer,
  DnsMessage,
  DnsQuestion,
  Resolver,
  ResolverResult,
  RRTypeValue,
} from './types.js';
export { decodeMessage, encodeQuery } from './wire.js';
export type { EncodedQuery, EncodeQueryOptions } from './wire.js';
