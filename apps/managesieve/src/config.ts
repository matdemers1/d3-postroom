// managesieve configuration from the environment. Pure, so the defaults are unit-tested.
import { envInt, envString } from '@postroom/daemon';

export interface ManageSieveConfig {
  readonly host: string;
  /** RFC 5804's port: plaintext with STARTTLS (there is no implicit-TLS ManageSieve port). */
  readonly port: number;
  /** The edge's WireGuard peer address(es): the only sources PROXY v2 is accepted from (PST-REQ-016). */
  readonly edgePeers: readonly string[];
  readonly proxyTimeoutMs: number;
  readonly maxConnectionsPerIp: number;
  readonly preauthTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly tlsCertFile: string | undefined;
  readonly tlsKeyFile: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): ManageSieveConfig {
  const peers = envString(env, 'EDGE_PEER_ADDRESS', '10.77.0.1')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const cert = envString(env, 'TLS_CERT_FILE', '');
  const key = envString(env, 'TLS_KEY_FILE', '');
  return {
    host: envString(env, 'LISTEN_HOST', '0.0.0.0'),
    // The imap daemon's old 4190 placeholder reads the same name; compose gives imap "0" so the two
    // never collide in the shared netns (see docker-compose.yml).
    port: envInt(env, 'MANAGESIEVE_PORT', 4190),
    edgePeers: peers,
    proxyTimeoutMs: envInt(env, 'PROXY_TIMEOUT_MS', 5_000),
    maxConnectionsPerIp: envInt(env, 'MANAGESIEVE_MAX_CONNECTIONS_PER_IP', 10),
    preauthTimeoutMs: envInt(env, 'MANAGESIEVE_PREAUTH_TIMEOUT_MS', 60_000),
    idleTimeoutMs: envInt(env, 'MANAGESIEVE_IDLE_TIMEOUT_MS', 30 * 60_000),
    tlsCertFile: cert === '' ? undefined : cert,
    tlsKeyFile: key === '' ? undefined : key,
  };
}
