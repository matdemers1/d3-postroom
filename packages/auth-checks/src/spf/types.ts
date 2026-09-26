// Shared types for the SPF evaluator (RFC 7208).

export type SpfResult = 'none' | 'neutral' | 'pass' | 'fail' | 'softfail' | 'temperror' | 'permerror';

export interface SpfMxRecord {
  preference: number;
  exchange: string;
}

/** A DNS lookup that participates in the void-lookup count (RFC 7208 SS4.6.4): "void" means a
 * NOERROR response with zero matching records, or NXDOMAIN. Neither is a DNS-level error. */
export interface SpfLookupResult<T> {
  records: T[];
  void: boolean;
}

/** The evaluator's own view of DNS, kept narrow and synchronous-friendly for testing. A
 * temporary DNS failure (timeout, SERVFAIL) is thrown as SpfTempError, never returned. */
export interface SpfDns {
  txt: (name: string) => Promise<SpfLookupResult<string>>;
  a: (name: string) => Promise<SpfLookupResult<string>>;
  aaaa: (name: string) => Promise<SpfLookupResult<string>>;
  mx: (name: string) => Promise<SpfLookupResult<SpfMxRecord>>;
  ptr: (ip: string) => Promise<SpfLookupResult<string>>;
}

export interface EvaluateSpfOptions {
  /** The SMTP client's IP address (IPv4 or IPv6; an IPv4-mapped IPv6 address is treated as
   * IPv4 per RFC 7208 SS5). */
  ip: string;
  /** MAIL FROM address, or null/undefined for a null reverse-path (SS4.1: identity becomes
   * postmaster@HELO). */
  mailFrom: string | null | undefined;
  /** The HELO/EHLO identity, used as the check_host() domain when mailFrom is null, and always
   * available as the `%{h}` macro. */
  helo: string;
  dns: SpfDns;
  /** Domain name of the host performing the check, used only by the `%{r}` macro in exp=. */
  receiver?: string | undefined;
  /** Fixed timestamp for the `%{t}` macro in exp=, for deterministic tests. Defaults to now. */
  now?: number | undefined;
}

export interface EvaluateSpfResult {
  result: SpfResult;
  /** The domain the identity was evaluated for (the initial check_host() domain). */
  domain: string;
  scope: 'mfrom' | 'helo';
  /** Present only on a `fail` result whose matching mechanism carried a nearby exp= modifier. */
  explanation?: string | undefined;
  /** The mechanism term that produced the result, e.g. "-all" or "+ip4:192.0.2.0/24". */
  mechanism?: string | undefined;
  lookups: number;
  voidLookups: number;
  trace: string[];
}
