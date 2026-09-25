// Choosing a transport. The daemon runs the direct MX client (PST-T-1.6). `notBuiltTransport` is
// kept for tests: a transport that defers everything with a reason that says so.
import { createResolver } from '@postroom/dns';
import { createDirectTransport, DEFAULT_HELO_NAME } from '../client/transport.js';
import type { Log } from '../client/session.js';
import type { AttemptOutcome } from '../state.js';
import type { DeliveryRequest, DeliveryResult, Transport } from './types.js';

export type { AttemptDetails, DeliveryRecipient, DeliveryRequest, DeliveryResult, Transport } from './types.js';

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
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log): Transport {
  const localAddress = env['DELIVERY_LOCAL_ADDRESS'];
  return createDirectTransport({
    resolver: createResolver({ server: env['DNS_RESOLVER'] ?? '127.0.0.1:53' }),
    heloName: env['MX_HOSTNAME'] ?? DEFAULT_HELO_NAME,
    ipv4Only: env['DELIVERY_IPV6'] !== '1',
    ...(localAddress === undefined || localAddress === '' ? {} : { localAddress }),
    ...(log === undefined ? {} : { log }),
  });
}

/** Every transport the daemon runs, keyed by OutboundRecipient.transport ('ses' arrives in PST-T-1.11). */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log): Record<string, Transport> {
  return { direct: transportFromEnv(env, log) };
}
