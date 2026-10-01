// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the Outbound queue's rules, held without a browser.
// The pure helpers (src/admin/queue/model.ts) are tested directly; the layout promises — one Actions
// menu, no Domain column, evidence in a drawer, no raw /api/ link, cards on a phone — are held by a
// source scan so a later edit that undoes one fails here. The 1280px / 390px geometry is e2e.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  domainMenuItems,
  filterByMessage,
  lastResponse,
  matchesQueueState,
  parseQueueFilters,
  QUEUE_PHONE_QUERY,
  QUEUE_STATE_SEGMENTS,
  queueMenuItems,
  queueStateCounts,
  recipientCount,
  rowsForState,
  withQueueFilter,
} from '../../src/admin/queue/model';
import { PHONE_QUERY } from '../../src/mail/useMedia';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

describe('queueMenuItems', () => {
  it('offers the four actions in one list, Delete last and the only danger', () => {
    const items = queueMenuItems(true);
    expect(items.map((i) => i.label)).toEqual(['Retry now', 'Force SES', 'Bounce', 'Delete']);
    expect(items.filter((i) => i.tone === 'danger').map((i) => i.kind)).toEqual(['delete']);
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it('disables Force SES, and says why, when SES is not configured', () => {
    const ses = queueMenuItems(false).find((i) => i.kind === 'force-ses');
    expect(ses).toMatchObject({ disabled: true, reason: 'SES is not configured' });
    expect(queueMenuItems(false).filter((i) => i.disabled)).toHaveLength(1);
  });
});

describe('URL filters', () => {
  it('reads ?state, ?domain and ?message', () => {
    expect(parseQueueFilters(new URLSearchParams('state=deferred&domain=Example.COM&message=m-1'))).toEqual({
      state: 'deferred',
      domain: 'example.com',
      message: 'm-1',
    });
  });

  it('ignores a state the API would reject, and defaults to nothing', () => {
    expect(parseQueueFilters(new URLSearchParams('state=bogus')).state).toBe('');
    expect(parseQueueFilters(new URLSearchParams(''))).toEqual({ state: '', domain: '', message: '' });
  });

  it('sets and clears one filter without touching the others or the input', () => {
    const before = new URLSearchParams('state=failed&message=m-1');
    const after = withQueueFilter(before, 'domain', 'a.test');
    expect(after.toString()).toBe('state=failed&message=m-1&domain=a.test');
    expect(withQueueFilter(after, 'message', '').toString()).toBe('state=failed&domain=a.test');
    expect(before.toString()).toBe('state=failed&message=m-1');
  });

  it('?message= keeps only that message’s recipients; no id keeps them all', () => {
    const rows = [
      { id: 'r1', outboundMessageId: 'm-1' },
      { id: 'r2', outboundMessageId: 'm-2' },
      { id: 'r3', outboundMessageId: 'm-1' },
    ];
    expect(filterByMessage(rows, 'm-1').map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(filterByMessage(rows, '')).toHaveLength(3);
    expect(filterByMessage(rows, 'nope')).toEqual([]);
  });
});

describe('lastResponse', () => {
  it('joins the code, the enhanced code and the text', () => {
    expect(lastResponse({ lastCode: 451, lastEnhanced: '4.7.1', lastText: 'greylisted' })).toBe('451 4.7.1 greylisted');
    expect(lastResponse({ lastCode: 451, lastEnhanced: null, lastText: 'greylisted' })).toBe('451 greylisted');
  });

  it('is null when the server never replied', () => {
    expect(lastResponse({ lastCode: null, lastEnhanced: null, lastText: null })).toBeNull();
    expect(lastResponse({ lastCode: null, lastEnhanced: null, lastText: '  ' })).toBeNull();
  });
});

describe('AdminQueue layout (source)', () => {
  const screen = read('screens/AdminQueue.tsx');

  it('has one Actions menu per row and no per-row Retry / Force SES / Bounce / Delete buttons', () => {
    expect(screen).toContain('<QueueActions');
    expect(screen).not.toMatch(/<Button[^>]*>\s*(Retry|Force SES|Bounce|Delete)\s*<\/Button>\s*\n\s*<Button/);
    expect(read('admin/queue/QueueActions.tsx')).toContain('MenuItem');
  });

  it('has no Domain column and no Last response column; the reply lives in the drawer', () => {
    expect(screen).not.toMatch(/header: 'Domain'/);
    expect(screen).not.toMatch(/header: 'Last response'/);
    const drawer = read('admin/queue/QueueDrawer.tsx');
    expect(drawer).toContain('DeliveryEvidence');
    expect(drawer).toContain('Last response');
  });

  it('links to no /api/ URL', () => {
    for (const file of ['screens/AdminQueue.tsx', 'admin/queue/QueueActions.tsx', 'admin/queue/QueueDrawer.tsx']) {
      expect(read(file)).not.toMatch(/href=[{"'`][^>]*\/api\//);
    }
  });

  it('keeps its filters in the URL, and renders cards on a phone', () => {
    expect(screen).toContain('useSearchParams');
    expect(screen).toContain('<DataListRow');
    expect(screen).toContain('useMediaQuery(PHONE_QUERY)');
    expect(QUEUE_PHONE_QUERY).toBe(PHONE_QUERY);
    expect(QUEUE_PHONE_QUERY).toBe('(max-width: 767px), (max-height: 499px)');
  });
});

describe('the State segments (PST-T-17.1, admin critique X7)', () => {
  const rows = [{ state: 'queued' }, { state: 'deferred' }, { state: 'deferred' }, { state: 'bounced' }];

  it('are five, so a SegmentedControl: All, Pending, Deferred, Held, Failed', () => {
    expect(QUEUE_STATE_SEGMENTS.map((s) => s.label)).toEqual(['All', 'Pending', 'Deferred', 'Held', 'Failed']);
    expect(QUEUE_STATE_SEGMENTS.map((s) => s.value)).toEqual(['', 'pending', 'deferred', 'held', 'failed']);
  });

  it('match rows the way the API reads ?state= (pending is queued, failed is bounced)', () => {
    expect(matchesQueueState('queued', 'pending')).toBe(true);
    expect(matchesQueueState('bounced', 'failed')).toBe(true);
    expect(matchesQueueState('deferred', 'pending')).toBe(false);
    expect(matchesQueueState('deferred', '')).toBe(true);
    expect(matchesQueueState('queued', 'held')).toBe(false);
  });

  it('count every state, with held as the API answered it', () => {
    expect(queueStateCounts(rows, 2)).toEqual({ '': 4, pending: 1, deferred: 2, held: 2, failed: 1 });
    expect(queueStateCounts([], 0)).toEqual({ '': 0, pending: 0, deferred: 0, held: 0, failed: 0 });
  });

  it('show the held list for Held and filter the rest locally', () => {
    const held = [{ state: 'queued' }];
    expect(rowsForState(rows, held, 'held')).toEqual(held);
    expect(rowsForState(rows, held, 'deferred')).toHaveLength(2);
    expect(rowsForState(rows, held, '')).toHaveLength(4);
  });

  it('say how many recipients the list holds', () => {
    expect(recipientCount(1)).toBe('1 recipient');
    expect(recipientCount(12)).toBe('12 recipients');
  });
});

describe('domain actions (admin critique 2.2 #1)', () => {
  it('offer the four actions for a whole domain, each with the confirm modal’s title, Delete last and the only danger', () => {
    const items = domainMenuItems('example.com', true);
    expect(items.map((i) => i.label)).toEqual(['Retry all', 'Force SES for all', 'Bounce all', 'Delete all…']);
    expect(items.map((i) => i.confirm)).toEqual([
      'Retry every recipient at example.com',
      'Force SES for example.com',
      'Bounce every recipient at example.com',
      'Delete every recipient at example.com',
    ]);
    expect(items.filter((i) => i.tone === 'danger').map((i) => i.kind)).toEqual(['delete']);
    expect(domainMenuItems('example.com', false).find((i) => i.kind === 'force-ses')?.disabled).toBe(true);
  });
});

describe('AdminQueue on the canvas (source, PST-T-17.1)', () => {
  const screen = read('screens/AdminQueue.tsx');
  const actions = read('admin/queue/QueueActions.tsx');

  it('has one Domain field: a SearchField in the card toolbar, and no Bulk section', () => {
    expect(screen.match(/aria-label="Domain"/g)).toHaveLength(1);
    expect(screen).toContain('<SearchField');
    expect(screen).toContain('<SegmentedControl');
    expect(screen).toContain('className="pr-table-toolbar"');
    expect(screen).not.toMatch(/Bulk, by domain/);
    expect(screen).not.toMatch(/<FormField label="Domain"/);
    expect(screen).not.toMatch(/<Select\b/);
  });

  it('shows the domain’s bulk actions only once a domain is typed', () => {
    expect(screen).toMatch(/domain === '' \? null : \(\s*<DomainActions/);
  });

  it('the row action is a ⋯ IconButton menu under a visually hidden header; nothing red in the row', () => {
    expect(actions).toMatch(/<IconButton label=\{`Actions for \$\{address\}`\}/);
    expect(screen).toContain("header: hidden('Actions')");
    expect(screen).not.toContain('danger-ghost');
    expect(screen).not.toMatch(/variant="danger"(?![^>]*form="queue-confirm")/);
  });

  it('shows Next attempt as a relative time in a rem-width column', () => {
    expect(screen).toMatch(/header: 'Next attempt', width: '\d+(\.\d+)?rem', cell: \(r\) => <RelativeTime iso=\{r\.nextAttemptAt\} \/>/);
  });
});
