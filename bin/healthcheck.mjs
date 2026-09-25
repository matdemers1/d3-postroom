#!/usr/bin/env node
// Container healthcheck: GET http://127.0.0.1:$HEALTH_PORT/health must answer 200.
const port = process.env.HEALTH_PORT?.trim() || process.argv[2];
if (!port) {
  console.error('healthcheck: HEALTH_PORT is not set');
  process.exit(1);
}
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
  process.exit(res.ok ? 0 : 1);
} catch (error) {
  console.error(`healthcheck: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
