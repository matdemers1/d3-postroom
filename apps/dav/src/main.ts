// CalDAV/CardDAV on plain HTTP behind the Cloudflare Tunnel (dav.d3cloud.io → http://dav:8008) —
// PST-T-8.2, PST-REQ-132, PST-REQ-133. See docs/runbooks/dav.md.
//
// Environment: DATABASE_URL, PASSWORD_PEPPER, POSTROOM_KEK, LISTEN_HOST (0.0.0.0), LISTEN_PORT (8008),
// DAV_TRUSTED_PROXIES (loopback + private ranges), DAV_REQUIRE_HTTPS (true), DAV_MAX_XML_BYTES (1 MiB),
// DAV_MAX_RESOURCE_BYTES (4 MiB), DAV_MAX_COLLECTIONS (64), DAV_MAX_RESOURCES (50 000),
// DAV_AUTH_CACHE_MS (5 min), HEALTH_PORT (9105).
import { loadKek } from '@postroom/crypto';
import { envInt, envString, runDaemon, type DaemonContext } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { loadConfig } from './config.js';
import { DAEMON } from './daemon.js';
import { createDavServer } from './server.js';

export async function start(ctx: DaemonContext): Promise<void> {
  const config = loadConfig(ctx.env);
  const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const db = createDb(databaseUrl);
  ctx.onShutdown(() => db.$disconnect());
  const pepper = envString(ctx.env, 'PASSWORD_PEPPER', '');
  if (pepper === '') ctx.log('no-pepper', { message: 'PASSWORD_PEPPER is not set: every login will be refused' });
  if (!config.requireHttps) ctx.log('https-not-required', { message: 'DAV_REQUIRE_HTTPS=false: app passwords may arrive in the clear' });

  const dav = createDavServer({ db, kek: loadKek({ env: ctx.env }), pepper: pepper === '' ? undefined : pepper, config, log: ctx.log });
  const address = await dav.listen(config.port, config.host);
  ctx.onShutdown(() => dav.close());
  ctx.log('listening', { host: config.host, port: address.port, trustedProxies: config.trustedProxies, requireHttps: config.requireHttps });
  ctx.addHealth(async () => {
    await db.$queryRaw`SELECT 1`;
    return { listening: address.port };
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9105),
  start,
});
