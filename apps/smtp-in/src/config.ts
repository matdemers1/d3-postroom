// smtp-in configuration from the environment. Pure, so the defaults are unit-tested.
import { envInt, envString } from '@postroom/daemon';

/** PST-REQ-051: the SIZE we advertise and enforce. */
export const MAX_MESSAGE_SIZE = 104_857_600;

export interface SmtpInConfig {
  readonly port: number;
  readonly host: string;
  /** The name we greet with and write into Received / Authentication-Results. */
  readonly hostname: string;
  readonly maxSize: number;
  /** The edge's WireGuard peer address(es): the only sources PROXY v2 is accepted from (PST-REQ-016). */
  readonly edgePeers: readonly string[];
  /** A connection from the peer must present its PROXY header within this long. */
  readonly proxyTimeoutMs: number;
  readonly maxConnectionsPerIp: number;
  readonly maxRecipientsPerMessage: number;
  readonly maxRecipientsPerSession: number;
  readonly maxErrors: number;
  readonly idleTimeoutMs: number;
  readonly dnsResolver: string;
  /** Spamhaus DQS key (PST-REQ-063); when set, DNSBL zones are queried via `<key>.zen.dq.spamhaus.net`
   * instead of the public `zen.spamhaus.org` zone. Either way the resolver must be our own — never
   * a public one — which is checked regardless of this key. */
  readonly spamhausDqsKey: string | undefined;
  readonly tlsCertFile: string | undefined;
  readonly tlsKeyFile: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): SmtpInConfig {
  const peers = envString(env, 'EDGE_PEER_ADDRESS', '10.77.0.1')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const cert = envString(env, 'TLS_CERT_FILE', '');
  const key = envString(env, 'TLS_KEY_FILE', '');
  const dqsKey = envString(env, 'SPAMHAUS_DQS_KEY', '');
  return {
    port: envInt(env, 'SMTP_PORT', 25),
    host: envString(env, 'LISTEN_HOST', '0.0.0.0'),
    hostname: envString(env, 'MX_HOSTNAME', 'mx.d3cloud.io'),
    maxSize: MAX_MESSAGE_SIZE,
    edgePeers: peers,
    proxyTimeoutMs: envInt(env, 'PROXY_TIMEOUT_MS', 5_000),
    maxConnectionsPerIp: envInt(env, 'SMTP_MAX_CONNECTIONS_PER_IP', 10),
    maxRecipientsPerMessage: envInt(env, 'SMTP_MAX_RCPT_PER_MESSAGE', 100),
    maxRecipientsPerSession: envInt(env, 'SMTP_MAX_RCPT_PER_SESSION', 500),
    maxErrors: envInt(env, 'SMTP_MAX_ERRORS', 10),
    idleTimeoutMs: envInt(env, 'SMTP_IDLE_TIMEOUT_MS', 300_000),
    dnsResolver: envString(env, 'DNS_RESOLVER', '127.0.0.1:53'),
    spamhausDqsKey: dqsKey === '' ? undefined : dqsKey,
    tlsCertFile: cert === '' ? undefined : cert,
    tlsKeyFile: key === '' ? undefined : key,
  };
}
