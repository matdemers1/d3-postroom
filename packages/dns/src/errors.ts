// Typed errors for the DNS resolver client. Callers branch on `instanceof`, never on message text.

/** The resolver returned SERVFAIL. For our own validating Unbound (PST-REQ-064) this most often
 * means a DNSSEC-bogus answer: temporary/bogus, and never to be treated as "no such record". */
export class DnsServfailError extends Error {
  constructor(
    public readonly queryName: string,
    public readonly queryType: number,
  ) {
    super(`SERVFAIL resolving ${queryName} (type ${String(queryType)}) - possibly DNSSEC-bogus`);
    this.name = 'DnsServfailError';
  }
}

/** No usable response arrived within the configured tries/timeout. */
export class DnsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsTimeoutError';
  }
}

/** The response was malformed, or its id/question did not echo the query (anti-spoofing). */
export class DnsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsProtocolError';
  }
}

/** A DNSBL-style caller asked to query a known public resolver, which Spamhaus and friends
 * refuse to answer for anyway (PST-REQ-064: only our own validating resolver is trusted). */
export class DnsPublicResolverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsPublicResolverRefusedError';
  }
}
