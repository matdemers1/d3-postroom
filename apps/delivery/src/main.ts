// Outbound delivery queue (PST-P-1). Until then it serves only /health.
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9104),
  start: (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    ctx.log('idle', { host, note: 'the outbound queue arrives in PST-P-1' });
    return Promise.resolve();
  },
});
