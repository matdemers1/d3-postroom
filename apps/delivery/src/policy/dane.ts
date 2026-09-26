// DANE for SMTP (RFC 7672 on RFC 6698/7671), hand-rolled: TLSA lookup at _25._tcp.<mx host>, record
// usability, and matching the chain the server presented (PST-T-7.5, PST-REQ-126).
//
//   §2.2    DANE applies only when the MX RRset, the host's address records and its TLSA RRset were
//           all DNSSEC-validated — the AD bit, trusted only from our own resolver (packages/dns trust.ts).
//           A TLSA lookup that fails (SERVFAIL, i.e. possibly bogus) makes the host unusable: no
//           fallback to cleartext, no fallback to opportunistic TLS.
//   §3.1.3  PKIX-TA(0) and PKIX-EE(1) are unusable for SMTP; so are unknown selectors/matching types
//           and digests of the wrong length. All records unusable = as if there were none.
//   §3.1.1  DANE-EE(3): the leaf's certificate or SPKI matches; names and dates are not checked.
//   §3.1.2  DANE-TA(2): a certificate in the presented chain matches, the chain from the leaf up to
//           it verifies, and the leaf's name matches the MX host (or the next-hop domain).
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { DnsServfailError, RCode, type Resolver } from '@postroom/dns';

export interface TlsaRecord {
  usage: number;
  selector: number;
  matchingType: number;
  data: Uint8Array;
}

export type DaneLookup =
  /** Validated TLSA records, at least one usable: DANE is mandatory for this host. */
  | { kind: 'dane'; records: TlsaRecord[] }
  /** DANE does not apply (unsigned, no TLSA, or every record unusable); `reason` says which. */
  | { kind: 'none'; reason: string }
  /** The TLSA lookup failed: the host must not be used at all this attempt. */
  | { kind: 'unusable-host'; reason: string };

export function tlsaName(mxHost: string, port = 25): string {
  return `_${String(port)}._tcp.${mxHost.toLowerCase().replace(/\.$/, '')}`;
}

const DIGEST_LENGTH: Record<number, number> = { 1: 32, 2: 64 };

/** RFC 7672 §3.1.3 / RFC 7671 §4: which records an SMTP client may act on. */
export function isUsableTlsa(r: TlsaRecord): boolean {
  if (r.usage !== 2 && r.usage !== 3) return false;
  if (r.selector !== 0 && r.selector !== 1) return false;
  if (r.matchingType === 0) return r.data.length > 0;
  const expected = DIGEST_LENGTH[r.matchingType];
  return expected !== undefined && r.data.length === expected;
}

/**
 * Look up the TLSA RRset for an MX host. `hostSecure` is whether the MX RRset and the host's address
 * lookups were validated; without that, DANE does not apply and no TLSA query is made.
 */
export async function lookupDane(resolver: Resolver, mxHost: string, hostSecure: boolean): Promise<DaneLookup> {
  if (!hostSecure) return { kind: 'none', reason: 'MX or address records not DNSSEC-validated' };
  const name = tlsaName(mxHost);
  let result;
  try {
    result = await resolver.tlsa(name);
  } catch (error) {
    const why = error instanceof DnsServfailError ? 'SERVFAIL (possibly DNSSEC-bogus)' : error instanceof Error ? error.message : String(error);
    return { kind: 'unusable-host', reason: `TLSA lookup for ${name} failed: ${why}` };
  }
  if (result.rcode !== RCode.NOERROR && result.rcode !== RCode.NXDOMAIN) {
    return { kind: 'unusable-host', reason: `TLSA lookup for ${name} answered rcode ${String(result.rcode)}` };
  }
  if (!result.ad) return { kind: 'none', reason: `TLSA answer for ${name} not DNSSEC-validated` };
  const records: TlsaRecord[] = [];
  for (const rr of result.answers) {
    if (rr.kind === 'TLSA') records.push({ usage: rr.usage, selector: rr.selector, matchingType: rr.matchingType, data: rr.certData });
  }
  if (records.length === 0) return { kind: 'none', reason: `no TLSA records at ${name}` };
  const usable = records.filter(isUsableTlsa);
  if (usable.length === 0) return { kind: 'none', reason: `all ${String(records.length)} TLSA record(s) at ${name} unusable` };
  return { kind: 'dane', records: usable };
}

function selected(cert: X509Certificate, selector: number): Buffer {
  return selector === 0 ? cert.raw : cert.publicKey.export({ type: 'spki', format: 'der' });
}

function digest(bytes: Buffer, matchingType: number): Buffer {
  if (matchingType === 1) return createHash('sha256').update(bytes).digest();
  if (matchingType === 2) return createHash('sha512').update(bytes).digest();
  return bytes;
}

export function tlsaMatches(record: TlsaRecord, cert: X509Certificate): boolean {
  return digest(selected(cert, record.selector), record.matchingType).equals(Buffer.from(record.data));
}

/** The chain the server presented, leaf first, as Node exposes it (the peer's chain plus any issuers it completed). */
export function peerChain(secure: tls.TLSSocket): X509Certificate[] {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  // Typed as Partial: at runtime the walk ends in an empty object or undefined, whatever the types say.
  let cert: Partial<tls.DetailedPeerCertificate> | undefined = secure.getPeerCertificate(true);
  while (cert !== undefined && Buffer.isBuffer(cert.raw)) {
    const fp = cert.fingerprint256 ?? '';
    if (seen.has(fp)) break;
    seen.add(fp);
    chain.push(new X509Certificate(cert.raw));
    // A self-signed root is its own issuer; the fingerprint set above ends the walk there.
    cert = cert.issuerCertificate;
  }
  return chain;
}

export type DaneVerdict = { ok: true; detail: string } | { ok: false; reason: string };

function describeRecord(r: TlsaRecord): string {
  return `${String(r.usage)} ${String(r.selector)} ${String(r.matchingType)}`;
}

function withinValidity(cert: X509Certificate, now: Date): boolean {
  return new Date(cert.validFrom) <= now && now <= new Date(cert.validTo);
}

/** Verify a presented chain against usable TLSA records (RFC 7672 §3). */
export function verifyDane(records: TlsaRecord[], chain: X509Certificate[], names: string[], now = new Date()): DaneVerdict {
  const leaf = chain[0];
  if (leaf === undefined) return { ok: false, reason: 'DANE: the server presented no certificate' };

  for (const r of records) {
    if (r.usage === 3 && tlsaMatches(r, leaf)) return { ok: true, detail: `DANE-EE ${describeRecord(r)} matched the leaf` };
  }

  const taRecords = records.filter((r) => r.usage === 2);
  let taReason = '';
  if (taRecords.length > 0) {
    const nameOk = names.some((n) => leaf.checkHost(n) !== undefined);
    // Walk up the chain: each certificate must be issued and signed by the next, until one matches.
    let chainOk = withinValidity(leaf, now);
    for (let i = 0; chainOk && i < chain.length; i++) {
      const cert = chain[i];
      if (cert === undefined) break;
      const matched = i > 0 ? taRecords.find((r) => tlsaMatches(r, cert)) : undefined;
      if (matched !== undefined) {
        if (!nameOk) return { ok: false, reason: `DANE-TA ${describeRecord(matched)} matched, but the certificate is not valid for ${names.join(' or ')}` };
        return { ok: true, detail: `DANE-TA ${describeRecord(matched)} matched chain certificate ${String(i)}` };
      }
      // A bare trust-anchor key (2 1 0) need not be in the chain: it must have signed this certificate.
      for (const r of taRecords) {
        if (r.selector === 1 && r.matchingType === 0) {
          try {
            const key = createPublicKey({ key: Buffer.from(r.data), format: 'der', type: 'spki' });
            if (cert.verify(key)) {
              if (!nameOk) return { ok: false, reason: `DANE-TA ${describeRecord(r)} key signed the chain, but the certificate is not valid for ${names.join(' or ')}` };
              return { ok: true, detail: `DANE-TA ${describeRecord(r)} key signed chain certificate ${String(i)}` };
            }
          } catch {
            // Not a parseable SPKI: this record cannot match; the others still might.
            continue;
          }
        }
      }
      const issuer = chain[i + 1];
      if (issuer === undefined) break;
      chainOk = cert.checkIssued(issuer) && cert.verify(issuer.publicKey) && withinValidity(issuer, now);
    }
    taReason = chainOk ? '; no DANE-TA record matched the chain' : '; the chain did not verify up to a DANE-TA match';
  }
  const fp = leaf.fingerprint256;
  return { ok: false, reason: `DANE: no TLSA record (${records.map(describeRecord).join(', ')}) matched the presented certificate (leaf SHA-256 ${fp})${taReason}` };
}
