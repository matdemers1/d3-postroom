// Inbound SMTP on :25 (PST-P-2), inside the wireguard sidecar's network namespace. Connections from
// the edge carry PROXY v2; anything else is a direct connection and must not.
import { existsSync, readFileSync } from 'node:fs';
import { adaptDnsResolver } from '@postroom/auth-checks';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { createResolver } from '@postroom/dns';
import { loadConfig } from './config.js';
import { DAEMON } from './daemon.js';
import { reverseLookupVia } from './rdns.js';
import { createSmtpInServer } from './server.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9101),
  start: async (ctx) => {
    const config = loadConfig(ctx.env);
    const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
    if (databaseUrl === '') throw new Error('DATABASE_URL is required');
    const db = createDb(databaseUrl);
    ctx.onShutdown(() => db.$disconnect());

    const resolver = createResolver({ server: config.dnsResolver });
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
  },
});
