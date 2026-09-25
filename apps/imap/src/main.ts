// IMAP4rev1/rev2 on 993 and ManageSieve on 4190 (PST-P-3, PST-P-9). Until then both refuse and close.
import { envInt, envString, placeholderListener, runDaemon } from '@postroom/daemon';
import { DAEMON } from './daemon.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9103),
  start: async (ctx) => {
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    const LISTENERS: [string, number, string][] = [
      ['IMAPS_PORT', 993, '* BYE Postroom IMAP is not open yet'],
      ['MANAGESIEVE_PORT', 4190, 'BYE "Postroom ManageSieve is not open yet"'],
    ];
    for (const [name, port, line] of LISTENERS) {
      const server = await placeholderListener(envInt(ctx.env, name, port), host, line);
      ctx.onShutdown(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));
    }
  },
});
