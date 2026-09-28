// Inbound SMTP on :25 (PST-P-2), inside the wireguard sidecar's network namespace. Connections from
// the edge carry PROXY v2; anything else is a direct connection and must not.
// Storage (PST-T-2.6): BLOB_ROOT, POSTROOM_KEK, TRUSTED_ARC_SEALERS (comma-separated, default google.com).
// Rate limits (PST-REQ-185): SMTP_IN_CONN_PER_MIN (30), SMTP_IN_UNKNOWN_RCPT_PER_10MIN (20); the
// windows are SMTP_IN_CONN_WINDOW_MS / SMTP_IN_UNKNOWN_RCPT_WINDOW_MS. SMTP_IN_DNSBL_WAIT_MS (3000)
// bounds how long MAIL FROM waits for the DNSBL verdict.
import { adaptDnsResolver } from '@postroom/auth-checks';
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { envInt, envString, runDaemon, type DaemonContext } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { createResolver } from '@postroom/dns';
import { createDnsblChecker } from '@postroom/dnsbl';
import { tlsHealth, watchTlsPair } from '@postroom/smtp-proto';
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
  // PST-REQ-020 / PST-T-11.13: the pair is watched, so a renewal (or a first issuance after boot)
  // is served without a restart. Without one, STARTTLS is not offered and /health says degraded.
  const tls = watchTlsPair({ certFile: config.tlsCertFile, keyFile: config.tlsKeyFile, log: ctx.log });
  ctx.onShutdown(() => {
    tls.close();
  });

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
    dnsblWaitMs: config.dnsblWaitMs,
    // PST-REQ-185: in-memory, per daemon (smtp-in is a single instance), bounded — see ratelimit.ts.
    rateLimits: {
      connectionsPerWindow: config.connectionsPerWindow,
      connectionWindowMs: config.connectionWindowMs,
      unknownRecipientsPerWindow: config.unknownRecipientsPerWindow,
      unknownRecipientWindowMs: config.unknownRecipientWindowMs,
    },
    storage: { db, blobs, dns: resolver, trustedArcSealers, log: ctx.log },
    log: ctx.log,
  });
  const bound = await smtp.listen(config.port, config.host);
  ctx.log('listening', {
    port: bound.port,
    host: config.host,
    hostname: config.hostname,
    starttls: tls.context() !== null,
    edgePeers: config.edgePeers,
  });
  ctx.onShutdown(() => smtp.close());
  ctx.addHealth(async () => {
    await db.$queryRaw`SELECT 1`;
    return {
      smtpSessions: smtp.activeSessions(),
      starttls: tls.context() !== null,
      rateLimitedNetworks: smtp.rateLimitTracked(),
      ...tlsHealth(tls),
    };
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9101),
  start,
});
