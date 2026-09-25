// The outbound worker (PST-T-1.5): runs 'outbound' jobs on the Postgres queue, one job per
// (message, recipient domain), and moves each recipient through the state machine in state.ts.
//
// Exactly-once, and the one window where it cannot be had
// ─────────────────────────────────────────────────────────
// 1. Before touching the network the worker commits, per recipient, `state = attempting`,
//    `attempts + 1` and an open DeliveryAttempt row (finishedAt null). The UPDATE is guarded on
//    `state IN (queued, deferred)`, so two workers can never attempt one recipient at once.
// 2. The transport runs, bounded by `attemptTimeoutMs` (its AbortSignal), which must be shorter
//    than the job lease `leaseMs`.
// 3. The moment the transport returns, the new state and the attempt's outcome are committed.
// 4. A crash (kill -9) between 1 and 3 leaves the recipient `attempting` with an open attempt. Once
//    that attempt is older than the lease, no live worker can still own it (a live attempt ends
//    within attemptTimeoutMs < leaseMs), so recovery closes it as `error: interrupted`, returns the
//    recipient to `deferred`, and the queue's lease reclaim re-runs the job.
//
// A crash before the remote's final 250 therefore retries and delivers once. A crash after the
// remote sent 250 but before step 3 committed is indistinguishable from one before it, so the
// retry delivers a second copy. That window is a round trip to our own database; the transport
// contract (resolve on the DATA reply, QUIT afterwards) keeps it as small as it can be. RFC 5321
// §6.1 accepts duplicates over loss, and so do we.
import type { Readable } from 'node:stream';
import type { Db, Job, OutboundRecipient, Prisma } from '@postroom/db';
import { enqueue, type Handler } from '@postroom/queue';
import { OUTBOUND_QUEUE, outboundJobKey, type OutboundJobPayload } from './enqueue.js';
import { holdGroup, isCredentialFrozen } from './hold.js';
import { nextState, parseNotify, type AttemptOutcome, type DsnIntent } from './state.js';
import type { DeliveryResult, Transport } from './transports/types.js';

export const IN_FLIGHT = 'in flight';
export const INTERRUPTED = 'interrupted: the worker stopped mid-attempt (crash or kill); retrying';

export type DsnHook = (intent: DsnIntent) => Promise<void>;
export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface DeliveryWorkerOptions {
  db: Db;
  /** Keyed by OutboundRecipient.transport ('direct', 'ses'). */
  transports: Record<string, Transport>;
  /** Stream a message's bytes (the blob store's get). Never buffered whole. */
  openMessage: (sha256: string) => Promise<Readable>;
  /** DSN generation (PST-T-1.7). Its resolution is what marks a DSN sent; default: log it. */
  onDsn?: DsnHook;
  now?: () => Date;
  random?: () => number;
  /** The queue worker's lease; an attempt older than this is presumed dead. Default 5 minutes. */
  leaseMs?: number;
  /** Abort an attempt after this long. Must be below leaseMs. Default 4 minutes. */
  attemptTimeoutMs?: number;
  log?: Log;
}

export interface SweepResult {
  /** Recipients whose attempt was interrupted by a crash, returned to deferred. */
  recovered: number;
  /** Domain groups with work but no live job, given one. */
  rescheduled: number;
  /** Failure DSNs whose hook had not succeeded, re-emitted. */
  dsnRetried: number;
}

export interface DeliveryWorker {
  /** The 'outbound' queue handler. */
  handle: Handler;
  /** Crash recovery and orphan repair; run on start and periodically. */
  sweep: () => Promise<SweepResult>;
}

interface Group {
  messageId: string;
  domain: string;
}

function parsePayload(job: Job): Group {
  const p = job.payload as Partial<OutboundJobPayload> | null;
  if (p === null || typeof p !== 'object' || typeof p.messageId !== 'string' || typeof p.domain !== 'string') {
    throw new Error(`outbound job ${job.id} has a malformed payload`);
  }
  return { messageId: p.messageId, domain: p.domain };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createDeliveryWorker(options: DeliveryWorkerOptions): DeliveryWorker {
  const { db } = options;
  const clock = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const leaseMs = options.leaseMs ?? 300_000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 240_000;
  const log: Log = options.log ?? (() => undefined);
  const onDsn: DsnHook = options.onDsn ?? ((intent) => {
    log('dsn-intent', { kind: intent.kind, recipientId: intent.recipientId, address: intent.address, note: 'DSN generation is PST-T-1.7' });
    return Promise.resolve();
  });
  if (attemptTimeoutMs >= leaseMs) throw new Error(`attemptTimeoutMs (${attemptTimeoutMs}) must be below leaseMs (${leaseMs}): crash recovery depends on it`);

  /** Close attempts that no live worker can own any more, and return their recipients to deferred. */
  const recoverInterrupted = async (now: Date, group?: Group): Promise<number> => {
    const staleBefore = new Date(now.getTime() - leaseMs);
    const stuck = await db.outboundRecipient.findMany({
      where: {
        state: 'attempting',
        updatedAt: { lt: staleBefore },
        ...(group === undefined ? {} : { outboundMessageId: group.messageId, domain: group.domain }),
        attemptsLog: { none: { finishedAt: null, startedAt: { gte: staleBefore } } },
      },
      select: { id: true },
    });
    let recovered = 0;
    for (const { id } of stuck) {
      const done = await db.$transaction(async (tx) => {
        const moved = await tx.outboundRecipient.updateMany({
          where: { id, state: 'attempting' },
          data: { state: 'deferred', nextAttemptAt: now, lastCode: null, lastEnhanced: null, lastText: INTERRUPTED, updatedAt: now },
        });
        if (moved.count === 0) return false;
        await tx.deliveryAttempt.updateMany({
          where: { recipientId: id, finishedAt: null },
          data: { finishedAt: now, outcome: 'error', error: INTERRUPTED },
        });
        return true;
      });
      if (done) {
        recovered++;
        log('attempt-interrupted', { recipientId: id });
      }
    }
    return recovered;
  };

  /** Mark the group's due recipients attempting and open their attempts, in one commit. */
  const begin = async (group: Group, now: Date): Promise<{ recipient: OutboundRecipient; attemptId: string }[]> => {
    return db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE outbound_recipient
        SET state = 'attempting', attempts = attempts + 1, updated_at = ${now}
        WHERE outbound_message_id = ${group.messageId}::uuid
          AND domain = ${group.domain}
          AND state IN ('queued', 'deferred')
          AND next_attempt_at <= ${now}
        RETURNING id::text AS id`;
      if (rows.length === 0) return [];
      const recipients = await tx.outboundRecipient.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { address: 'asc' } });
      const out: { recipient: OutboundRecipient; attemptId: string }[] = [];
      for (const recipient of recipients) {
        const attempt = await tx.deliveryAttempt.create({
          data: { recipientId: recipient.id, startedAt: now, transport: recipient.transport, outcome: 'error', error: IN_FLIGHT },
          select: { id: true },
        });
        out.push({ recipient, attemptId: attempt.id });
      }
      return out;
    });
  };

  const runTransport = async (transport: Transport | undefined, request: Omit<Parameters<Transport['deliver']>[0], 'signal'>): Promise<DeliveryResult> => {
    if (transport === undefined) {
      return { details: {}, results: Object.fromEntries(request.recipients.map((r) => [r.id, { kind: 'error', error: 'no transport configured for this recipient' } satisfies AttemptOutcome])) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(new Error(`attempt timed out after ${attemptTimeoutMs} ms`)); }, attemptTimeoutMs);
    try {
      return await transport.deliver({ ...request, signal: controller.signal });
    } catch (error) {
      const text = errorText(error);
      log('transport-error', { transport: transport.name, domain: request.domain, error: text });
      return { details: {}, results: Object.fromEntries(request.recipients.map((r) => [r.id, { kind: 'error', error: text } satisfies AttemptOutcome])) };
    } finally {
      clearTimeout(timer);
    }
  };

  const emitDsn = async (intent: DsnIntent): Promise<void> => {
    try {
      await onDsn(intent);
    } catch (error) {
      // Not marked sent, so it is emitted again: a delay DSN on the next deferral, a failure DSN by sweep().
      log('dsn-hook-failed', { kind: intent.kind, recipientId: intent.recipientId, error: errorText(error) });
      return;
    }
    const at = clock();
    await db.outboundRecipient.updateMany({
      where: intent.kind === 'delay' ? { id: intent.recipientId, delayDsnSentAt: null } : { id: intent.recipientId, failureDsnSentAt: null },
      data: intent.kind === 'delay' ? { delayDsnSentAt: at } : { failureDsnSentAt: at },
    });
  };

  /** Give the group's remaining deferred/queued recipients a job at the earliest nextAttemptAt. */
  const scheduleNext = async (tx: Prisma.TransactionClient | Db, group: Group, generation?: string): Promise<boolean> => {
    const pending = await tx.outboundRecipient.aggregate({
      where: { outboundMessageId: group.messageId, domain: group.domain, state: { in: ['queued', 'deferred'] } },
      _min: { nextAttemptAt: true },
      _max: { attempts: true },
    });
    const runAt = pending._min.nextAttemptAt;
    if (runAt === null) return false;
    const payload: OutboundJobPayload = { ...group };
    const job = await enqueue(tx, OUTBOUND_QUEUE, { ...payload }, {
      runAt,
      maxAttempts: 1000,
      idempotencyKey: outboundJobKey(group.messageId, group.domain, generation ?? String(pending._max.attempts ?? 0)),
    });
    return job !== null;
  };

  const handle: Handler = async (job) => {
    const group = parsePayload(job);
    const startedAt = clock();
    await recoverInterrupted(startedAt, group);

    const message = await db.outboundMessage.findUnique({ where: { id: group.messageId }, include: { appPassword: { select: { frozenAt: true } } } });
    if (message === null) {
      log('outbound-message-missing', { job: job.id, messageId: group.messageId });
      return;
    }
    // PST-REQ-044: a frozen credential's queued mail waits, untouched, until it is thawed.
    if (isCredentialFrozen(message)) {
      await holdGroup(db, group, startedAt, log);
      return;
    }

    const claimed = await begin(group, startedAt);
    const byTransport = new Map<string, typeof claimed>();
    for (const c of claimed) byTransport.set(c.recipient.transport, [...(byTransport.get(c.recipient.transport) ?? []), c]);

    for (const [transportName, batch] of byTransport) {
      const result = await runTransport(options.transports[transportName], {
        envelopeFrom: message.envelopeFrom,
        domain: group.domain,
        recipients: batch.map(({ recipient }) => ({ id: recipient.id, address: recipient.address, notify: recipient.dsnNotify })),
        message: () => options.openMessage(message.blobSha256),
        size: message.size,
        dsnRet: message.dsnRet,
        dsnEnvid: message.dsnEnvid,
      });
      const finishedAt = clock();
      const intents: DsnIntent[] = [];
      // Commit every recipient's outcome at once, straight after the transport returned.
      await db.$transaction(async (tx) => {
        for (const { recipient, attemptId } of batch) {
          const outcome: AttemptOutcome = result.results[recipient.id] ?? { kind: 'error', error: 'transport returned no result for this recipient' };
          const t = nextState(recipient, outcome, finishedAt, random);
          const moved = await tx.outboundRecipient.updateMany({
            where: { id: recipient.id, state: 'attempting' },
            data: {
              state: t.state,
              nextAttemptAt: t.nextAttemptAt,
              lastCode: t.lastCode,
              lastEnhanced: t.lastEnhanced,
              lastText: t.lastText,
              ...(t.deliveredAt === null ? {} : { deliveredAt: t.deliveredAt }),
              updatedAt: finishedAt,
            },
          });
          if (moved.count === 0) {
            // Recovery took it: it believed this attempt dead. That only happens if the attempt
            // outlived the lease, which attemptTimeoutMs < leaseMs is meant to rule out.
            log('attempt-lost-race', { recipientId: recipient.id, attemptId, outcome: t.attemptOutcome });
          } else {
            intents.push(...t.dsn);
          }
          await tx.deliveryAttempt.update({
            where: { id: attemptId },
            data: {
              finishedAt,
              transport: options.transports[transportName]?.name ?? transportName,
              outcome: moved.count === 0 ? 'error' : t.attemptOutcome,
              error: outcome.kind === 'error' ? outcome.error : (moved.count === 0 ? 'finished after recovery had closed the attempt' : null),
              remoteCode: outcome.kind === 'error' ? null : (outcome.code ?? null),
              remoteEnhanced: outcome.kind === 'error' ? null : (outcome.enhanced ?? null),
              remoteText: outcome.kind === 'error' ? null : (outcome.text ?? null),
              mxHost: result.details.mxHost ?? null,
              mxIp: result.details.mxIp ?? null,
              localIp: result.details.localIp ?? null,
              tlsVersion: result.details.tlsVersion ?? null,
              tlsCipher: result.details.tlsCipher ?? null,
              tlsPeer: result.details.tlsPeer ?? null,
            },
          });
          log('attempt-finished', { recipientId: recipient.id, outcome: t.attemptOutcome, state: t.state, code: t.lastCode, next: t.state === 'deferred' ? t.nextAttemptAt.toISOString() : undefined });
        }
        await scheduleNext(tx, group);
      });
      for (const intent of intents) await emitDsn(intent);
    }
    if (claimed.length === 0) await scheduleNext(db, group);
  };

  const sweep = async (): Promise<SweepResult> => {
    const now = clock();
    const staleBefore = new Date(now.getTime() - leaseMs);
    const recovered = await recoverInterrupted(now);

    // Groups with work to do and no live job: a job that went dead, or one lost to a bug. Never lost.
    const orphans = await db.$queryRaw<{ message_id: string; domain: string }[]>`
      SELECT DISTINCT r.outbound_message_id::text AS message_id, r.domain
      FROM outbound_recipient r
      WHERE r.state IN ('queued', 'deferred')
        AND NOT EXISTS (
          SELECT 1 FROM job j
          WHERE j.queue = ${OUTBOUND_QUEUE}
            AND j.status IN ('pending', 'running')
            AND j.payload->>'messageId' = r.outbound_message_id::text
            AND j.payload->>'domain' = r.domain)`;
    let rescheduled = 0;
    for (const o of orphans) {
      if (await scheduleNext(db, { messageId: o.message_id, domain: o.domain }, `sweep-${now.getTime()}`)) rescheduled++;
    }
    if (rescheduled > 0) log('orphans-rescheduled', { count: rescheduled });

    // Bounced recipients whose failure DSN hook never succeeded.
    const unsent = await db.outboundRecipient.findMany({
      where: {
        state: 'bounced',
        failureDsnSentAt: null,
        updatedAt: { lt: staleBefore },
        OR: [{ dsnNotify: null }, { dsnNotify: '' }, { dsnNotify: { contains: 'FAILURE', mode: 'insensitive' } }],
      },
      take: 100,
    });
    let dsnRetried = 0;
    for (const r of unsent) {
      if (!parseNotify(r.dsnNotify).failure) continue;
      dsnRetried++;
      await emitDsn({
        kind: 'failure',
        recipientId: r.id,
        outboundMessageId: r.outboundMessageId,
        address: r.address,
        code: r.lastCode,
        enhanced: r.lastEnhanced,
        text: r.lastText ?? '',
        queuedAt: r.createdAt,
        at: now,
      });
    }
    return { recovered, rescheduled, dsnRetried };
  };

  return { handle, sweep };
}
