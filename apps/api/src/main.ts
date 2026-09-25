// HTTP API and web login (PST-T-0.8). Serves /health on its own port until the API lands.
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 3300),
  start: (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    ctx.log('idle', { host });
    return Promise.resolve();
  },
});
