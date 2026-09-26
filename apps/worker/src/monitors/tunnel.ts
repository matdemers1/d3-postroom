// Is the Cloudflare Tunnel up (PST-REQ-097)? A GET to the public health endpoint that answers only
// when the tunnel is carrying traffic to the box; a non-2xx status or a timeout both count as down.
// Set TUNNEL_HEALTH_URL to '' to disable this monitor (e.g. in a dev environment with no tunnel).
import type { Monitor } from './types.js';

export interface TunnelMonitorOptions {
  readonly url: string;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createTunnelMonitor(opts: TunnelMonitorOptions): Monitor | null {
  if (opts.url === '') return null;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: 'tunnel',
    check: async () => {
      try {
        const res = await doFetch(opts.url, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok
          ? { ok: true, detail: `${opts.url} answered ${String(res.status)}` }
          : { ok: false, detail: `${opts.url} answered ${String(res.status)}` };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `${opts.url} unreachable: ${reason}` };
      }
    },
  };
}
