// Config parsing for the edge forwarder. Every value has a default; a blank env var counts as
// unset. See PST-ADR-002: the edge is a $5 Lightsail box running only WireGuard, nftables and
// this hand-rolled Node process.

export type ListenerRole = 'smtp' | 'submission-starttls' | 'implicit-tls' | 'sieve';

export interface ListenerConfig {
  readonly port: number;
  readonly role: ListenerRole;
  readonly homePort: number;
}

export interface ForwarderConfig {
  readonly listenHost: string;
  readonly listeners: readonly ListenerConfig[];
  readonly homeHost: string;
  readonly maxPerIp: number;
  readonly maxTotal: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

const DEFAULT_LISTEN_HOST = '0.0.0.0';
const DEFAULT_PORTS = [25, 465, 587, 993, 4190];
const DEFAULT_MAX_PER_IP = 20;
const DEFAULT_MAX_TOTAL = 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

/** Canonical port → role mapping used when a listener's role isn't given explicitly. */
export function roleForPort(port: number): ListenerRole {
  switch (port) {
    case 25:
      return 'smtp';
    case 587:
      return 'submission-starttls';
    case 465:
    case 993:
      return 'implicit-tls';
    case 4190:
      return 'sieve';
    default:
      throw new Error(`no canonical role for port ${String(port)}; pass an explicit role`);
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const raw = blankToUndefined(value);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`expected an integer, got "${raw}"`);
  }
  return parsed;
}

function parsePorts(value: string | undefined): readonly ListenerConfig[] {
  const raw = blankToUndefined(value);
  const ports = raw === undefined ? DEFAULT_PORTS : raw.split(',').map((p) => Number.parseInt(p.trim(), 10));
  return ports.map((port) => ({ port, role: roleForPort(port), homePort: port }));
}

export interface EnvSource {
  readonly [key: string]: string | undefined;
}

/** Parse the edge forwarder's configuration from environment variables. Blank = default. */
export function loadConfigFromEnv(env: EnvSource): ForwarderConfig {
  return {
    listenHost: blankToUndefined(env['EDGE_LISTEN_HOST']) ?? DEFAULT_LISTEN_HOST,
    listeners: parsePorts(env['EDGE_PORTS']),
    homeHost: blankToUndefined(env['HOME_HOST']) ?? '',
    maxPerIp: parseIntEnv(env['EDGE_MAX_PER_IP'], DEFAULT_MAX_PER_IP),
    maxTotal: parseIntEnv(env['EDGE_MAX_TOTAL'], DEFAULT_MAX_TOTAL),
    connectTimeoutMs: parseIntEnv(env['EDGE_CONNECT_TIMEOUT_MS'], DEFAULT_CONNECT_TIMEOUT_MS),
    idleTimeoutMs: parseIntEnv(env['EDGE_IDLE_TIMEOUT_MS'], DEFAULT_IDLE_TIMEOUT_MS),
  };
}
