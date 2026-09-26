// imap configuration from the environment. Pure, so the defaults are unit-tested.
import { envInt, envString } from '@postroom/daemon';

export interface ImapConfig {
  readonly host: string;
  /** Implicit TLS (RFC 8314). Only listens when a certificate is configured. */
  readonly imapsPort: number;
  /** Plaintext with STARTTLS and LOGINDISABLED until TLS; 0 disables it. */
  readonly imapPort: number;
  /** The edge's WireGuard peer address(es): the only sources PROXY v2 is accepted from (PST-REQ-016). */
  readonly edgePeers: readonly string[];
  readonly proxyTimeoutMs: number;
  readonly maxConnectionsPerIp: number;
  /** RFC 9051 §5.4: an authenticated client may idle at least 30 minutes. */
  readonly idleTimeoutMs: number;
  readonly preauthTimeoutMs: number;
  readonly maxAppendSize: number;
  readonly tlsCertFile: string | undefined;
  readonly tlsKeyFile: string | undefined;
  readonly blobRoot: string;
  readonly structureCacheEntries: number;
}

export const MIN_IDLE_TIMEOUT_MS = 30 * 60_000;

export function loadConfig(env: NodeJS.ProcessEnv): ImapConfig {
  const peers = envString(env, 'EDGE_PEER_ADDRESS', '10.77.0.1')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const cert = envString(env, 'TLS_CERT_FILE', '');
  const key = envString(env, 'TLS_KEY_FILE', '');
  return {
    host: envString(env, 'LISTEN_HOST', '0.0.0.0'),
    imapsPort: envInt(env, 'IMAPS_PORT', 993),
    imapPort: envInt(env, 'IMAP_PORT', 143),
    edgePeers: peers,
    proxyTimeoutMs: envInt(env, 'PROXY_TIMEOUT_MS', 5_000),
    maxConnectionsPerIp: envInt(env, 'IMAP_MAX_CONNECTIONS_PER_IP', 20),
    idleTimeoutMs: Math.max(MIN_IDLE_TIMEOUT_MS, envInt(env, 'IMAP_IDLE_TIMEOUT_MS', MIN_IDLE_TIMEOUT_MS)),
    preauthTimeoutMs: envInt(env, 'IMAP_PREAUTH_TIMEOUT_MS', 60_000),
    maxAppendSize: envInt(env, 'IMAP_MAX_APPEND_SIZE', 100 * 1000 * 1000),
    tlsCertFile: cert === '' ? undefined : cert,
    tlsKeyFile: key === '' ? undefined : key,
    blobRoot: envString(env, 'BLOB_ROOT', '/var/lib/postroom/blobs'),
    structureCacheEntries: envInt(env, 'IMAP_STRUCTURE_CACHE', 1000),
  };
}
