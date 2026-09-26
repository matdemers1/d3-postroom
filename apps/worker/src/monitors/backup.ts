// Backup and restore drill health (PST-REQ-097): fires when the last backup or drill failed, or
// when either is older than `maxAgeS` — but only once backups are configured (PST-T-0.16's
// "unconfigured" state already records `ok: false`, and that is not an incident to alert on).
import type { Db } from '@postroom/db';
import { readLastBackup, readLastDrill } from '../backup/state.js';
import type { Monitor } from './types.js';

export interface BackupMonitorOptions {
  readonly db: Db;
  /** Whether backups are configured at all (maintenance.backup.config.s3 !== null). */
  readonly configured: boolean;
  readonly maxAgeS?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_MAX_AGE_S = 36 * 3600;

export function createBackupMonitor(opts: BackupMonitorOptions): Monitor {
  const maxAgeS = opts.maxAgeS ?? DEFAULT_MAX_AGE_S;
  const now = opts.now ?? ((): Date => new Date());

  return {
    name: 'backup-drill',
    check: async () => {
      if (!opts.configured) {
        return { ok: true, detail: 'backups not configured' };
      }
      const [lastBackup, lastDrill] = await Promise.all([readLastBackup(opts.db), readLastDrill(opts.db)]);
      const nowMs = now().getTime();
      const ageS = (at: string): number => (nowMs - Date.parse(at)) / 1000;
      const backupBad = lastBackup === null || !lastBackup.ok || ageS(lastBackup.at) > maxAgeS;
      const drillBad = lastDrill === null || !lastDrill.ok || ageS(lastDrill.at) > maxAgeS;
      if (!backupBad && !drillBad) {
        return { ok: true, detail: 'backup and drill both current', value: { lastBackup, lastDrill } };
      }
      const parts: string[] = [];
      if (backupBad) {
        parts.push(
          lastBackup === null
            ? 'no backup recorded'
            : lastBackup.ok
              ? `backup stale (last at ${lastBackup.at})`
              : `backup failed: ${lastBackup.reason ?? lastBackup.skipped ?? 'unknown'}`,
        );
      }
      if (drillBad) {
        parts.push(
          lastDrill === null
            ? 'no drill recorded'
            : lastDrill.ok
              ? `drill stale (last at ${lastDrill.at})`
              : `drill failed: ${lastDrill.reason}`,
        );
      }
      return { ok: false, detail: parts.join('; '), value: { lastBackup, lastDrill } };
    },
  };
}
