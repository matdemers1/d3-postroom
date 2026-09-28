// Choosing a transport. The daemon runs the direct MX client (PST-T-1.6). `notBuiltTransport` is
// kept for tests: a transport that defers everything with a reason that says so.
import { createResolver } from '@postroom/dns';
import { createDirectTransport, DEFAULT_HELO_NAME } from '../client/transport.js';
import type { Log } from '../client/session.js';
import type { AttemptOutcome } from '../state.js';
import { createSettingPolicyStore, type SettingDelegate } from '../policy/mta-sts.js';
import { createFcrdnsGuard, type FcrdnsGuard } from './fcrdns.js';
import { sesTransportFromEnv } from './ses.js';
import type { DeliveryRequest, DeliveryResult, Transport } from './types.js';

export type { AttemptDetails, DeliveryRecipient, DeliveryRequest, DeliveryResult, Transport } from './types.js';
export { createFcrdnsGuard, DEFAULT_STALE_VALID_MS, DEFAULT_TTL_MS } from './fcrdns.js';
export type { FcrdnsGuard, FcrdnsGuardOptions, FcrdnsLog, FcrdnsVerdict } from './fcrdns.js';
export { createSesTransport, parseSesDomains, sesClaims, sesConfigFromEnv, sesTransportFromEnv, SES_DEFAULT_PORT, SES_TRANSPORT } from './ses.js';
export type { SesConfig, SesTransport, SesTransportOptions } from './ses.js';

export const NOT_BUILT = 'direct delivery not built yet (PST-T-1.6)';

export function notBuiltTransport(name = 'direct'): Transport {
  return {
    name,
    deliver: (request: DeliveryRequest): Promise<DeliveryResult> => {
      const results: Record<string, AttemptOutcome> = {};
      for (const r of request.recipients) results[r.id] = { kind: 'temporary', text: NOT_BUILT };
      return Promise.resolve({ details: {}, results });
    },
  };
}

/**
 * The direct MX transport the daemon runs.
 *
 *   DNS_RESOLVER            our validating resolver, host:port (compose: unbound:53). Default 127.0.0.1:53.
 *   MX_HOSTNAME             EHLO name. Default mx.d3cloud.io.
 *   DELIVERY_IPV6=1         also look up and dial AAAA (off until IPv6 reverse DNS exists, PST-REQ-036).
 *   DELIVERY_LOCAL_ADDRESS  bind the source address (normally unset: the WireGuard netns routes tcp/25).
 */
/**
 * `setting` persists MTA-STS policies in the `setting` table (RFC 8461 §5: a policy outlives a
 * restart until its max_age, so an attacker who strips the TXT record after one cannot downgrade);
 * without it, policies live in memory only (tests).
 */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log, setting?: SettingDelegate): Transport {
  const localAddress = env['DELIVERY_LOCAL_ADDRESS'];
  return createDirectTransport({
    resolver: createResolver({ server: env['DNS_RESOLVER'] ?? '127.0.0.1:53' }),
    heloName: env['MX_HOSTNAME'] ?? DEFAULT_HELO_NAME,
    ipv4Only: env['DELIVERY_IPV6'] !== '1',
    ...(localAddress === undefined || localAddress === '' ? {} : { localAddress }),
    ...(log === undefined ? {} : { log }),
    ...(setting === undefined ? {} : { mtaSts: { cache: createSettingPolicyStore(setting) } }),
  });
}

/**
 * The FCrDNS guard the daemon runs (PST-T-4.16, PST-REQ-187):
 *
 *   EDGE_PUBLIC_IP  our egress IP; unset means FCrDNS can never hold, so direct never runs.
 *
 * Checked against the same DNS_RESOLVER and MX_HOSTNAME as the direct transport, cached for up to
 * 15 minutes.
 */
export function fcrdnsGuardFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log): FcrdnsGuard {
  return createFcrdnsGuard({
    edgeIp: env['EDGE_PUBLIC_IP'],
    heloName: env['MX_HOSTNAME'] ?? DEFAULT_HELO_NAME,
    resolver: createResolver({ server: env['DNS_RESOLVER'] ?? '127.0.0.1:53' }),
    ...(log === undefined ? {} : { log }),
  });
}

/**
 * Wrap `direct` so it never dials :25 while the FCrDNS guard says it must not (PST-REQ-187): an
 * eligible recipient goes through `ses` when it is configured, otherwise every recipient in the
 * attempt is deferred with the guard's reason recorded as the attempt's text. Once the guard says
 * FCrDNS holds, `direct` runs exactly as before.
 */
export function guardDirectTransport(direct: Transport, ses: Transport | undefined, guard: FcrdnsGuard): Transport {
  return {
    name: direct.name,
    ...(direct.claims === undefined ? {} : { claims: direct.claims }),
    deliver: async (request: DeliveryRequest): Promise<DeliveryResult> => {
      const verdict = await guard.check();
      if (verdict.valid) return direct.deliver(request);
      if (ses !== undefined) return ses.deliver(request);
      const results: Record<string, AttemptOutcome> = {};
      for (const r of request.recipients) results[r.id] = { kind: 'temporary', text: verdict.reason };
      return { details: {}, results };
    },
  };
}

/**
 * Every transport the daemon runs, keyed by OutboundRecipient.transport: 'direct' always, 'ses'
 * when SES credentials are configured (PST-T-1.11). The ses transport claims DELIVERY_SES_DOMAINS,
 * so the worker routes those recipients to it at each attempt; see transports/ses.ts. `direct` is
 * guarded by FCrDNS (PST-REQ-187): it will not dial :25 until PTR(EDGE_PUBLIC_IP) and A(MX_HOSTNAME)
 * both confirm the egress IP.
 */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log, setting?: SettingDelegate): Record<string, Transport> {
  const ses = sesTransportFromEnv(env, log);
  const direct = guardDirectTransport(transportFromEnv(env, log, setting), ses, fcrdnsGuardFromEnv(env, log));
  return { direct, ...(ses === undefined ? {} : { ses }) };
}
