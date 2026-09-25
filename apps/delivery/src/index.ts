// @postroom/delivery: the outbound queue (PST-T-1.5). Later tasks plug in here: the direct MX client
// (PST-T-1.6) as a Transport, DSN generation (PST-T-1.7) as the onDsn hook, SES (PST-T-1.11) as a
// second Transport, and the delivery-attempts API (PST-T-1.13) reading DeliveryAttempt rows.
export { DAEMON, describeDaemon } from './daemon.js';
export { enqueueOutbound, outboundJobKey, recipientDomain, directForEverything, OUTBOUND_QUEUE } from './enqueue.js';
export type { EnqueueOutboundInput, EnqueueOutboundOptions, EnqueuedOutbound, OutboundJobPayload, OutboundRecipientInput, TransportPolicy } from './enqueue.js';
export {
  nextState,
  parseNotify,
  baseDelayMs,
  jitteredDelayMs,
  canCancel,
  retrySchedule,
  JITTER,
  MAX_QUEUE_AGE_MS,
  DELAY_DSN_AFTER_MS,
} from './state.js';
export type { AttemptOutcome, DsnIntent, DsnKind, NotifyPolicy, RecipientSnapshot, Transition } from './state.js';
export { createDeliveryWorker, IN_FLIGHT, INTERRUPTED } from './worker.js';
export type { DeliveryWorker, DeliveryWorkerOptions, DsnHook, SweepResult } from './worker.js';
export { cancelRecipient, CannotCancelError } from './cancel.js';
export type { CancelWrite } from './cancel.js';
export { deliveryHealth } from './health.js';
export type { DeliveryHealth } from './health.js';
export { notBuiltTransport, transportFromEnv, transportsFromEnv, NOT_BUILT } from './transports/index.js';
export type { AttemptDetails, DeliveryRecipient, DeliveryRequest, DeliveryResult, Transport } from './transports/types.js';
