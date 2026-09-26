// Inbound SMTP on :25 (PST-P-2), inside the wireguard sidecar's network namespace. Connections from
// the edge carry PROXY v2; anything else is a direct connection and must not.
// Storage (PST-T-2.6): BLOB_ROOT, POSTROOM_KEK, TRUSTED_ARC_SEALERS (comma-separated, default google.com).
import { existsSync, readFileSync } from 'node:fs';
import { adaptDnsResolver } from '@postroom/auth-checks';
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { envInt, envString, runDaemon, type DaemonContext } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { createResolver } from '@postroom/dns';
import { createDnsblChecker } from '@postroom/dnsbl';
import { loadConfig } from './config.js';
import { DAEMON } from './daemon.js';
import { reverseLookupVia } from './rdns.js';
import { createSmtpInServer } from './server.js';

/** The daemon's boot sequence, exported so tests can call exactly what production runs — including
 * the DNSBL client, which must fail to boot on a public resolver (PST-REQ-063) before anything
 * binds a port. */
export async function start(ctx: DaemonContext): Promise<void> {
  const config = loadConfig(ctx.env);
  const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const db = createDb(databaseUrl);
  ctx.onShutdown(() => db.$disconnect());

  const resolver = createResolver({ server: config.dnsResolver });
  // Boot-time (PST-REQ-063): throws synchronously when config.dnsResolver is a public resolver,
  // a DQS key or not — Spamhaus refuses public resolvers anyway, and we forbid it regardless.
  const dnsbl = createDnsblChecker({
    resolver,
    server: config.dnsResolver,
    dqsKey: config.spamhausDqsKey,
    log: ctx.log,
  });
  ctx.addHealth(() => ({ dnsbl: dnsbl.health() }));
  const blobs = createBlobStore({
    root: envString(ctx.env, 'BLOB_ROOT', '/var/lib/postroom/blobs'),
    db,
    kek: loadKek({ env: ctx.env }),
  });
  const trustedArcSealers = envString(ctx.env, 'TRUSTED_ARC_SEALERS', 'google.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '');
  const { tlsCertFile: certFile, tlsKeyFile: keyFile } = config;
  const tls =
    certFile !== undefined && keyFile !== undefined && existsSync(certFile) && existsSync(keyFile)
      ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
      : undefined;

  const smtp = createSmtpInServer({
    db,
    hostname: config.hostname,
    maxSize: config.maxSize,
    edgePeers: config.edgePeers,
    proxyTimeoutMs: config.proxyTimeoutMs,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    maxRecipientsPerMessage: config.maxRecipientsPerMessage,
    maxRecipientsPerSession: config.maxRecipientsPerSession,
    maxErrors: config.maxErrors,
    idleTimeoutMs: config.idleTimeoutMs,
    tls,
    spfDns: adaptDnsResolver(resolver),
    dkimDns: resolver,
    reverseLookup: reverseLookupVia(resolver),
    dnsblLookup: (ip) => dnsbl.lookup(ip),
    storage: { db, blobs, dns: resolver, trustedArcSealers, log: ctx.log },
    log: ctx.log,
  });
  const bound = await smtp.listen(config.port, config.host);
  ctx.log('listening', {
    port: bound.port,
    host: config.host,
    hostname: config.hostname,
    starttls: tls !== undefined,
    edgePeers: config.edgePeers,
  });
  ctx.onShutdown(() => smtp.close());
  ctx.addHealth(async () => {
    await db.$queryRaw`SELECT 1`;
    return { smtpSessions: smtp.activeSessions(), starttls: tls !== undefined };
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9101),
  start,
});
