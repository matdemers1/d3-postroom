// The FCrDNS guard wired onto the direct transport (PST-T-4.16, PST-REQ-187): while it does not
// hold, a recipient eligible for direct delivery goes through SES when SES is configured, and
// otherwise is deferred with the reason recorded on the attempt. Once it holds, direct proceeds
// unchanged, and the guard is never consulted at all when SES already claims the domain (that
// routing decision is `routeByClaims`'s, untouched here).
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AttemptOutcome } from '../../src/state.js';
import { guardDirectTransport } from '../../src/transports/index.js';
import type { DeliveryRequest, DeliveryResult, Transport } from '../../src/transports/types.js';
import type { FcrdnsGuard, FcrdnsVerdict } from '../../src/transports/fcrdns.js';

function request(): DeliveryRequest {
  return {
    envelopeFrom: 'me@d3cloud.io',
    domain: 'example.test',
    recipients: [
      { id: 'r1', address: 'a@example.test', notify: null },
      { id: 'r2', address: 'b@example.test', notify: null },
    ],
    message: () => Promise.resolve(Readable.from([Buffer.from('Subject: hi\r\n\r\nbody\r\n')])),
    size: 22,
    dsnRet: null,
    dsnEnvid: null,
    signal: new AbortController().signal,
  };
}

function stubGuard(verdict: FcrdnsVerdict): FcrdnsGuard & { calls: number } {
  const guard = { calls: 0, check: (): Promise<FcrdnsVerdict> => { guard.calls++; return Promise.resolve(verdict); } };
  return guard;
}

function stubTransport(name: string, outcome: AttemptOutcome, details: DeliveryResult['details'] = {}): Transport & { calls: number } {
  const t = {
    calls: 0,
    name,
    deliver: (req: DeliveryRequest): Promise<DeliveryResult> => {
      t.calls++;
      const results: Record<string, AttemptOutcome> = {};
      for (const r of req.recipients) results[r.id] = outcome;
      return Promise.resolve({ details, results });
    },
  };
  return t;
}

describe('guardDirectTransport', () => {
  it('delegates to direct, unchanged, when the guard says FCrDNS holds', async () => {
    const direct = stubTransport('direct', { kind: 'delivered', code: 250 }, { mxHost: 'mx.other.test' });
    const ses = stubTransport('ses', { kind: 'delivered', code: 250 });
    const guard = stubGuard({ valid: true });
    const guarded = guardDirectTransport(direct, ses, guard);

    const result = await guarded.deliver(request());
    expect(direct.calls).toBe(1);
    expect(ses.calls).toBe(0);
    expect(result.details).toEqual({ mxHost: 'mx.other.test' });
    expect(result.results['r1']).toEqual({ kind: 'delivered', code: 250 });
  });

  it('goes through SES instead when FCrDNS does not hold and SES is configured', async () => {
    const direct = stubTransport('direct', { kind: 'delivered', code: 250 });
    const ses = stubTransport('ses', { kind: 'delivered', code: 250 }, { mxHost: 'email-smtp.us-east-1.amazonaws.com' });
    const guard = stubGuard({ valid: false, reason: 'FCrDNS not yet valid: PTR is ec2-18-208-39-127.compute-1.amazonaws.com, expected mx.d3cloud.io' });
    const guarded = guardDirectTransport(direct, ses, guard);

    const result = await guarded.deliver(request());
    expect(direct.calls).toBe(0);
    expect(ses.calls).toBe(1);
    expect(result.details).toEqual({ mxHost: 'email-smtp.us-east-1.amazonaws.com' });
    // The attempt is recorded as carried by SES, not as the 'direct' key it was routed to.
    expect(result.transport).toBe('ses');
  });

  it('defers every recipient with the reason when FCrDNS does not hold and SES is not configured', async () => {
    const direct = stubTransport('direct', { kind: 'delivered', code: 250 });
    const reason = 'FCrDNS not yet valid: EDGE_PUBLIC_IP is not set';
    const guard = stubGuard({ valid: false, reason });
    const guarded = guardDirectTransport(direct, undefined, guard);

    const result = await guarded.deliver(request());
    expect(direct.calls).toBe(0);
    expect(result.results['r1']).toEqual({ kind: 'temporary', text: reason });
    expect(result.results['r2']).toEqual({ kind: 'temporary', text: reason });
  });

  it('keeps the direct transport name, so routing and logging still see it as "direct"', () => {
    const guarded = guardDirectTransport(stubTransport('direct', { kind: 'delivered', code: 250 }), undefined, stubGuard({ valid: true }));
    expect(guarded.name).toBe('direct');
  });
});
