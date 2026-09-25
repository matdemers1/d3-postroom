// Authenticated submission on 465/587 (PST-P-1). Until then both ports refuse with a 554 and close.
import { envInt, envString, placeholderListener, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9102),
  start: async (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    const LISTENERS: [string, number, string][] = [
      ['SUBMISSION_PORT', 587, '554 5.3.2 Postroom submission is not open yet'],
      ['SUBMISSIONS_PORT', 465, '554 5.3.2 Postroom submission is not open yet'],
    ];
    for (const [name, port, line] of LISTENERS) {
      const server = await placeholderListener(envInt(ctx.env, name, port), host, line);
      ctx.onShutdown(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));
    }
  },
});
