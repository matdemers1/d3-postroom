// HTTP API and web login. Serves the web app and /health on API_PORT (3300).
import { createDb } from '@postroom/db';
import { envInt, envString, revision, runDaemon } from '@postroom/daemon';
import { createApp } from './app.js';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: 0,
  start: async (ctx) => {
    const db = createDb(envString(ctx.env, 'DATABASE_URL', ''));
    const app = createApp({
      db,
      env: ctx.env,
      config: {
        webDist: envString(ctx.env, 'WEB_DIST', '') || undefined,
        webOrigin: envString(ctx.env, 'WEB_ORIGIN', 'http://localhost:3300'),
        revision: revision(ctx.env),
        // Blank means unset (envString's rule), so an empty variable never becomes a real secret.
        passwordPepper: envString(ctx.env, 'PASSWORD_PEPPER', '') || undefined,
        sessionSecret: envString(ctx.env, 'SESSION_SECRET', '') || undefined,
        kekBase64: envString(ctx.env, 'POSTROOM_KEK', '') || undefined,
        d3authIssuer: envString(ctx.env, 'D3AUTH_ISSUER', '') || undefined,
        d3authClientId: envString(ctx.env, 'D3AUTH_CLIENT_ID', '') || undefined,
        d3authClientSecret: envString(ctx.env, 'D3AUTH_CLIENT_SECRET', '') || undefined,
        domain: envString(ctx.env, 'DOMAIN', '') || undefined,
        setupToken: envString(ctx.env, 'SETUP_TOKEN', '') || undefined,
      },
    });
    const port = envInt(ctx.env, 'HEALTH_PORT', envInt(ctx.env, 'API_PORT', 3300));
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    const server = app.listen(port, host);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    ctx.log('listening', { host, port });
    ctx.onShutdown(async () => {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await db.$disconnect();
    });
  },
});
