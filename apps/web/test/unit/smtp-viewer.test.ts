// PST-T-17.13 (PST-REQ-194, PST-REQ-155): the Live SMTP screen's model — the capped live buffer,
// status as a dot and a word, the log gutters, human sizes and the sessions filter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SmtpTranscriptSummary } from '../../src/api';
import {
  MAX_LIVE_LINES,
  appendCapped,
  atBottom,
  clock,
  daemonCounts,
  daemonLabel,
  direction,
  duration,
  filterTranscripts,
  humanBytes,
  initialLiveFeed,
  liveCount,
  liveFeedReducer,
  liveStatus,
  type LiveFeedAction,
  type LiveFeedState,
  sessionCount,
  sessionTag,
} from '../../src/admin/smtp-viewer/model';

function row(over: Partial<SmtpTranscriptSummary> = {}): SmtpTranscriptSummary {
  return {
    id: 't1',
    daemon: 'smtp-in',
    sessionId: '7f3a9c1e-0000-4000-8000-000000000001',
    clientIp: '203.0.113.7',
    startedAt: '2026-10-01T12:00:00.000Z',
    endedAt: '2026-10-01T12:00:04.000Z',
    lineCount: 12,
    rawBytes: 4096,
    compressedBytes: 1229,
    createdAt: '2026-10-01T12:00:04.000Z',
    ...over,
  };
}

describe('appendCapped', () => {
  it('appends in arrival order without touching the original', () => {
    const prev = [1, 2];
    expect(appendCapped(prev, [3], 5)).toEqual([1, 2, 3]);
    expect(prev).toEqual([1, 2]);
  });

  it('keeps only the newest max lines', () => {
    expect(appendCapped([1, 2, 3], [4, 5], 3)).toEqual([3, 4, 5]);
    const full = Array.from({ length: MAX_LIVE_LINES }, (_, i) => i);
    const next = appendCapped(full, [MAX_LIVE_LINES]);
    expect(next).toHaveLength(MAX_LIVE_LINES);
    expect(next[0]).toBe(1);
    expect(next.at(-1)).toBe(MAX_LIVE_LINES);
  });

  it('a held batch flushed on resume is capped the same way', () => {
    expect(appendCapped([1], [2, 3, 4, 5], 2)).toEqual([4, 5]);
    expect(appendCapped([1], [], 0)).toEqual([]);
  });
});

describe('liveStatus', () => {
  it('is neutral when simply connected (D-016)', () => {
    expect(liveStatus('open', false)).toEqual({ word: 'Connected', tone: 'neutral' });
  });

  it('says Paused, quietly, while the operator holds the feed', () => {
    expect(liveStatus('open', true)).toEqual({ word: 'Paused', tone: 'idle' });
  });

  it('takes a hue only when the stream needs attention, and that outranks a pause', () => {
    expect(liveStatus('retrying', true)).toEqual({ word: 'Reconnecting', tone: 'warning' });
    expect(liveStatus('closed', false)).toEqual({ word: 'Disconnected', tone: 'danger' });
    expect(liveStatus('connecting', false)).toEqual({ word: 'Connecting', tone: 'idle' });
  });
});

describe('log gutters', () => {
  it('direction: → is the client, ← is our reply, each with a word for a screen reader', () => {
    expect(direction('C')).toEqual({ glyph: '→', word: 'Client' });
    expect(direction('S')).toEqual({ glyph: '←', word: 'Server' });
  });

  it('clock is a 24-hour HH:MM:SS in local time', () => {
    const at = new Date(2026, 9, 1, 9, 5, 7).toISOString();
    expect(clock(at)).toBe('09:05:07');
    expect(clock(new Date(2026, 9, 1, 23, 59, 0).toISOString())).toBe('23:59:00');
    expect(clock('not a date')).toBe('');
  });

  it('sessionTag is six lowercase alphanumerics', () => {
    expect(sessionTag('7F3A-9C1E-0000')).toBe('7f3a9c');
    expect(sessionTag('s1')).toBe('s1');
  });
});

describe('humanBytes', () => {
  it('reads like a person would say it', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1024)).toBe('1 KB');
    expect(humanBytes(1229)).toBe('1.2 KB');
    expect(humanBytes(20 * 1024)).toBe('20 KB');
    expect(humanBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('settles the unit after rounding, so a value never reads 1024 of the smaller unit', () => {
    expect(humanBytes(1023)).toBe('1023 B');
    expect(humanBytes(1024)).toBe('1 KB');
    expect(humanBytes(1048575)).toBe('1 MB');
    expect(humanBytes(1048576)).toBe('1 MB');
    expect(humanBytes(1048576 * 1024 - 1)).toBe('1 GB');
    expect(humanBytes(10239)).toBe('10 KB');
    for (const n of [1023.6, 1048000, 1048575, 1073741823]) expect(humanBytes(n)).not.toMatch(/^1024 /);
  });

  it('never prints nonsense for a bad count', () => {
    expect(humanBytes(-1)).toBe('—');
    expect(humanBytes(Number.NaN)).toBe('—');
  });
});

describe('duration', () => {
  it('is null while the session is still open', () => {
    expect(duration('2026-10-01T12:00:00.000Z', null)).toBeNull();
  });

  it('scales from ms to minutes', () => {
    expect(duration('2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.800Z')).toBe('800 ms');
    expect(duration('2026-10-01T12:00:00.000Z', '2026-10-01T12:00:04.000Z')).toBe('4 s');
    expect(duration('2026-10-01T12:00:00.000Z', '2026-10-01T12:02:05.000Z')).toBe('2 min 5 s');
    expect(duration('2026-10-01T12:00:00.000Z', '2026-10-01T12:03:00.000Z')).toBe('3 min');
  });

  it('refuses an end before the start', () => {
    expect(duration('2026-10-01T12:00:04.000Z', '2026-10-01T12:00:00.000Z')).toBeNull();
  });
});

describe('sessions list', () => {
  const rows = [
    row({ id: 'a', daemon: 'smtp-in', clientIp: '203.0.113.7' }),
    row({ id: 'b', daemon: 'submission', clientIp: '198.51.100.20', sessionId: 'abcdef12-3456' }),
    row({ id: 'c', daemon: 'smtp-in', clientIp: '2001:db8::1' }),
  ];

  it('daemonLabel names the two daemons and passes anything else through', () => {
    expect(daemonLabel('smtp-in')).toBe('Inbound');
    expect(daemonLabel('submission')).toBe('Submission');
    expect(daemonLabel('lmtp')).toBe('lmtp');
  });

  it('filters by daemon', () => {
    expect(filterTranscripts(rows, 'all', '').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterTranscripts(rows, 'smtp-in', '').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterTranscripts(rows, 'submission', '').map((r) => r.id)).toEqual(['b']);
  });

  it('matches a query against client IP or session id, case-insensitively, trimmed', () => {
    expect(filterTranscripts(rows, 'all', ' 2001:DB8 ').map((r) => r.id)).toEqual(['c']);
    expect(filterTranscripts(rows, 'all', 'ABCDEF').map((r) => r.id)).toEqual(['b']);
    expect(filterTranscripts(rows, 'smtp-in', '198.51')).toEqual([]);
  });

  it('counts each daemon for the segmented control', () => {
    expect(daemonCounts(rows)).toEqual({ all: 3, 'smtp-in': 2, submission: 1 });
    expect(daemonCounts([])).toEqual({ all: 0, 'smtp-in': 0, submission: 0 });
  });

  it('says the count, and "of" only when a filter narrows it', () => {
    expect(sessionCount(1, 1)).toBe('1 session');
    expect(sessionCount(12, 12)).toBe('12 sessions');
    expect(sessionCount(3, 12)).toBe('3 of 12 sessions');
  });
});

describe('atBottom', () => {
  it('is pinned within the slack, and not once the reader scrolls up', () => {
    expect(atBottom(600, 400, 1000)).toBe(true);
    expect(atBottom(590, 400, 1000)).toBe(true);
    expect(atBottom(300, 400, 1000)).toBe(false);
  });
});

describe('liveFeedReducer (pause, resume, clear, cap)', () => {
  const run = (actions: LiveFeedAction<number>[], max = 5): LiveFeedState<number> =>
    actions.reduce<LiveFeedState<number>>((st, a) => liveFeedReducer(st, a), initialLiveFeed<number>(max));
  const line = (n: number): LiveFeedAction<number> => ({ type: 'line', line: n });

  it('shows lines as they arrive while not paused', () => {
    const st = run([line(1), line(2)]);
    expect(st.lines).toEqual([1, 2]);
    expect(st.held).toEqual([]);
  });

  it('holds lines while paused, then resume flushes exactly what was held, in order, in one step', () => {
    const paused = run([line(1), { type: 'pause' }, line(2), line(3)]);
    expect(paused.lines).toEqual([1]);
    expect(paused.held).toEqual([2, 3]);
    expect(liveCount(paused)).toBe('1 line · 2 new while paused');
    const resumed = liveFeedReducer(paused, { type: 'resume' });
    expect(resumed.lines).toEqual([1, 2, 3]);
    expect(resumed.held).toEqual([]);
    expect(resumed.paused).toBe(false);
    // A line straight after resume lands after the flushed ones: nothing read a stale `held`.
    expect(liveFeedReducer(resumed, line(4)).lines).toEqual([1, 2, 3, 4]);
  });

  it('a line racing the resume is never lost or duplicated', () => {
    const st = run([{ type: 'pause' }, line(1), { type: 'resume' }, line(2), { type: 'pause' }, line(3), { type: 'resume' }]);
    expect(st.lines).toEqual([1, 2, 3]);
    expect(st.held).toEqual([]);
  });

  it('pause and resume are idempotent', () => {
    const st = run([line(1), { type: 'pause' }, { type: 'pause' }, line(2), { type: 'resume' }, { type: 'resume' }]);
    expect(st.lines).toEqual([1, 2]);
  });

  it('clear while paused empties the view and the hold, and stays paused', () => {
    const st = run([line(1), { type: 'pause' }, line(2), { type: 'clear' }]);
    expect(st).toMatchObject({ lines: [], held: [], paused: true, dropped: 0 });
    expect(liveFeedReducer(liveFeedReducer(st, line(3)), { type: 'resume' }).lines).toEqual([3]);
  });

  it('caps the view and the hold, and says when the oldest held lines fell off', () => {
    const st = run([line(1), line(2), line(3), { type: 'pause' }, line(4), line(5), line(6), line(7), line(8), line(9)], 5);
    expect(st.lines).toEqual([1, 2, 3]);
    expect(st.held).toEqual([5, 6, 7, 8, 9]);
    expect(st.dropped).toBe(1);
    expect(liveCount(st)).toBe('3 lines · 5+ new while paused (oldest dropped)');
    const resumed = liveFeedReducer(st, { type: 'resume' });
    expect(resumed.lines).toEqual([5, 6, 7, 8, 9]);
    expect(resumed.dropped).toBe(0);
    expect(liveCount(resumed)).toBe('5 lines');
  });

  it('at the real cap, a long pause reads "500+ new while paused (oldest dropped)"', () => {
    let st = liveFeedReducer(initialLiveFeed<number>(), { type: 'pause' });
    for (let i = 0; i < MAX_LIVE_LINES + 37; i += 1) st = liveFeedReducer(st, line(i));
    expect(st.held).toHaveLength(MAX_LIVE_LINES);
    expect(st.held[0]).toBe(37);
    expect(liveCount(st)).toBe(`0 lines · ${String(MAX_LIVE_LINES)}+ new while paused (oldest dropped)`);
  });

  it('cap trims both buffers to the newest', () => {
    const st = liveFeedReducer(run([line(1), line(2), line(3), { type: 'pause' }, line(4), line(5)], 5), { type: 'cap', max: 1 });
    expect(st.lines).toEqual([3]);
    expect(st.held).toEqual([5]);
    expect(st.dropped).toBe(1);
  });
});

// The screen itself has no DOM tests here (apps/web unit tests run in plain Node), so the wiring the
// verifier checked is held by a source scan, as polish.test.ts does for layout fixes.
describe('Live SMTP wiring (source scan)', () => {
  const dir = join(__dirname, '../../src/admin/smtp-viewer');
  const tsx = readFileSync(join(dir, 'AdminSmtpViewer.tsx'), 'utf8');
  const css = readFileSync(join(dir, 'smtp-viewer.css'), 'utf8');

  it('returns focus to the View button that opened the transcript drawer, on the table and on a phone card', () => {
    expect(tsx).toMatch(/import \{ useFocusReturn \} from '\.\.\/\.\.\/mail\/focusReturn'/);
    expect(tsx).toMatch(/useFocusReturn\(drawerOpen\)/);
    expect(tsx).toMatch(/returnTo\.current = opener/);
    expect(tsx.match(/openTranscript\(\w+, (opener|e\.currentTarget)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the transcript rendered while the drawer animates out', () => {
    expect(tsx).toMatch(/open=\{open && row !== null\}/);
    const onClose = /onClose=\{\(\) => \{([^}]*)\}\}/.exec(tsx)?.[1] ?? '';
    expect(onClose).toContain('setDrawerOpen(false)');
    expect(onClose).not.toContain('setSelected(null)');
  });

  it('runs the live feed through the reducer, with no separate held/lines state to race', () => {
    expect(tsx).toMatch(/useReducer\(liveFeedReducer/);
    expect(tsx).not.toMatch(/setHeld\(|setLines\(/);
  });

  it('never clips the live toolbar at 390px: its end wraps, the count wraps, Jump to latest floats on the pane', () => {
    expect(css).toMatch(/\.pr-smtp-live \.pr-table-toolbar__end \{[^}]*flex-wrap: wrap/);
    const count = /\.pr-smtp-count \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(count).not.toContain('nowrap');
    const toolbar = tsx.slice(tsx.indexOf('pr-table-toolbar__end'), tsx.indexOf('pr-smtp-body'));
    expect(toolbar).not.toContain('Jump to latest');
    expect(tsx).toMatch(/className="pr-smtp-jump"/);
  });
});
