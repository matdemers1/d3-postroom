// GET /api/admin/health — one screen for PST-REQ-127: tunnel, every daemon, certificates, disk,
// the inbound queue, blocklist, backup and the restore drill, and NTP skew. Mounted by app.ts
// behind requireAdmin; nothing here mutates, so nothing is audited.
//
// Two sources feed the tiles:
//   - the monitor rows the worker's monitor runner persists (`monitor:<name>` settings — tunnel,
//     backlog, cert-expiry, disk, blocklist, backup-drill, ntp: apps/worker/src/monitors), read
//     directly rather than imported, since apps do not depend on one another here;
//   - each daemon's own `/health`, fetched from DAEMON_HEALTH_URLS (`name=url,name=url`, a short
//     timeout per request) — missing, unset or unreachable is reported as `down` with why, never
//     thrown.
// The inbound queue and the last backup/drill are read straight from the database, the same rows
// the worker's own `/health` reports (apps/worker/src/health.ts), so a fault shows up here even
// when the worker itself cannot be reached.
import { InboundState, type Db } from '@postroom/db';
import { Router } from 'express';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';

export type TileState = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthTile {
  readonly id: string;
  readonly label: string;
  readonly state: TileState;
  readonly detail: string;
  /** ISO 8601, when known. */
  readonly since: string | null;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** `name=url,name2=url2` (DAEMON_HEALTH_URLS); blank or missing means no daemon tiles. */
export function parseDaemonHealthUrls(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (value ?? '').split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const url = trimmed.slice(eq + 1).trim();
    if (name !== '' && url !== '') out.set(name, url);
  }
  return out;
}

interface DaemonHealthBody {
  status?: unknown;
}

async function fetchDaemonHealth(name: string, url: string, timeoutMs: number): Promise<HealthTile> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = (await res.json().catch(() => null)) as DaemonHealthBody | null;
    const status = typeof body?.status === 'string' ? body.status : null;
    if (!res.ok || status === 'down') {
      return { id: name, label: name, state: 'down', detail: status === null ? `HTTP ${String(res.status)}` : `reported ${status}`, since: null };
    }
    if (status === 'degraded') return { id: name, label: name, state: 'warn', detail: 'reported degraded', since: null };
    return { id: name, label: name, state: 'ok', detail: 'reachable', since: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: name, label: name, state: 'down', detail: controller.signal.aborted ? 'timed out' : message, since: null };
  } finally {
    clearTimeout(timer);
  }
}

/** A `monitor:<name>` setting row, as `apps/worker/src/monitors/runner.ts` writes it. */
interface PersistedMonitorState {
  state: 'ok' | 'firing';
  since: string;
  detail: string;
}

const MONITOR_LABELS: Record<string, string> = {
  tunnel: 'Tunnel',
  backlog: 'Queue backlog',
  'cert-expiry': 'Certificates',
  disk: 'Disk',
  blocklist: 'Blocklist',
  'backup-drill': 'Backup freshness',
  ntp: 'NTP',
};

async function monitorTile(db: Db, name: string, label: string): Promise<HealthTile> {
  const row = await db.setting.findUnique({ where: { key: `monitor:${name}` } });
  if (row === null) return { id: name, label, state: 'unknown', detail: 'not yet checked', since: null };
  const value = row.value as unknown as PersistedMonitorState;
  return { id: name, label, state: value.state === 'firing' ? 'down' : 'ok', detail: value.detail, since: value.since };
}

interface LastRun {
  at: string;
  ok: boolean;
  reason?: string;
  skipped?: string;
}

async function lastRunTile(db: Db, id: string, label: string, key: string): Promise<HealthTile> {
  const row = await db.setting.findUnique({ where: { key } });
  if (row === null) return { id, label, state: 'unknown', detail: 'never run', since: null };
  const value = row.value as unknown as LastRun;
  if (value.skipped !== undefined) return { id, label, state: 'unknown', detail: value.skipped, since: value.at };
  return { id, label, state: value.ok ? 'ok' : 'down', detail: value.ok ? 'ok' : (value.reason ?? 'failed'), since: value.at };
}

/** PST-T-6.3, PST-REQ-118: total bytes of every SMTP session transcript kept, compressed, forever. */
async function transcriptsTile(db: Db): Promise<HealthTile> {
  const agg = await db.smtpTranscript.aggregate({ _count: { _all: true }, _sum: { rawBytes: true, compressedBytes: true } });
  const count = agg._count._all;
  const compressedBytes = agg._sum.compressedBytes ?? 0;
  const rawBytes = agg._sum.rawBytes ?? 0;
  return {
    id: 'smtp-transcripts',
    label: 'SMTP transcripts',
    state: 'ok',
    detail: `${String(count)} session(s), ${String(compressedBytes)} bytes compressed (${String(rawBytes)} raw)`,
    since: null,
  };
}

async function queueTile(db: Db): Promise<HealthTile> {
  const [deadJobs, failedMessages] = await Promise.all([
    db.job.count({ where: { queue: 'inbound', status: 'dead' } }),
    db.inboundMessage.count({ where: { state: InboundState.failed } }),
  ]);
  if (deadJobs > 0 || failedMessages > 0) {
    return { id: 'queue', label: 'Inbound queue', state: 'down', detail: `${String(deadJobs)} dead job(s), ${String(failedMessages)} failed message(s)`, since: null };
  }
  return { id: 'queue', label: 'Inbound queue', state: 'ok', detail: 'no dead jobs', since: null };
}

export async function buildHealthTiles(deps: ApiDeps): Promise<HealthTile[]> {
  const { db, env } = deps;
  const daemonUrls = parseDaemonHealthUrls(env['DAEMON_HEALTH_URLS']);
  const timeoutMs = Number(env['DAEMON_HEALTH_TIMEOUT_MS'] ?? '') || DEFAULT_TIMEOUT_MS;

  const [tunnel, cert, disk, blocklist, backup, drill, ntp, queue, transcripts, ...daemons] = await Promise.all([
    monitorTile(db, 'tunnel', MONITOR_LABELS['tunnel'] ?? 'Tunnel'),
    monitorTile(db, 'cert-expiry', MONITOR_LABELS['cert-expiry'] ?? 'Certificates'),
    monitorTile(db, 'disk', MONITOR_LABELS['disk'] ?? 'Disk'),
    monitorTile(db, 'blocklist', MONITOR_LABELS['blocklist'] ?? 'Blocklist'),
    lastRunTile(db, 'backup', 'Backup', 'backup.last'),
    lastRunTile(db, 'drill', 'Restore drill', 'drill.last'),
    monitorTile(db, 'ntp', MONITOR_LABELS['ntp'] ?? 'NTP'),
    queueTile(db),
    transcriptsTile(db),
    ...Array.from(daemonUrls, ([name, url]) => fetchDaemonHealth(name, url, timeoutMs)),
  ]);

  return [tunnel, ...daemons, cert, disk, queue, transcripts, blocklist, backup, drill, ntp];
}

export function adminHealthRoutes(deps: ApiDeps): Router {
  const router = Router();
  router.get(
    '/',
    handle(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tiles: await buildHealthTiles(deps) });
    }),
  );
  return router;
}
