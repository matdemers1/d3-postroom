// Disk usage (PST-REQ-097): fs.statfs on BLOB_ROOT and, when set, PGDATA — firing above
// `thresholdPct` used. `stat` is injectable so a test can simulate a full disk without one.
import { statfs } from 'node:fs/promises';
import type { Monitor } from './types.js';

export interface StatFsLike {
  readonly bavail: number;
  readonly blocks: number;
}

export interface DiskMonitorOptions {
  readonly paths: readonly string[];
  readonly thresholdPct?: number | undefined;
  readonly stat?: ((path: string) => Promise<StatFsLike>) | undefined;
}

const DEFAULT_THRESHOLD_PCT = 80;

export function createDiskMonitor(opts: DiskMonitorOptions): Monitor | null {
  if (opts.paths.length === 0) return null;
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const stat = opts.stat ?? statfs;

  return {
    name: 'disk',
    check: async () => {
      const results = await Promise.all(
        opts.paths.map(async (path) => {
          const info = await stat(path);
          const usedPct = info.blocks > 0 ? ((info.blocks - info.bavail) / info.blocks) * 100 : 0;
          return { path, usedPct };
        }),
      );
      const failing = results.filter((r) => r.usedPct > thresholdPct);
      const summary = results.map((r) => `${r.path}=${r.usedPct.toFixed(1)}%`).join(', ');
      if (failing.length === 0) {
        return { ok: true, detail: `disk usage under ${String(thresholdPct)}%: ${summary}`, value: results };
      }
      return { ok: false, detail: `disk usage over ${String(thresholdPct)}%: ${summary}`, value: results };
    },
  };
}
