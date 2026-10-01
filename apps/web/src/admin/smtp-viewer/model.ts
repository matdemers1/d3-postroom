// PST-T-17.13 (PST-REQ-194, PST-REQ-155): the Live SMTP screen's pure logic, kept in plain .ts so
// it runs under apps/web's node-only unit tests (no @d3cloud/ui, no DOM).
import type { SmtpTranscriptSummary } from '../../api';

/** At most this many live lines kept on screen; older ones scroll off (the stored transcript, not
 * this view, is what is kept forever — PST-REQ-118). */
export const MAX_LIVE_LINES = 500;

/** Appends to a capped buffer: the newest `max` survive, in arrival order. Never mutates `prev`. */
export function appendCapped<T>(prev: readonly T[], incoming: readonly T[], max: number = MAX_LIVE_LINES): T[] {
  if (max <= 0) return [];
  const joined = [...prev, ...incoming];
  return joined.length > max ? joined.slice(joined.length - max) : joined;
}

/** What the live stream is doing, as a StatusDot reads it. Neutral when it is simply working (D-016);
 * a hue only when it needs you. */
export type LiveConnection = 'connecting' | 'open' | 'retrying' | 'closed';

export interface LiveStatus {
  word: string;
  tone: 'neutral' | 'attention' | 'danger' | 'idle';
}

export function liveStatus(connection: LiveConnection, paused: boolean): LiveStatus {
  // A dropped or refused stream outranks the pause: the operator needs to know the feed is gone.
  if (connection === 'closed') return { word: 'Disconnected', tone: 'danger' };
  if (connection === 'retrying') return { word: 'Reconnecting', tone: 'attention' };
  if (connection === 'connecting') return { word: 'Connecting', tone: 'idle' };
  if (paused) return { word: 'Paused', tone: 'idle' };
  return { word: 'Connected', tone: 'neutral' };
}

/** The direction gutter: → is the client speaking to us, ← is our reply. The word is for a screen
 * reader; the glyph is decorative. */
export function direction(dir: 'C' | 'S'): { glyph: string; word: string } {
  return dir === 'C' ? { glyph: '→', word: 'Client' } : { glyph: '←', word: 'Server' };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A log line's time as a compact 24-hour HH:MM:SS clock (local time), or '' when unparseable. A
 * protocol log is read by the clock: lines arrive milliseconds apart, so "just now" would label every
 * one of them the same. The full timestamp goes in the `title` beside it. */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A byte count for people: "512 B", "1.2 KB", "3.4 MB" (1024-based, one decimal under 10). */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${units[unit] ?? 'TB'}`;
}

/** How long a session lasted: "800 ms", "4 s", "2 min 5 s", or null while it is still open. */
export function duration(startedAt: string, endedAt: string | null): string | null {
  if (endedAt === null) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${String(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${String(m)} min` : `${String(m)} min ${String(rest)} s`;
}

/** The daemon in words; anything unknown is shown as the server named it. */
export function daemonLabel(daemon: string): string {
  if (daemon === 'smtp-in') return 'Inbound';
  if (daemon === 'submission') return 'Submission';
  return daemon;
}

/** A short, stable tag for a session id, so interleaved live sessions can be told apart. */
export function sessionTag(sessionId: string): string {
  return sessionId.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase();
}

export type DaemonFilter = 'all' | 'smtp-in' | 'submission';

/** Narrows the loaded sessions by daemon and by a free-text match on client IP or session id. */
export function filterTranscripts(rows: readonly SmtpTranscriptSummary[], daemon: DaemonFilter, query: string): SmtpTranscriptSummary[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (daemon === 'all' || r.daemon === daemon) &&
      (q === '' || r.clientIp.toLowerCase().includes(q) || r.sessionId.toLowerCase().includes(q)),
  );
}

/** How many loaded sessions each daemon filter would show (the SegmentedControl's counts). */
export function daemonCounts(rows: readonly SmtpTranscriptSummary[]): Record<DaemonFilter, number> {
  let inbound = 0;
  let submission = 0;
  for (const r of rows) {
    if (r.daemon === 'smtp-in') inbound += 1;
    else if (r.daemon === 'submission') submission += 1;
  }
  return { all: rows.length, 'smtp-in': inbound, submission };
}

/** "1 session" / "12 sessions" / "3 of 12 sessions" when a filter narrows it. */
export function sessionCount(shown: number, total: number): string {
  const noun = total === 1 ? 'session' : 'sessions';
  return shown === total ? `${String(total)} ${noun}` : `${String(shown)} of ${String(total)} ${noun}`;
}

/** Whether a scroller is pinned to its bottom (within a line's slack), so new lines may follow. */
export function atBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 24): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}
