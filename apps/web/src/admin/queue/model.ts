// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the pure half of the Outbound queue screen — what
// the URL filters mean, which actions a row offers, what the drawer shows. No React, so a unit test
// can hold every rule without rendering.
import type { AdminQueueRecipient, QueueStateFilter } from '../../api';
import { PHONE_QUERY } from '../../mail/useMedia';

/** On a phone, either orientation, the queue is a list of cards (a DataList), not a table. */
// A phone in either orientation: the complement of mail/useMedia.ts SPLIT_QUERY (PST-T-16.18).
export const QUEUE_PHONE_QUERY = PHONE_QUERY;

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

// ─── PST-T-17.1: one filter row (admin critique X7, 2.2) ────────────────────────────────────────

/** The State filter as a SegmentedControl: every state, in the order the queue works through them. */
export const QUEUE_STATE_SEGMENTS: readonly { value: '' | QueueStateFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'held', label: 'Held' },
  { value: 'failed', label: 'Failed' },
];

/**
 * Whether a recipient belongs under a state filter, as apps/api/src/admin-queue reads ?state=:
 * pending is `queued`, failed is `bounced`. Held cannot be told from the row (it is a frozen app
 * password on the message), so the screen asks the API for that one; here it matches nothing.
 */
export function matchesQueueState(state: string, filter: '' | QueueStateFilter): boolean {
  switch (filter) {
    case '':
      return true;
    case 'pending':
      return state === 'queued';
    case 'deferred':
      return state === 'deferred';
    case 'failed':
      return state === 'bounced';
    case 'held':
      return false;
  }
}

/** The count beside each segment: every row the domain filter left, by state; held as the API said. */
export function queueStateCounts(rows: readonly Pick<AdminQueueRecipient, 'state'>[], held: number): Record<'' | QueueStateFilter, number> {
  const count = (f: '' | QueueStateFilter): number => rows.filter((r) => matchesQueueState(r.state, f)).length;
  return { '': rows.length, pending: count('pending'), deferred: count('deferred'), held, failed: count('failed') };
}

/** The rows a state filter shows: the held list comes from its own request. */
export function rowsForState<T extends Pick<AdminQueueRecipient, 'state'>>(all: readonly T[], held: readonly T[], filter: '' | QueueStateFilter): T[] {
  return filter === 'held' ? [...held] : all.filter((r) => matchesQueueState(r.state, filter));
}

/** "1 recipient", "12 recipients". */
export function recipientCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'recipient' : 'recipients'}`;
}

/** The bulk actions offered once a domain is typed into the filter: the same four, worded for a domain. */
export function domainMenuItems(domain: string, sesConfigured: boolean): (QueueMenuItem & { confirm: string })[] {
  const confirm: Record<QueueActionKind, string> = {
    retry: `Retry every recipient at ${domain}`,
    'force-ses': `Force SES for ${domain}`,
    bounce: `Bounce every recipient at ${domain}`,
    delete: `Delete every recipient at ${domain}`,
  };
  const label: Record<QueueActionKind, string> = { retry: 'Retry all', 'force-ses': 'Force SES for all', bounce: 'Bounce all', delete: 'Delete all…' };
  return queueMenuItems(sesConfigured).map((item) => ({ ...item, label: label[item.kind], confirm: confirm[item.kind] }));
}
