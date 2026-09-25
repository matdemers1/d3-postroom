// Stateless Lightsail forwarder: listeners, PROXY v2, per-IP caps, 421 when home is gone.
import { loadConfigFromEnv } from './config.js';
import { startForwarder } from './forwarder.js';

const GRACEFUL_SHUTDOWN_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfigFromEnv(process.env);
  const forwarder = await startForwarder(config);

  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), msg: 'edge forwarder listening', ports: forwarder.ports() })}\n`,
  );

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), msg: 'edge forwarder draining', signal })}\n`,
    );
    forwarder
      .close({ graceMs: GRACEFUL_SHUTDOWN_MS })
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), msg: 'edge forwarder failed to start', error: String(err) })}\n`);
  process.exit(1);
});
