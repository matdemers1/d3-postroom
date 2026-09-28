// The SES feedback poller's loop (PST-T-11.17): long-poll the queue, hand each message to the
// handler, and delete it only once the handler says so — which is only after its transaction
// committed, or after a refusal that will never change. A message left alone (a transient
// refusal, a database error) gets its visibility stretched on a back-off, so a certificate outage
// is retried over a couple of hours rather than burning its ten receives in twenty minutes; SQS then
// hands it out again.
//
// Receive failures: a transient one (network, 5xx, throttling) backs off 1 s → 60 s; a refused one
// (credentials, policy, queue gone) is logged and alerted once — through the D3 Auth relay — and
// retried every refusedRetryMs until it clears, when the recovery is logged. stop() aborts the long
// poll in flight and waits for the message being handled to finish.
import type { Disposition, Log } from './handler.js';
import { SqsError, type SqsClient, type SqsMessage } from './sqs.js';

type Alert = (message: { subject: string; text: string; key?: string }) => Promise<{ sent: boolean }>;

export interface SesFeedbackStatus {
  readonly enabled: true;
  readonly queue: string;
  /** When the last receive was sent (ISO 8601). */
  lastPollAt: string | null;
  /** When a receive last succeeded. */
  lastOkAt: string | null;
  lastError: { at: string; kind: string; code: string; message: string } | null;
  received: number;
  processed: number;
  refused: number;
  poison: number;
  retried: number;
  deleted: number;
}

export interface SesFeedbackLoop {
  stop(): Promise<void>;
  status(): SesFeedbackStatus;
  /** Resolves when the loop has exited (tests). */
  readonly done: Promise<void>;
}

export interface SesFeedbackLoopOptions {
  readonly sqs: SqsClient;
  readonly queue: string;
  readonly handle: (msg: SqsMessage) => Promise<Disposition>;
  readonly log: Log;
  readonly sendAlert: Alert;
  readonly now?: () => Date;
  /** First and largest back-off after a transient receive failure (default 1 s, 60 s). */
  readonly backoffMinMs?: number;
  readonly backoffMaxMs?: number;
  /** Retry interval while SQS refuses the credentials or policy (default 5 minutes). */
  readonly refusedRetryMs?: number;
  /** Visibility, in seconds, for a message left for redelivery after its nth receive. */
  readonly retryVisibility?: (receiveCount: number) => number;
}

/** 2, 4, 8 then 15 minutes: ten receives span about two hours, inside the 24 h Timestamp window. */
export function defaultRetryVisibility(receiveCount: number): number {
  return Math.min(900, 120 * 2 ** Math.max(0, receiveCount - 1));
}

export function startSesFeedbackLoop(opts: SesFeedbackLoopOptions): SesFeedbackLoop {
  const now = opts.now ?? ((): Date => new Date());
  const minMs = opts.backoffMinMs ?? 1_000;
  const maxMs = opts.backoffMaxMs ?? 60_000;
  const refusedRetryMs = opts.refusedRetryMs ?? 5 * 60_000;
  const retryVisibility = opts.retryVisibility ?? defaultRetryVisibility;
  const controller = new AbortController();
  let stopped = false;
  let refusedAlerted = false;
  let failures = 0;
  const status: SesFeedbackStatus = { enabled: true, queue: opts.queue, lastPollAt: null, lastOkAt: null, lastError: null, received: 0, processed: 0, refused: 0, poison: 0, retried: 0, deleted: 0 };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      }
      controller.signal.addEventListener('abort', done, { once: true });
    });

  const noteError = (kind: string, code: string, message: string): void => {
    status.lastError = { at: now().toISOString(), kind, code, message };
  };

  async function handleOne(msg: SqsMessage): Promise<void> {
    status.received++;
    let d: Disposition;
    try {
      d = await opts.handle(msg);
    } catch (e) {
      // A database error (or anything unexpected): leave it for redelivery.
      const message = e instanceof Error ? e.message : String(e);
      opts.log('ses-feedback-process-error', { sqsMessageId: msg.messageId, receiveCount: msg.receiveCount, error: message.slice(0, 300) });
      noteError('process', 'error', message.slice(0, 300));
      d = { action: 'retry', outcome: 'transient', code: 'error' };
    }
    if (d.action === 'delete') {
      if (d.outcome === 'processed') status.processed++;
      else if (d.outcome === 'refused') status.refused++;
      else status.poison++;
      try {
        await opts.sqs.delete(msg.receiptHandle);
        status.deleted++;
      } catch (e) {
        // Not deleted: it comes back after its visibility timeout, and the handler is idempotent.
        const code = e instanceof SqsError ? e.code : 'error';
        opts.log('ses-feedback-delete-failed', { sqsMessageId: msg.messageId, code, error: e instanceof Error ? e.message : String(e) });
        noteError('delete', code, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    status.retried++;
    try {
      await opts.sqs.changeVisibility(msg.receiptHandle, retryVisibility(msg.receiveCount));
    } catch (e) {
      // Best effort: without it the message simply returns after the queue's visibility timeout.
      opts.log('ses-feedback-visibility-failed', { sqsMessageId: msg.messageId, code: e instanceof SqsError ? e.code : 'error' });
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      let messages: SqsMessage[];
      status.lastPollAt = now().toISOString();
      try {
        messages = await opts.sqs.receive(controller.signal);
      } catch (e) {
        if (controller.signal.aborted) break;
        const err = e instanceof SqsError ? e : new SqsError('transient', 'error', 0, e instanceof Error ? e.message : String(e));
        noteError(err.kind, err.code, err.message);
        if (err.kind === 'refused') {
          if (!refusedAlerted) {
            refusedAlerted = true;
            opts.log('ses-feedback-sqs-refused', { code: err.code, status: err.status, error: err.message });
            await opts.sendAlert({
              key: 'ses-feedback-sqs-refused',
              subject: 'Postroom: the SES feedback queue refuses the worker',
              text: [
                `Receiving from the SES feedback queue ${opts.queue} failed with ${err.code} (HTTP ${String(err.status)}): ${err.message}`,
                '',
                'Bounces and complaints are not being processed. Check SES_FEEDBACK_AWS_ACCESS_KEY_ID / SES_FEEDBACK_AWS_SECRET_ACCESS_KEY, the IAM policy on the queue, and SES_FEEDBACK_SQS_URL.',
                `The worker keeps retrying every ${String(Math.round(refusedRetryMs / 1000))} s; messages wait on the queue (14-day retention).`,
              ].join('\n'),
            });
          }
          await sleep(refusedRetryMs);
        } else {
          failures++;
          const delay = Math.min(maxMs, minMs * 2 ** Math.min(failures - 1, 16));
          opts.log('ses-feedback-sqs-error', { code: err.code, status: err.status, error: err.message, retryInMs: delay });
          await sleep(delay);
        }
        continue;
      }
      if (refusedAlerted) {
        refusedAlerted = false;
        opts.log('ses-feedback-sqs-recovered', {});
      }
      failures = 0;
      status.lastOkAt = now().toISOString();
      for (const msg of messages) {
        // After stop(): the rest stay invisible for their timeout, then come back to the next worker.
        if (controller.signal.aborted) break;
        await handleOne(msg);
      }
    }
  }

  opts.log('ses-feedback-started', { queue: opts.queue });
  const done = run().catch((e: unknown) => {
    opts.log('ses-feedback-loop-crashed', { error: e instanceof Error ? e.message : String(e) });
  });

  return {
    async stop() {
      stopped = true;
      controller.abort();
      await done;
    },
    status: () => ({ ...status, lastError: status.lastError === null ? null : { ...status.lastError } }),
    done,
  };
}
