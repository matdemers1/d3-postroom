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
  latestOnly,
  loadQueueStates,
  parseQueueFilters,
  QUEUE_LIST_CAP,
  QUEUE_PHONE_QUERY,
  QUEUE_STATE_SEGMENTS,
  queueMenuItems,
  queueSegmentItems,
  recipientCount,
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
  it('are five, so a SegmentedControl: All, Pending, Deferred, Held, Failed', () => {
    expect(QUEUE_STATE_SEGMENTS.map((s) => s.label)).toEqual(['All', 'Pending', 'Deferred', 'Held', 'Failed']);
    expect(QUEUE_STATE_SEGMENTS.map((s) => s.value)).toEqual(['', 'pending', 'deferred', 'held', 'failed']);
  });

  it('show each count, and "500+" — never a silently capped number — when a list hit the API ceiling', () => {
    const lists = {
      '': { rows: [], capped: true, count: 500 },
      pending: { rows: [], capped: false, count: 3 },
      deferred: { rows: [], capped: true, count: 500 },
      held: { rows: [], capped: false, count: 0 },
      failed: { rows: [], capped: false, count: 1 },
    };
    expect(queueSegmentItems(lists, false)).toEqual([
      { value: '', label: 'All 500+' },
      { value: 'pending', label: 'Pending', count: 3 },
      { value: 'deferred', label: 'Deferred 500+' },
      { value: 'held', label: 'Held', count: 0 },
      { value: 'failed', label: 'Failed', count: 1 },
    ]);
    // On a phone the five segments only fit 390px without counts; the toolbar still says how many.
    expect(queueSegmentItems(lists, true).every((i) => !('count' in i) && !i.label.includes('+'))).toBe(true);
    expect(queueSegmentItems(null, false).every((i) => !('count' in i))).toBe(true);
  });

  it('say how many recipients the list holds, and that there are more past the ceiling', () => {
    expect(recipientCount(1)).toBe('1 recipient');
    expect(recipientCount(12)).toBe('12 recipients');
    expect(recipientCount(500, true)).toBe('500+ recipients');
  });
});

describe('loading the queue (PST-T-17.1 verifier: no client-side filter past the cap)', () => {
  const message = (n: number, state: string) => ({
    id: `m${String(n)}`,
    subject: `s${String(n)}`,
    headerFrom: 'a@d3cloud.io',
    envelopeFrom: 'a@d3cloud.io',
    createdAt: '2026-10-01T00:00:00Z',
    recipients: [{ id: `r${String(n)}`, outboundMessageId: `m${String(n)}`, address: `x${String(n)}@a.test`, domain: 'a.test', state, transport: 'direct', attempts: 0, nextAttemptAt: '2026-10-01T00:00:00Z', lastCode: null, lastEnhanced: null, lastText: null, updatedAt: '2026-10-01T00:00:00Z', lastAttempt: null }],
  });

  it('asks the API for every state, each filtered server-side with the domain and the ceiling', async () => {
    const asked: unknown[] = [];
    const result = await loadQueueStates(async (opts) => {
      asked.push(opts);
      await Promise.resolve();
      return { messages: opts.state === 'failed' ? [message(1, 'bounced')] : [], sesConfigured: false };
    }, 'a.test');
    expect(asked).toEqual([
      { domain: 'a.test', limit: QUEUE_LIST_CAP },
      { domain: 'a.test', state: 'pending', limit: QUEUE_LIST_CAP },
      { domain: 'a.test', state: 'deferred', limit: QUEUE_LIST_CAP },
      { domain: 'a.test', state: 'held', limit: QUEUE_LIST_CAP },
      { domain: 'a.test', state: 'failed', limit: QUEUE_LIST_CAP },
    ]);
    // The Failed list is what the server answered for ?state=failed, not a slice of the All list.
    expect(result.lists.failed.rows.map((r) => r.address)).toEqual(['x1@a.test']);
    expect(result.lists.failed.rows[0]?.subject).toBe('s1');
    expect(result.lists[''].rows).toEqual([]);
    expect(result.sesConfigured).toBe(false);
  });

  it('leaves the domain out when there is none, and marks a list that reached the ceiling as capped', async () => {
    const full = Array.from({ length: QUEUE_LIST_CAP }, (_, i) => message(i, 'deferred'));
    const result = await loadQueueStates(async (opts) => {
      expect(opts).not.toHaveProperty('domain');
      await Promise.resolve();
      return { messages: opts.state === 'deferred' ? full : [message(1, 'queued')], sesConfigured: true };
    }, '');
    expect(result.lists.deferred).toMatchObject({ capped: true, count: QUEUE_LIST_CAP });
    expect(result.lists.pending).toMatchObject({ capped: false, count: 1 });
  });

  it('latestOnly drops a response that a newer request overtook (a domain typed letter by letter)', () => {
    const latest = latestOnly();
    const first = latest.next();
    const second = latest.next();
    expect(latest.isLatest(first)).toBe(false);
    expect(latest.isLatest(second)).toBe(true);
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

  it('loads through loadQueueStates and ignores a response a newer request overtook', () => {
    expect(screen).toContain('loadQueueStates(');
    expect(screen).toMatch(/if \(!latest\.current\.isLatest\(token\)\) return;/);
    expect(screen).not.toContain('rowsForState');
  });

  it('has one Domain field: a SearchField in the card toolbar, and no Bulk section', () => {
    expect(screen.match(/aria-label="Domain"/g)).toHaveLength(1);
    expect(screen).toContain('<SearchField');
    expect(screen).toContain('<SegmentedControl');
    expect(screen).toContain('className="pr-table-toolbar"');
    expect(screen).not.toMatch(/Bulk, by domain/);
    expect(screen).not.toMatch(/<FormField label="Domain"/);
    expect(screen).not.toMatch(/<Select\b/);
  });

  it('on a phone the toolbar search keeps its own height (a column flex-basis would be a height)', () => {
    expect(read('admin/admin.css')).toMatch(/@media \(max-width: 767\.98px\) \{[^@]*\.d3-fb\.pr-table-toolbar \.d3-fb__controls > \.d3-search \{\s*flex: none;/);
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
