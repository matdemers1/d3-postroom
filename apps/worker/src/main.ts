// Background stages: ACME, backups, restore drill (PST-P-0) and the inbound pipeline (PST-P-2).
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9106),
  start: (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    ctx.log('idle', { host });
    return Promise.resolve();
  },
});
