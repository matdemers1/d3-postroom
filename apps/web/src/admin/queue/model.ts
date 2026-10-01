// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the pure half of the Outbound queue screen — what
// the URL filters mean, which actions a row offers, what the drawer shows. No React, so a unit test
// can hold every rule without rendering.
import type { AdminQueueRecipient, QueueStateFilter } from '../../api';

/** Below 640px the queue is a list of cards (a DataList), not a table. */
export const QUEUE_PHONE_QUERY = '(max-width: 639px)';

export type QueueActionKind = 'retry' | 'force-ses' | 'bounce' | 'delete';

export const QUEUE_ACTION_LABEL: Record<QueueActionKind, string> = {
  retry: 'Retry now',
  'force-ses': 'Force SES',
  bounce: 'Bounce',
  delete: 'Delete',
};

export interface QueueMenuItem {
  kind: QueueActionKind;
  label: string;
  tone: 'default' | 'danger';
  disabled: boolean;
  /** Why it is disabled; null when it is not. */
  reason: string | null;
}

/** The four row actions, in the order they appear in the one Actions menu. Delete is last and the only danger. */
export function queueMenuItems(sesConfigured: boolean): QueueMenuItem[] {
  return (['retry', 'force-ses', 'bounce', 'delete'] as const).map((kind) => {
    const sesOff = kind === 'force-ses' && !sesConfigured;
    return {
      kind,
      label: QUEUE_ACTION_LABEL[kind],
      tone: kind === 'delete' ? 'danger' : 'default',
      disabled: sesOff,
      reason: sesOff ? 'SES is not configured' : null,
    };
  });
}

export interface QueueFilters {
  state: '' | QueueStateFilter;
  domain: string;
  /** An outbound message id: only that message's recipients. */
  message: string;
}

const STATES: readonly QueueStateFilter[] = ['pending', 'deferred', 'held', 'failed'];

/** The filters a URL carries. An unknown ?state= is ignored rather than sent to the API to be rejected. */
export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  const state = params.get('state')?.trim() ?? '';
  return {
    state: (STATES as readonly string[]).includes(state) ? (state as QueueStateFilter) : '',
    domain: (params.get('domain') ?? '').trim().toLowerCase(),
    message: (params.get('message') ?? '').trim(),
  };
}

/** The same params with one filter set (or removed when empty). Other params are kept; the input is not changed. */
export function withQueueFilter(params: URLSearchParams, key: keyof QueueFilters, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === '') next.delete(key);
  else next.set(key, value);
  return next;
}

/** ?message=<id>: that message's recipients only; no id leaves the list as it is. */
export function filterByMessage<T extends Pick<AdminQueueRecipient, 'outboundMessageId'>>(rows: readonly T[], message: string): T[] {
  return message === '' ? [...rows] : rows.filter((r) => r.outboundMessageId === message);
}

/** The drawer's "Last response" line: "451 4.7.1 greylisted…", or null when the server never replied. */
export function lastResponse(r: Pick<AdminQueueRecipient, 'lastCode' | 'lastEnhanced' | 'lastText'>): string | null {
  const code = [r.lastCode === null ? null : String(r.lastCode), r.lastEnhanced].filter((p): p is string => p !== null && p !== '').join(' ');
  const text = r.lastText?.trim() ?? '';
  const line = [code, text].filter((p) => p !== '').join(' ');
  return line === '' ? null : line;
}
