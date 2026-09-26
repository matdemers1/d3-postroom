// The seam between the outbound queue (PST-T-1.5) and whatever puts bytes on the wire: direct MX
// delivery (PST-T-1.6, apps/delivery/src/client) and the SES fallback (PST-T-1.11). The queue owns
// states, schedules and crash recovery; a transport owns one attempt and reports what it saw.
import type { Readable } from 'node:stream';
import type { AttemptOutcome } from '../state.js';

export interface DeliveryRecipient {
  /** OutboundRecipient.id: the key the result must use. */
  id: string;
  address: string;
  /** RFC 3461 NOTIFY for this recipient, to pass on to a DSN-capable MX; null = not given. */
  notify: string | null;
}

export interface DeliveryRequest {
  /** RFC 5321 reverse-path; '' is the null sender (a DSN). */
  envelopeFrom: string;
  /** Lowercased recipient domain; every recipient here shares it and one SMTP transaction. */
  domain: string;
  recipients: readonly DeliveryRecipient[];
  /** The signed message, streamed from the blob store. Call at most once per attempt; never buffer it whole. */
  message: () => Promise<Readable>;
  /** Message size in bytes, for SIZE=. */
  size: number;
  /** MAIL FROM DSN parameters (RFC 3461): RET=FULL|HDRS and ENVID. */
  dsnRet: string | null;
  dsnEnvid: string | null;
  /**
   * Aborted when the attempt has run for the worker's attempt timeout. A transport must give up
   * promptly when it fires: the crash-recovery rule depends on an attempt never outliving the
   * job lease (see worker.ts).
   */
  signal: AbortSignal;
}

/** What the attempt learned about the connection, recorded on every DeliveryAttempt row. */
export interface AttemptDetails {
  mxHost?: string;
  mxIp?: string;
  localIp?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  tlsPeer?: string;
}

export interface DeliveryResult {
  details: AttemptDetails;
  /** Keyed by DeliveryRecipient.id. A recipient with no entry is treated as an `error` (temporary). */
  results: Record<string, AttemptOutcome>;
}

/**
 * One delivery attempt for one domain group.
 *
 * Resolve as soon as the final reply to DATA is read, and send QUIT afterwards: the queue commits
 * `delivered` the moment this resolves, and the time between the remote's 250 and that commit is
 * the one window in which a crash can cause a duplicate (see worker.ts). Rejecting is equivalent
 * to returning `{ kind: 'error' }` for every recipient.
 */
export interface Transport {
  /** Recorded as DeliveryAttempt.transport: 'direct' | 'ses' | a test name. */
  readonly name: string;
  /**
   * Whether this transport takes over a recipient domain whatever the recipient was enqueued with
   * (the SES fallback's DELIVERY_SES_DOMAINS). Decided by the worker at each attempt.
   */
  claims?: (domain: string) => boolean;
  deliver: (request: DeliveryRequest) => Promise<DeliveryResult>;
}
