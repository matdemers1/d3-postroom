// PST-T-17.13 (PST-REQ-194, PST-REQ-155): the Live SMTP screen's model — the capped live buffer,
// status as a dot and a word, the log gutters, human sizes and the sessions filter.
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
  liveStatus,
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
    expect(liveStatus('retrying', true)).toEqual({ word: 'Reconnecting', tone: 'attention' });
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
