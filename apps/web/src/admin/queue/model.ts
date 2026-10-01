// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the pure half of the Outbound queue screen — what
// the URL filters mean, which actions a row offers, what the drawer shows. No React, so a unit test
// can hold every rule without rendering.
import type { AdminQueueMessage, AdminQueueRecipient, QueueStateFilter } from '../../api';
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

/** The API's own ceiling on one list (apps/api/src/admin-queue MAX_LIST_LIMIT). */
export const QUEUE_LIST_CAP = 500;

export type QueueStateKey = '' | QueueStateFilter;

/** One recipient as the queue screen shows it: the recipient, with its message's subject and From. */
export type QueueRow = AdminQueueRecipient & { subject: string | null; headerFrom: string };

export interface QueueStateList {
  rows: QueueRow[];
  /** How many came back; when `capped`, there are more than this. */
  count: number;
  /** The list reached the API's ceiling, so the count is "500+" and the list is the first 500. */
  capped: boolean;
}

export type QueueFetcher = (opts: { domain?: string; state?: QueueStateFilter; limit: number }) => Promise<{ messages: AdminQueueMessage[]; sesConfigured: boolean }>;

/**
 * Every state's list, each filtered by the API itself (?state=, apps/api/src/admin-queue), never
 * sliced out of the All list here — so a Deferred row past the first 500 of All is still listed and
 * counted under Deferred. Five requests at once; switching segments then asks the server nothing.
 */
export async function loadQueueStates(fetch: QueueFetcher, domain: string): Promise<{ lists: Record<QueueStateKey, QueueStateList>; sesConfigured: boolean }> {
  const scope = domain === '' ? {} : { domain };
  const results = await Promise.all(
    QUEUE_STATE_SEGMENTS.map((seg) => fetch({ ...scope, ...(seg.value === '' ? {} : { state: seg.value }), limit: QUEUE_LIST_CAP })),
  );
  const lists = {} as Record<QueueStateKey, QueueStateList>;
  QUEUE_STATE_SEGMENTS.forEach((seg, i) => {
    const rows = (results[i]?.messages ?? []).flatMap((m) => m.recipients.map((r) => ({ ...r, subject: m.subject, headerFrom: m.headerFrom })));
    lists[seg.value] = { rows, count: rows.length, capped: rows.length >= QUEUE_LIST_CAP };
  });
  return { lists, sesConfigured: results[0]?.sesConfigured ?? true };
}

/**
 * The segments with their counts: a list at the ceiling says "500+" rather than a number that is
 * silently wrong. On a phone the five only fit 390px without counts (the toolbar still says how many).
 */
export function queueSegmentItems(
  lists: Readonly<Record<QueueStateKey, Pick<QueueStateList, 'count' | 'capped'>>> | null,
  phone: boolean,
): { value: QueueStateKey; label: string; count?: number }[] {
  return QUEUE_STATE_SEGMENTS.map((seg) => {
    const list = lists?.[seg.value];
    if (list === undefined || phone) return { value: seg.value, label: seg.label };
    if (list.capped) return { value: seg.value, label: `${seg.label} ${String(QUEUE_LIST_CAP)}+` };
    return { value: seg.value, label: seg.label, count: list.count };
  });
}

/** Only the newest request's answer counts: each load takes a token, and a stale one is dropped. */
export function latestOnly(): { next: () => number; isLatest: (token: number) => boolean } {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isLatest: (token) => token === current,
  };
}

/** "1 recipient", "12 recipients", "500+ recipients" when the list reached the ceiling. */
export function recipientCount(n: number, capped = false): string {
  return `${n.toLocaleString()}${capped ? '+' : ''} ${n === 1 && !capped ? 'recipient' : 'recipients'}`;
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
