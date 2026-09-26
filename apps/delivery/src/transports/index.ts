// Choosing a transport. The daemon runs the direct MX client (PST-T-1.6). `notBuiltTransport` is
// kept for tests: a transport that defers everything with a reason that says so.
import { createResolver } from '@postroom/dns';
import { createDirectTransport, DEFAULT_HELO_NAME } from '../client/transport.js';
import type { Log } from '../client/session.js';
import type { AttemptOutcome } from '../state.js';
import { createSettingPolicyStore, type SettingDelegate } from '../policy/mta-sts.js';
import { sesTransportFromEnv } from './ses.js';
import type { DeliveryRequest, DeliveryResult, Transport } from './types.js';

export type { AttemptDetails, DeliveryRecipient, DeliveryRequest, DeliveryResult, Transport } from './types.js';
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
 * Every transport the daemon runs, keyed by OutboundRecipient.transport: 'direct' always, 'ses'
 * when SES credentials are configured (PST-T-1.11). The ses transport claims DELIVERY_SES_DOMAINS,
 * so the worker routes those recipients to it at each attempt; see transports/ses.ts.
 */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log, setting?: SettingDelegate): Record<string, Transport> {
  const ses = sesTransportFromEnv(env, log);
  return { direct: transportFromEnv(env, log, setting), ...(ses === undefined ? {} : { ses }) };
}
