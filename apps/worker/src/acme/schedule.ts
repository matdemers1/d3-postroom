// The worker's ACME timer (PST-T-0.15): a first check shortly after start, then one every hour.
// A check is local and cheap — read the pair on disk, decide — and only a certificate that is due
// (under ACME_RENEW_DAYS, missing, or not covering ACME_DOMAINS) reaches the network, so in
// practice Let's Encrypt is contacted about once every 60 days. After a failure the job's own
// back-off (1 h, 3 h, 6 h, 12 h, then daily) keeps retries to a few a day, well inside the CA's
// failed-validation limits. Two workers (or a worker and `postroom acme`) never overlap: the job
// takes a lease in the database.
import type { Log } from './client.js';
import { runAcme, type AcmeDeps, type AcmeRunResult } from './job.js';

export interface AcmeLoop {
  stop: () => void;
}

export interface AcmeLoopOptions {
  readonly deps: AcmeDeps;
  readonly log: Log;
  readonly startDelayMs?: number;
  readonly intervalMs?: number;
  /** Called after every run (tests). */
  readonly onResult?: (result: AcmeRunResult) => void;
}

export function startAcmeLoop(opts: AcmeLoopOptions): AcmeLoop {
  if (!opts.deps.config.enabled) {
    opts.log('acme-disabled', { missing: opts.deps.config.missing });
    return { stop: () => undefined };
  }
  let busy = false;
  let stopped = false;
  const run = (): void => {
    if (busy || stopped) return;
    busy = true;
    runAcme(opts.deps).then(
      (result) => {
        busy = false;
        // not-due is the common case: logged quietly, with the days left.
        opts.log(result.action === 'not-due' ? 'acme-check' : 'acme-result', {
          ok: result.ok,
          action: result.action,
          ...(result.daysLeft === undefined ? {} : { daysLeft: Math.round(result.daysLeft * 10) / 10 }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        opts.onResult?.(result);
      },
      (error: unknown) => {
        busy = false;
        opts.log('acme-error', { error: error instanceof Error ? error.message : String(error) });
      },
    );
  };
  const first = setTimeout(run, opts.startDelayMs ?? 60_000);
  first.unref();
  const timer = setInterval(run, opts.intervalMs ?? 3_600_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
