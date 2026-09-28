// WireGuard tunnel handshake (PST-T-4.13, PST-REQ-182): the worker never joins the sidecar's
// network namespace, so it learns the peer's handshake age from the tiny read-only HTTP endpoint
// the sidecar itself serves (docker/wireguard's busybox httpd + CGI script, reachable at
// WIREGUARD_HEALTH_URL — same "http://wireguard:<port>" pattern DAEMON_HEALTH_URLS already uses for
// the protocol daemons sharing that netns). Set WIREGUARD_HEALTH_URL to '' to disable this monitor
// (e.g. a dev environment with no sidecar).
//
// The endpoint answers `{"configured":false}` when the sidecar is holding a bare namespace (no
// WG_PRIVATE_KEY) — that is not an incident, so the monitor stays quiet (`ok: true`) rather than
// firing on a placeholder tunnel that was never meant to come up. Once configured, `ok: false`
// whenever the latest handshake is missing/zero or older than `thresholdS` (default 180s = 3 min).
import type { Monitor } from './types.js';

interface WireguardHealthBody {
  readonly configured: boolean;
  readonly ageSeconds?: number | null;
}

export interface WireguardMonitorOptions {
  readonly url: string;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** How old (seconds) the latest handshake may be before this fires. Default 180 (PST-REQ-182). */
  readonly thresholdS?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_THRESHOLD_S = 180;

function isWireguardHealthBody(value: unknown): value is WireguardHealthBody {
  return typeof value === 'object' && value !== null && typeof (value as { configured?: unknown }).configured === 'boolean';
}

export function createWireguardMonitor(opts: WireguardMonitorOptions): Monitor | null {
  if (opts.url === '') return null;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const thresholdS = opts.thresholdS ?? DEFAULT_THRESHOLD_S;

  return {
    name: 'wireguard',
    check: async () => {
      let body: unknown;
      try {
        const res = await doFetch(opts.url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { ok: false, detail: `${opts.url} answered ${String(res.status)}` };
        body = await res.json();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `${opts.url} unreachable: ${reason}` };
      }
      if (!isWireguardHealthBody(body)) {
        return { ok: false, detail: `${opts.url} answered an unrecognised body` };
      }
      if (!body.configured) {
        // No WG_PRIVATE_KEY: the sidecar is deliberately holding a bare namespace, not an incident.
        return { ok: true, detail: 'wireguard sidecar unconfigured' };
      }
      const ageS = body.ageSeconds ?? null;
      if (ageS === null) {
        return { ok: false, detail: 'no handshake recorded yet' };
      }
      if (ageS > thresholdS) {
        return { ok: false, detail: `latest handshake ${String(Math.round(ageS))}s ago (threshold ${String(thresholdS)}s)` };
      }
      return { ok: true, detail: `latest handshake ${String(Math.round(ageS))}s ago` };
    },
  };
}
