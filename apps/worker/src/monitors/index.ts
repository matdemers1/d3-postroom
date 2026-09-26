// Building the health-alert monitors (PST-T-4.7) from the environment: tunnel, backlog, cert
// expiry, disk, blocklist, backup/drill and NTP skew. Each threshold has a default; a monitor whose
// configuration marks it not applicable (no tunnel URL, no cert files, no edge IP) is left out of
// the list entirely rather than firing on a placeholder value.
import { envInt, envString } from '@postroom/daemon';
import type { Db } from '@postroom/db';
import { createBacklogMonitor } from './backlog.js';
import { createBackupMonitor } from './backup.js';
import { createBlocklistMonitor } from './blocklist.js';
import { createCertMonitor } from './cert.js';
import { createDiskMonitor } from './disk.js';
import { createNtpMonitor, type NtpMonitor } from './ntp.js';
import { createTunnelMonitor } from './tunnel.js';
import type { Monitor } from './types.js';

export { createMonitorRunner, monitorStateKey, type Log, type MonitorRunner, type MonitorStatus } from './runner.js';
export type { Monitor, MonitorCheckResult } from './types.js';
export type { NtpMonitor, NtpStatus } from './ntp.js';

export interface BuildMonitorsOptions {
  readonly db: Db;
  readonly env: NodeJS.ProcessEnv;
  /** Whether backups are configured (maintenance.backup.config.s3 !== null). */
  readonly backupsConfigured: boolean;
}

export interface WorkerMonitors {
  readonly monitors: readonly Monitor[];
  readonly ntp: NtpMonitor;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

export function buildMonitors(opts: BuildMonitorsOptions): WorkerMonitors {
  const env = opts.env;
  const dqsKey = envString(env, 'SPAMHAUS_DQS_KEY', '');
  const pgData = envString(env, 'PGDATA', '');
  const diskPaths = [envString(env, 'BLOB_ROOT', '/var/lib/postroom/blobs'), ...(pgData === '' ? [] : [pgData])];

  const ntp = createNtpMonitor({
    server: envString(env, 'NTP_SERVER', 'time.cloudflare.com'),
    thresholdMs: envInt(env, 'NTP_SKEW_THRESHOLD_MS', 2_000),
  });

  const candidates: (Monitor | null)[] = [
    createTunnelMonitor({ url: envString(env, 'TUNNEL_HEALTH_URL', 'https://mail.d3cloud.io/health') }),
    createBacklogMonitor({
      db: opts.db,
      threshold: envInt(env, 'BACKLOG_THRESHOLD', 500),
      maxAgeS: envInt(env, 'BACKLOG_MAX_AGE_S', 3_600),
    }),
    createCertMonitor({
      files: splitList(envString(env, 'TLS_CERT_FILES', '')),
      warnDays: envInt(env, 'CERT_WARN_DAYS', 14),
    }),
    createDiskMonitor({ paths: diskPaths, thresholdPct: envInt(env, 'DISK_THRESHOLD_PCT', 80) }),
    createBlocklistMonitor({
      ip: envString(env, 'EDGE_PUBLIC_IP', ''),
      resolverServer: envString(env, 'DNS_RESOLVER', '127.0.0.1:53'),
      dqsKey: dqsKey === '' ? undefined : dqsKey,
    }),
    createBackupMonitor({
      db: opts.db,
      configured: opts.backupsConfigured,
      maxAgeS: envInt(env, 'BACKUP_MAX_AGE_S', 36 * 3_600),
    }),
    ntp,
  ];

  return { monitors: candidates.filter((m): m is Monitor => m !== null), ntp };
}
