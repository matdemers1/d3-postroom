// IMAP4rev1/rev2 on 993 (implicit TLS) and 143 (STARTTLS) — PST-T-3.2; ManageSieve on 4190 is
// PST-P-9 and still refuses and closes.
//
// Environment: DATABASE_URL, PASSWORD_PEPPER, POSTROOM_KEK, BLOB_ROOT, TLS_CERT_FILE, TLS_KEY_FILE,
// IMAPS_PORT (993), IMAP_PORT (143; 0 disables), LISTEN_HOST, EDGE_PEER_ADDRESS, PROXY_TIMEOUT_MS,
// IMAP_MAX_CONNECTIONS_PER_IP (20), IMAP_IDLE_TIMEOUT_MS (30 min, never less), IMAP_PREAUTH_TIMEOUT_MS
// (60 s), IMAP_MAX_APPEND_SIZE (100 MB), IMAP_STRUCTURE_CACHE (1000), MANAGESIEVE_PORT, HEALTH_PORT.
import { readFileSync } from 'node:fs';
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { envInt, envString, placeholderListener, runDaemon, type DaemonContext } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { loadConfig } from './config.js';
import { DAEMON } from './daemon.js';
import { createImapListeners } from './server.js';

export async function start(ctx: DaemonContext): Promise<void> {
  const config = loadConfig(ctx.env);
  const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const db = createDb(databaseUrl);
  ctx.onShutdown(() => db.$disconnect());
  const pepper = envString(ctx.env, 'PASSWORD_PEPPER', '');
  if (pepper === '') ctx.log('no-pepper', { message: 'PASSWORD_PEPPER is not set: every login will be refused' });

  // TLS is required before LOGIN, so without a certificate nothing can log in: fail closed, loudly,
  // with no 993 listener at all, and say so on /health.
  let tls: { key: Buffer; cert: Buffer } | null = null;
  if (config.tlsCertFile === undefined || config.tlsKeyFile === undefined) {
    ctx.log('no-tls-certificate', { message: 'TLS_CERT_FILE/TLS_KEY_FILE not set: no 993, no STARTTLS, no login' });
  } else {
    try {
      tls = { key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertFile) };
    } catch (error) {
      ctx.log('no-tls-certificate', {
        message: 'cannot read the TLS certificate: no 993, no STARTTLS, no login',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const blobs = createBlobStore({ root: config.blobRoot, db, kek: loadKek({ env: ctx.env }) });
  const listeners = createImapListeners({
    db,
    blobs,
    pepper: pepper === '' ? undefined : pepper,
    tls,
    edgePeers: config.edgePeers,
    proxyTimeoutMs: config.proxyTimeoutMs,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    idleTimeoutMs: config.idleTimeoutMs,
    preauthTimeoutMs: config.preauthTimeoutMs,
    maxAppendSize: config.maxAppendSize,
    structureCacheEntries: config.structureCacheEntries,
    log: ctx.log,
  });
  const listening: number[] = [];
  if (listeners.imaps !== null) listening.push((await listeners.listen(listeners.imaps, config.imapsPort, config.host)).port);
  if (config.imapPort > 0) listening.push((await listeners.listen(listeners.imap, config.imapPort, config.host)).port);
  ctx.onShutdown(() => listeners.close());

  const sieve = await placeholderListener(envInt(ctx.env, 'MANAGESIEVE_PORT', 4190), config.host, 'BYE "Postroom ManageSieve is not open yet"');
  ctx.onShutdown(() => new Promise<void>((resolve) => sieve.close(() => { resolve(); })));

  ctx.log('listening', { host: config.host, ports: listening, tls: tls !== null, edgePeers: config.edgePeers });
  ctx.addHealth(async () => {
    await db.$queryRaw`SELECT 1`;
    return tls === null
      ? { status: 'degraded', tls: 'degraded: no TLS certificate', listening, imapSessions: listeners.activeSessions() }
      : { tls: 'ok', listening, imapSessions: listeners.activeSessions() };
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9103),
  start,
});
