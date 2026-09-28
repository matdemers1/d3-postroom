// ManageSieve (RFC 5804) on 4190 with STARTTLS — PST-T-9.5, PST-REQ-149. Scripts stored here are run
// by the worker's sieve stage (PST-REQ-148); the webmail's rules builder writes the same store.
//
// Environment: DATABASE_URL, PASSWORD_PEPPER, TLS_CERT_FILE, TLS_KEY_FILE, MANAGESIEVE_PORT
// (4190), LISTEN_HOST, EDGE_PEER_ADDRESS, PROXY_TIMEOUT_MS, MANAGESIEVE_MAX_CONNECTIONS_PER_IP (10),
// MANAGESIEVE_PREAUTH_TIMEOUT_MS (60 s), MANAGESIEVE_IDLE_TIMEOUT_MS (30 min), HEALTH_PORT (9107).
import { envInt, envString, runDaemon, type DaemonContext } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { loadConfig } from './config.js';
import { DAEMON } from './daemon.js';
import { createManageSieveServer } from './server.js';
import { tlsHealth, watchTlsPair } from '@postroom/smtp-proto';

export async function start(ctx: DaemonContext): Promise<void> {
  const config = loadConfig(ctx.env);
  const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const db = createDb(databaseUrl);
  ctx.onShutdown(() => db.$disconnect());
  const pepper = envString(ctx.env, 'PASSWORD_PEPPER', '');
  if (pepper === '') ctx.log('no-pepper', { message: 'PASSWORD_PEPPER is not set: every login will be refused' });

  // TLS is required before AUTHENTICATE, so without a certificate nothing can log in: fail closed,
  // loudly, and say so on /health. The listener still answers, advertising no STARTTLS.
  // The pair is watched (PST-REQ-020, PST-T-11.13): a renewal, or a first issuance after boot, is
  // served without a restart; until one loads, /health says degraded.
  const tls = watchTlsPair({ certFile: config.tlsCertFile, keyFile: config.tlsKeyFile, log: ctx.log });
  ctx.onShutdown(() => {
    tls.close();
  });

  const server = createManageSieveServer({
    db,
    pepper: pepper === '' ? undefined : pepper,
    tls,
    edgePeers: config.edgePeers,
    proxyTimeoutMs: config.proxyTimeoutMs,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    preauthTimeoutMs: config.preauthTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    log: ctx.log,
  });
  const address = await server.listen(config.port, config.host);
  ctx.onShutdown(() => server.close());

  ctx.log('listening', { host: config.host, port: address.port, tls: tls.context() !== null, edgePeers: config.edgePeers });
  ctx.addHealth(async () => {
    await db.$queryRaw`SELECT 1`;
    return { port: address.port, sessions: server.activeSessions(), ...tlsHealth(tls) };
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9107),
  start,
});
