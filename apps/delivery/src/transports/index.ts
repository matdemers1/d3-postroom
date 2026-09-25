// Choosing a transport. The direct MX client is PST-T-1.6; until it lands the daemon runs a
// transport that defers everything with a reason that says so, so a queued message waits (and is
// visible as waiting) rather than looking delivered.
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

/** The direct transport the daemon runs. PST-T-1.6 replaces the body with the real MX client. */
export function transportFromEnv(_env: NodeJS.ProcessEnv = process.env): Transport {
  return notBuiltTransport('direct');
}

/** Every transport the daemon runs, keyed by OutboundRecipient.transport ('ses' arrives in PST-T-1.11). */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, Transport> {
  return { direct: transportFromEnv(env) };
}
