// PST-T-15.7 (PST-REQ-194): what Admin › Health says about the tiles GET /api/admin/health returns,
// pulled out of the screen so every word and tone is unit-tested without rendering.
//
// Tones follow D-016: a healthy check is neutral (grey, never green); only a check that needs you
// takes a hue — attention for degraded, danger for down — and a check that has not run yet is idle.
// Nothing here invents a fact: every value is read from a tile the server sent, or from the
// outbound-queue list the Queue screen already uses.
import type { StatusDotTone } from '@d3cloud/ui';
import type { AdminQueueRecipient, HealthTile, HealthTileState } from '../../api';

/** Each tile state as a StatusDot: the word carries the meaning, the dot only decorates it. */
export const TILE_TONE: Readonly<Record<HealthTileState, { label: string; tone: StatusDotTone }>> = {
  ok: { label: 'Healthy', tone: 'neutral' },
  warn: { label: 'Degraded', tone: 'attention' },
  down: { label: 'Down', tone: 'danger' },
  unknown: { label: 'Not checked', tone: 'idle' },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 h ago", "2 d ago" — then a date, since a week-old "8 d ago" reads worse. */
export function relativeTime(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'at an unknown time';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))} min ago`;
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))} h ago`;
  if (ms < 7 * DAY) return `${String(Math.floor(ms / DAY))} d ago`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** A queue age, short and fixed-width enough to line up: "14m", "1h 02m", "3d 4h". */
export function durationShort(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MINUTE));
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
}

function counts(tiles: readonly HealthTile[]): Record<HealthTileState, number> {
  const out: Record<HealthTileState, number> = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const t of tiles) out[t.state] += 1;
  return out;
}

/**
 * The header's one line: neutral "All systems normal" when nothing is down or degraded (a check
 * that has not run yet does not make the system abnormal — the Services list says which), danger
 * when anything is down, attention when something is degraded, idle when nothing has run at all.
 */
export function healthSummary(tiles: readonly HealthTile[]): { tone: StatusDotTone; text: string } {
  const c = counts(tiles);
  if (c.down > 0) {
    const also = c.warn > 0 ? `, ${String(c.warn)} degraded` : '';
    return { tone: 'danger', text: `${String(c.down)} ${c.down === 1 ? 'check' : 'checks'} down${also}` };
  }
  if (c.warn > 0) return { tone: 'attention', text: `${String(c.warn)} ${c.warn === 1 ? 'check' : 'checks'} degraded` };
  if (c.ok === 0) return { tone: 'idle', text: 'Nothing checked yet' };
  return { tone: 'neutral', text: 'All systems normal' };
}

/** "8 healthy · 1 not checked", worst first, leaving out zero counts. */
export function servicesMeta(tiles: readonly HealthTile[]): string {
  const c = counts(tiles);
  const parts: string[] = [];
  if (c.down > 0) parts.push(`${String(c.down)} down`);
  if (c.warn > 0) parts.push(`${String(c.warn)} degraded`);
  if (c.ok > 0) parts.push(`${String(c.ok)} healthy`);
  if (c.unknown > 0) parts.push(`${String(c.unknown)} not checked`);
  return parts.join(' · ');
}

/**
 * When a tile's `since` is: a backup or drill tile carries when it last ran; a monitor tile carries
 * when its state last changed. A daemon tile has none.
 */
export function sinceText(tile: HealthTile, now: Date): string | null {
  if (tile.since === null) return null;
  const rel = relativeTime(tile.since, now);
  return tile.id === 'backup' || tile.id === 'drill' ? `ran ${rel}` : `since ${rel.replace(/ ago$/, '')}`;
}

export const tileById = (tiles: readonly HealthTile[], id: string): HealthTile | undefined => tiles.find((t) => t.id === id);

/**
 * The inbound-queue tile's two numbers, read from the detail apps/api/src/admin-health writes
 * ("No dead jobs", or "2 dead jobs, 1 failed message"; the older "(s)" wording still parses); null when the wording is anything else,
 * so the screen falls back to the state word instead of guessing.
 */
export function inboundQueueCounts(tile: HealthTile): { dead: number; failed: number } | null {
  if (tile.detail.toLowerCase() === 'no dead jobs') return { dead: 0, failed: 0 };
  const m = /^(\d+) dead jobs?(?:\(s\))?, (\d+) failed messages?(?:\(s\))?$/.exec(tile.detail);
  return m === null ? null : { dead: Number(m[1]), failed: Number(m[2]) };
}

/** A last-run tile (backup, restore drill) as a Stat: the time it ran, and which day. */
export function lastRunStat(tile: HealthTile, now: Date): { value: string; unit?: string } {
  if (tile.since === null) return { value: 'Never' };
  const at = new Date(tile.since);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = at.getTime();
  const day =
    t >= startOfToday
      ? 'today'
      : t >= startOfToday - DAY
        ? 'yesterday'
        : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { value: time, unit: day };
}

/** The footnote under a last-run Stat: the server's "ok" becomes a sentence, anything else is its reason, humanised. */
export function lastRunFootnote(tile: HealthTile, what: string): string {
  if (tile.state === 'ok') return `Last ${what} succeeded`;
  return humanizeDetail(tile.detail);
}

/** A queued recipient's state as a StatusDot: waiting is neutral, deferred asks, bounced failed. */
export const QUEUE_STATE: Readonly<Record<string, { label: string; tone: StatusDotTone }>> = {
  queued: { label: 'Queued', tone: 'neutral' },
  deferred: { label: 'Deferred', tone: 'attention' },
  bounced: { label: 'Bounced', tone: 'danger' },
};

export function queueState(state: string): { label: string; tone: StatusDotTone } {
  return QUEUE_STATE[state] ?? { label: state.charAt(0).toUpperCase() + state.slice(1), tone: 'neutral' };
}

/** "3 in queue · 1 bounced" for the card's meta; `limited` when the list hit its fetch limit. */
export function queueMeta(recipients: readonly Pick<AdminQueueRecipient, 'state'>[], limited: boolean): string {
  if (recipients.length === 0) return 'Nothing queued';
  const n = `${String(recipients.length)}${limited ? '+' : ''} in queue`;
  const deferred = recipients.filter((r) => r.state === 'deferred').length;
  const bounced = recipients.filter((r) => r.state === 'bounced').length;
  return [n, deferred > 0 ? `${String(deferred)} deferred` : null, bounced > 0 ? `${String(bounced)} bounced` : null].filter((p) => p !== null).join(' · ');
}

const PLURAL = new Intl.PluralRules('en');

/** "7 dead job(s)" becomes "7 dead jobs" and "1 failed message(s)" becomes "1 failed message". */
function pluralise(text: string): string {
  return text.replace(/(\d+)((?: [\w-]+)*?) ([A-Za-z]+)\(s\)/g, (_all, n: string, middle: string, noun: string) => {
    const one = PLURAL.select(Number(n)) === 'one';
    return `${n}${middle} ${one ? noun : `${noun}s`}`;
  });
}

/** Raw errno codes as a sentence a person can act on; the code itself is left out, the sentence says it. */
const ERRNO_SENTENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEACCES\b|\bEPERM\b/, 'Permission denied: Postroom isn’t allowed to read or write something it needs.'],
  [/\bENOENT\b/, 'A file or folder Postroom needs wasn’t found.'],
  [/\bENOSPC\b/, 'The disk is full.'],
  [/\bECONNREFUSED\b/, 'The connection was refused: nothing is listening there.'],
  [/\bECONNRESET\b|\bEPIPE\b/, 'The connection was dropped partway through.'],
  [/\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b/, 'The connection timed out: nothing answered in time.'],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b/, 'The name couldn’t be looked up in DNS.'],
  [/\bEHOSTUNREACH\b|\bENETUNREACH\b/, 'The host couldn’t be reached over the network.'],
  [/\bEROFS\b/, 'The disk is mounted read-only.'],
];

/**
 * A server detail as a sentence: errno reasons mapped, "(s)" pluralised, "ok" as OK, and the first
 * letter capitalised. A reason that is already prose passes through otherwise untouched.
 */
export function humanizeDetail(detail: string): string {
  const text = detail.trim();
  if (text === '') return text;
  for (const [pattern, sentence] of ERRNO_SENTENCES) if (pattern.test(text)) return sentence;
  if (text.toLowerCase() === 'ok') return 'OK';
  const plural = pluralise(text);
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

const STATE_RANK: Readonly<Record<HealthTileState, number>> = { down: 0, warn: 1, unknown: 2, ok: 3 };

/** Down, then degraded, then not checked, then healthy; the server's order breaks ties. */
export function sortTiles(tiles: readonly HealthTile[]): HealthTile[] {
  return tiles
    .map((tile, index) => ({ tile, index }))
    .sort((a, b) => STATE_RANK[a.tile.state] - STATE_RANK[b.tile.state] || a.index - b.index)
    .map((x) => x.tile);
}

export const BACKUP_RUNBOOK_URL = 'https://github.com/matdemers1/d3-postroom/blob/main/docs/runbooks/backups.md';

export interface TileAction {
  readonly label: string;
  readonly href: string;
  /** True when the link leaves the app and should open in a new tab. */
  readonly external: boolean;
}

/** Where to go to fix a failing check; null for a check that is fine, not checked, or has no fix screen. */
export function tileAction(tile: HealthTile): TileAction | null {
  if (tile.state !== 'down' && tile.state !== 'warn') return null;
  switch (tile.id) {
    case 'queue':
      return { label: 'View dead jobs', href: '/admin/jobs?status=dead', external: false };
    case 'backup':
    case 'drill':
      return { label: 'Backup runbook', href: BACKUP_RUNBOOK_URL, external: true };
    default:
      return null;
  }
}

// ─── PST-T-17.1: Health on the canvas (admin critique 2.1) ──────────────────────────────────────

/** What one Stat tile shows: a number (or "—") in the value slot, never a status word (2.1 #5). */
export interface StatView {
  value: string;
  unit?: string;
  /** The StatusDot under the value. */
  status: { label: string; tone: StatusDotTone };
  /** One line; the screen truncates it and puts the whole text in `title`. */
  footnote: string;
}

const NOT_REPORTED: StatView = { value: '—', status: { label: 'Not reported', tone: 'idle' }, footnote: 'Not reported' };

/** The inbound queue as a count of dead jobs; "—" when the server's wording is anything else. */
export function inboundQueueStat(tile: HealthTile | undefined): StatView {
  if (tile === undefined) return NOT_REPORTED;
  const status = TILE_TONE[tile.state];
  const q = inboundQueueCounts(tile);
  if (q === null) return { value: '—', status, footnote: humanizeDetail(tile.detail) };
  return {
    value: String(q.dead),
    unit: q.dead === 1 ? 'dead job' : 'dead jobs',
    status,
    footnote: `${String(q.failed)} failed ${q.failed === 1 ? 'message' : 'messages'}`,
  };
}

/**
 * Certificates as days left, read from the detail apps/worker/src/monitors/cert.ts writes: "all
 * certificates valid for at least 21 days" (shown "21+"), or "<file>: expires in 3.2 days; …" (the
 * soonest, rounded down). A check that has not run, or a reason with no number, is "—".
 */
export function certificateStat(tile: HealthTile | undefined): StatView {
  if (tile === undefined) return NOT_REPORTED;
  const status = TILE_TONE[tile.state];
  if (tile.state === 'unknown') return { value: '—', status, footnote: 'Not checked yet' };
  const atLeast = /valid for at least (\d+) days?/i.exec(tile.detail);
  if (atLeast !== null) return { value: `${atLeast[1] ?? ''}+`, unit: 'days left', status, footnote: 'Every certificate' };
  const left = [...tile.detail.matchAll(/expires in (-?\d+(?:\.\d+)?) days?/gi)].map((m) => Number(m[1]));
  if (left.length > 0) {
    const soonest = Math.max(0, Math.floor(Math.min(...left)));
    return { value: String(soonest), unit: soonest === 1 ? 'day left' : 'days left', status, footnote: humanizeDetail(tile.detail) };
  }
  return { value: '—', status, footnote: humanizeDetail(tile.detail) };
}

/** True when the backup job skipped because no offsite bucket is configured (apps/worker/src/backup/job.ts). */
export function backupNotConfigured(tile: HealthTile): boolean {
  return /backups not configured/i.test(tile.detail);
}

/**
 * A last-run tile (backup, restore drill) as a Stat: when it last ran. A backup with no offsite
 * bucket is "Local only" with an attention status — no copy leaves the machine, and that needs the
 * operator (D-016) — rather than a time over a "Not checked" dot.
 */
export function lastRunView(tile: HealthTile | undefined, what: 'backup' | 'drill', now: Date): StatView {
  if (tile === undefined) return NOT_REPORTED;
  if (what === 'backup' && backupNotConfigured(tile)) {
    const missing = /\(([^)]+) not set\)/.exec(tile.detail)?.[1];
    const ran = tile.since === null ? null : `local dump ran ${relativeTime(tile.since, now)}`;
    return {
      value: 'Local only',
      status: { label: 'No offsite copy', tone: 'attention' },
      footnote: [missing === undefined ? 'Offsite backups not configured' : `${missing} not set`, ran].filter((p) => p !== null).join(' · '),
    };
  }
  const stat = lastRunStat(tile, now);
  return { ...stat, status: TILE_TONE[tile.state], footnote: lastRunFootnote(tile, what) };
}

/** The daemons report by id ("smtp-in"); the Services list says what each one is (2.1 #6). */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'smtp-in': 'SMTP inbound',
  submission: 'Submission',
  imap: 'IMAP',
  managesieve: 'ManageSieve',
  delivery: 'Delivery',
  dav: 'CalDAV / CardDAV',
  worker: 'Worker',
  api: 'API',
  edge: 'Edge',
};

export function serviceName(tile: Pick<HealthTile, 'id' | 'label'>): string {
  const known = SERVICE_NAMES[tile.id];
  if (known !== undefined) return known;
  if (tile.label !== tile.id) return tile.label;
  return tile.label.charAt(0).toUpperCase() + tile.label.slice(1);
}

/** Details that only say the state again in other words: the dot already says it (2.1 #4, #7). */
const RESTATES: Readonly<Record<HealthTileState, readonly string[]>> = {
  ok: ['ok', 'reachable'],
  warn: ['reported degraded'],
  down: ['reported down'],
  unknown: ['not yet checked', 'never run'],
};

/** A tile's detail as a sentence, or null when it would only restate the status beside it. */
export function tileDetail(tile: Pick<HealthTile, 'state' | 'detail'>): string | null {
  const text = tile.detail.trim();
  if (text === '' || RESTATES[tile.state].includes(text.toLowerCase())) return null;
  return humanizeDetail(text);
}
