// Inbound SMTP (PST-P-2). Until then it refuses every connection with a 554 banner and closes, so the stack's ports and network namespace can be proved first.
import { envInt, envString, placeholderListener, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9101),
  start: async (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    const LISTENERS: [string, number, string][] = [['SMTP_PORT', 25, '554 5.3.2 mx.d3cloud.io Postroom is not accepting mail yet']];
    for (const [name, port, line] of LISTENERS) {
      const server = await placeholderListener(envInt(ctx.env, name, port), host, line);
      ctx.onShutdown(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));
    }
  },
});
