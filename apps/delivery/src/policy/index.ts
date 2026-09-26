// Outbound TLS policy (PST-T-7.5, PST-REQ-126): for each MX host of a recipient domain, which TLS
// the session must have before it may send anything, and how the peer is judged once it has it.
//
//   DANE (RFC 7672) when the host's TLSA RRset is validated and usable. It takes precedence over
//   MTA-STS (RFC 8461 §2), host by host.
//   MTA-STS enforce: only hosts matching the policy's mx patterns, STARTTLS mandatory, WebPKI
//   certificate valid for the MX name. MTA-STS testing: opportunistic, but whatever would have
//   failed under enforce is recorded. Otherwise opportunistic (RFC 3207), as before.
//
// A mandatory policy that cannot be met is a temporary failure for that host; never a downgrade.
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import type { MxDnssec, Resolver } from '@postroom/dns';
import { lookupDane, peerChain, verifyDane, type TlsaRecord } from './dane.js';
import { lookupMtaSts, memoryPolicyCache, mxMatchesPolicy, type MtaStsCache, type MtaStsLookup, type MtaStsOptions } from './mta-sts.js';

export * from './dane.js';
export * from './mta-sts.js';

export type TlsPolicyKind = 'dane' | 'mta-sts-enforce' | 'mta-sts-testing' | 'opportunistic';

export type TlsPolicy =
  | { kind: 'opportunistic'; note?: string }
  | { kind: 'mta-sts-testing'; policyId: string; mxMatches: boolean }
  | { kind: 'mta-sts-enforce'; policyId: string }
  | { kind: 'dane'; records: TlsaRecord[]; names: string[] };

export type HostDecision = { use: true; policy: TlsPolicy } | { use: false; policyKind: TlsPolicyKind; reason: string };

/** Whether a policy forbids delivery without a verified TLS session. */
export function isMandatory(policy: TlsPolicy | undefined): boolean {
  return policy?.kind === 'dane' || policy?.kind === 'mta-sts-enforce';
}

export interface TlsPolicyOptions {
  resolver: Resolver;
  /** false turns MTA-STS off (tests of the old behaviour); otherwise options for the policy fetch. */
  mtaSts?: false | Omit<MtaStsOptions, 'resolver'>;
  /** Default true. */
  dane?: boolean;
  ipv4Only?: boolean;
}

export interface DomainTlsPlan {
  mtaSts: MtaStsLookup;
  decide: (host: string) => Promise<HostDecision>;
}

export interface TlsPlanner {
  plan: (domain: string, dnssec: MxDnssec) => Promise<DomainTlsPlan>;
}

export function createTlsPlanner(options: TlsPolicyOptions): TlsPlanner {
  const stsOptions = options.mtaSts === false ? undefined : { ...options.mtaSts, resolver: options.resolver, ...(options.ipv4Only === undefined ? {} : { ipv4Only: options.ipv4Only }) };
  const cache: MtaStsCache = stsOptions?.cache ?? memoryPolicyCache();
  const daneOn = options.dane ?? true;

  const plan = async (domain: string, dnssec: MxDnssec): Promise<DomainTlsPlan> => {
    const mtaSts: MtaStsLookup = stsOptions === undefined ? { kind: 'none', reason: 'MTA-STS disabled' } : await lookupMtaSts(domain, stsOptions, cache);
    const memo = new Map<string, Promise<HostDecision>>();

    const decideUncached = async (host: string): Promise<HostDecision> => {
      let daneNote: string | undefined;
      if (daneOn) {
        const dane = await lookupDane(options.resolver, host, dnssec.mx && (dnssec.hosts[host] ?? false));
        if (dane.kind === 'dane') return { use: true, policy: { kind: 'dane', records: dane.records, names: [bareName(host), bareName(domain)] } };
        if (dane.kind === 'unusable-host') return { use: false, policyKind: 'dane', reason: dane.reason };
        daneNote = dane.reason;
      }
      if (mtaSts.kind === 'policy' && mtaSts.policy.mode === 'enforce') {
        if (!mxMatchesPolicy(host, mtaSts.policy)) {
          return { use: false, policyKind: 'mta-sts-enforce', reason: `MX ${bareName(host)} is not in the MTA-STS policy for ${domain} (mx: ${mtaSts.policy.mx.join(', ')})` };
        }
        return { use: true, policy: { kind: 'mta-sts-enforce', policyId: mtaSts.id } };
      }
      if (mtaSts.kind === 'policy' && mtaSts.policy.mode === 'testing') {
        return { use: true, policy: { kind: 'mta-sts-testing', policyId: mtaSts.id, mxMatches: mxMatchesPolicy(host, mtaSts.policy) } };
      }
      return { use: true, policy: { kind: 'opportunistic', ...(daneNote === undefined ? {} : { note: daneNote }) } };
    };

    return {
      mtaSts,
      decide: (host) => {
        const key = bareName(host);
        let hit = memo.get(key);
        if (hit === undefined) {
          hit = decideUncached(host);
          memo.set(key, hit);
        }
        return hit;
      },
    };
  };
  return { plan };
}

function bareName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

export interface PeerVerdict {
  verified: boolean;
  reason: string;
}

/** WebPKI: the chain verified against our trust roots and the certificate is valid for the MX name. */
function webPki(secure: tls.TLSSocket, host: string): PeerVerdict {
  if (!secure.authorized) return { verified: false, reason: `certificate did not verify: ${String(secure.authorizationError)}` };
  const identity = tls.checkServerIdentity(bareName(host), secure.getPeerCertificate());
  if (identity !== undefined) return { verified: false, reason: `certificate not valid for ${bareName(host)}: ${identity.message}` };
  return { verified: true, reason: `certificate valid for ${bareName(host)}` };
}

/** Judge the TLS peer against the host's policy. Runs right after the handshake, before any command. */
export function verifyPeer(policy: TlsPolicy, secure: tls.TLSSocket, host: string): PeerVerdict {
  switch (policy.kind) {
    case 'dane': {
      let chain: X509Certificate[];
      try {
        chain = peerChain(secure);
      } catch (error) {
        return { verified: false, reason: `DANE: unreadable peer certificate: ${error instanceof Error ? error.message : String(error)}` };
      }
      const verdict = verifyDane(policy.records, chain, policy.names);
      return verdict.ok ? { verified: true, reason: verdict.detail } : { verified: false, reason: verdict.reason };
    }
    case 'mta-sts-enforce':
      return webPki(secure, host);
    case 'mta-sts-testing': {
      const verdict = webPki(secure, host);
      if (!policy.mxMatches) return { verified: false, reason: `MX ${bareName(host)} is not in the MTA-STS policy${verdict.verified ? '' : `; ${verdict.reason}`}` };
      return verdict;
    }
    case 'opportunistic':
      return secure.authorized ? { verified: true, reason: 'opportunistic; certificate verified' } : { verified: false, reason: `opportunistic; ${String(secure.authorizationError)}` };
  }
}

/** The line recorded on the DeliveryAttempt (tls_peer column) so the timeline shows the decision. */
export function describePolicy(kind: TlsPolicyKind, verified: boolean, reason: string): string {
  return `tls-policy=${kind}; policy-verified=${verified ? 'yes' : 'no'}; policy-reason=${reason.replace(/;/g, ',')}`;
}
