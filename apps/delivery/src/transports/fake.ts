// A scriptable transport for tests: decide each recipient's outcome with a function, and keep a log
// of every call so a test can assert what was attempted, when, and with which bytes.
import type { AttemptOutcome } from '../state.js';
import type { AttemptDetails, DeliveryRequest, DeliveryResult, Transport } from './types.js';

export type FakeScript = (recipient: { id: string; address: string }, request: DeliveryRequest, call: number) => AttemptOutcome;

export interface FakeCall {
  domain: string;
  addresses: string[];
  /** The message bytes the transport read from the stream (only when `readMessage` is on). */
  bytes: number;
}

export class FakeTransport implements Transport {
  readonly name: string;
  readonly calls: FakeCall[] = [];
  private readonly script: FakeScript;
  private readonly details: AttemptDetails;
  private readonly readMessage: boolean;

  constructor(options: { script: FakeScript; name?: string; details?: AttemptDetails; readMessage?: boolean }) {
    this.script = options.script;
    this.name = options.name ?? 'fake';
    this.details = options.details ?? { mxHost: 'mx.fake.test', mxIp: '192.0.2.1' };
    this.readMessage = options.readMessage ?? false;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    let bytes = 0;
    if (this.readMessage) {
      const stream = await request.message();
      for await (const chunk of stream) bytes += (chunk as Buffer).length;
    }
    const call = this.calls.length;
    this.calls.push({ domain: request.domain, addresses: request.recipients.map((r) => r.address), bytes });
    const results: Record<string, AttemptOutcome> = {};
    for (const r of request.recipients) results[r.id] = this.script(r, request, call);
    return { details: this.details, results };
  }
}

/** Shorthand outcomes for scripts. */
export const reply = {
  ok: (text = 'OK queued'): AttemptOutcome => ({ kind: 'delivered', code: 250, enhanced: '2.0.0', text }),
  tempfail: (text = 'Try again later'): AttemptOutcome => ({ kind: 'temporary', code: 451, enhanced: '4.3.0', text }),
  reject: (text = 'No such user'): AttemptOutcome => ({ kind: 'permanent', code: 550, enhanced: '5.1.1', text }),
};
