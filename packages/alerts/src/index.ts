// Operator alerts through the D3 Auth mail relay (PST-REQ-096), never Postroom's own queue.
//
// The same HTTP contract Shipyard's mailer uses: one POST, a bearer token, `{to, subject, text}`.
// A caller with no relay configured (or one that cannot be reached) must never see a thrown error —
// an alert that cannot be sent must not take down whatever tried to send it — and the same alert
// (by `key`, default the subject) is suppressed for an hour so a repeating condition does not train
// its reader to ignore it.
export const PACKAGE = '@postroom/alerts';

export interface AlertConfig {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly to?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AlertMessage {
  readonly subject: string;
  readonly text: string;
  /** Dedupe key; the same key is sent at most once per hour. Defaults to `subject`. */
  readonly key?: string | undefined;
}

export interface AlertResult {
  readonly sent: boolean;
  /** Why it was not sent, when it was not. */
  readonly reason?: string | undefined;
}

export type SendAlert = (message: AlertMessage) => Promise<AlertResult>;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface AlertSenderOptions {
  readonly now?: () => Date;
  readonly log?: Log;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const REPEAT_AFTER_MS = 60 * 60 * 1000;

function isConfigured(config: AlertConfig): config is AlertConfig & { url: string; token: string; to: string } {
  return (config.url ?? '') !== '' && (config.token ?? '') !== '' && (config.to ?? '') !== '';
}

/**
 * Build a `SendAlert` bound to one relay configuration. Never throws: a relay that cannot be
 * reached, that answers with an error status, or that is simply unconfigured all resolve to
 * `{ sent: false }` with a reason, after a structured log line.
 */
export function createAlertSender(config: AlertConfig, options: AlertSenderOptions = {}): SendAlert {
  const now = options.now ?? ((): Date => new Date());
  const log = options.log ?? ((): void => undefined);
  const lastSent = new Map<string, number>();

  return async (message: AlertMessage): Promise<AlertResult> => {
    const key = message.key ?? message.subject;
    const nowMs = now().getTime();
    const last = lastSent.get(key);
    if (last !== undefined && nowMs - last < REPEAT_AFTER_MS) {
      log('alert-not-sent', { reason: 'deduped', key });
      return { sent: false, reason: 'deduped' };
    }
    if (!isConfigured(config)) {
      log('alert-not-sent', { reason: 'relay unconfigured', key });
      return { sent: false, reason: 'relay unconfigured' };
    }
    const doFetch = config.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(config.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: config.to, subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log('alert-send-failed', { key, error: reason });
      return { sent: false, reason: 'relay request failed' };
    }
    if (!res.ok) {
      log('alert-send-failed', { key, status: res.status });
      return { sent: false, reason: `relay responded ${String(res.status)}` };
    }
    lastSent.set(key, nowMs);
    return { sent: true };
  };
}
