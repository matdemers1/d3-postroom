// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the Outbound queue's rules, held without a browser.
// The pure helpers (src/admin/queue/model.ts) are tested directly; the layout promises — one Actions
// menu, no Domain column, evidence in a drawer, no raw /api/ link, cards on a phone — are held by a
// source scan so a later edit that undoes one fails here. The 1280px / 390px geometry is e2e.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterByMessage,
  lastResponse,
  parseQueueFilters,
  QUEUE_PHONE_QUERY,
  queueMenuItems,
  withQueueFilter,
} from '../../src/admin/queue/model';

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

  it('keeps its filters in the URL, and renders cards below 640px', () => {
    expect(screen).toContain('useSearchParams');
    expect(screen).toContain('<DataListRow');
    expect(QUEUE_PHONE_QUERY).toBe('(max-width: 767px), (max-height: 499px)');
  });
});
