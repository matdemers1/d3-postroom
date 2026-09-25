// The runtime every Postroom daemon shares: a health endpoint Shipyard and compose can probe, a
// graceful shutdown, and env helpers where a blank value means "use the default".
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';

export const PACKAGE = '@postroom/daemon';

/** A blank or missing variable means the default, never zero or the empty string. */
export function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envString(env, name, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  daemon: string;
  revision: string;
  schemaRevision?: string | null;
  [key: string]: unknown;
}

export type HealthProbe = () => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface DaemonContext {
  name: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Register work to run on shutdown, newest first. */
  onShutdown: (fn: () => Promise<void> | void) => void;
  /** Contribute fields to /health; a thrown probe makes the daemon report `down`. */
  addHealth: (probe: HealthProbe) => void;
}

export function revision(env: NodeJS.ProcessEnv = process.env): string {
  return envString(env, 'POSTROOM_REVISION', 'dev');
}

export function makeLogger(name: string): DaemonContext['log'] {
  return (event, fields = {}) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), daemon: name, event, ...fields })}\n`);
  };
}

export async function collectHealth(name: string, env: NodeJS.ProcessEnv, probes: HealthProbe[]): Promise<HealthReport> {
  const report: HealthReport = { status: 'ok', daemon: name, revision: revision(env) };
  for (const probe of probes) {
    try {
      Object.assign(report, await probe());
    } catch (error) {
      report.status = 'down';
      report['error'] = error instanceof Error ? error.message : String(error);
    }
  }
  return report;
}

export function startHealthServer(port: number, host: string, report: () => Promise<HealthReport>): Promise<HttpServer> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/healthz')) {
      res.writeHead(404).end();
      return;
    }
    report().then(
      (body) => {
        res.writeHead(body.status === 'down' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      (error: unknown) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'down', error: error instanceof Error ? error.message : String(error) }));
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

export interface RunOptions {
  name: string;
  /** Port for GET /health; 0 disables the separate health server (the daemon serves its own). */
  healthPort: number;
  start: (ctx: DaemonContext) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  drainMs?: number;
}

/** Start a daemon, serve /health, and shut down cleanly on SIGTERM/SIGINT. */
export async function runDaemon(options: RunOptions): Promise<DaemonContext> {
  const env = options.env ?? process.env;
  const log = makeLogger(options.name);
  const shutdowns: (() => Promise<void> | void)[] = [];
  const probes: HealthProbe[] = [];
  const ctx: DaemonContext = {
    name: options.name,
    env,
    log,
    onShutdown: (fn) => shutdowns.unshift(fn),
    addHealth: (probe) => probes.push(probe),
  };
  await options.start(ctx);
  if (options.healthPort > 0) {
    const host = envString(env, 'HEALTH_HOST', '0.0.0.0');
    const health = await startHealthServer(options.healthPort, host, () => collectHealth(options.name, env, probes));
    shutdowns.push(() => new Promise<void>((resolve) => health.close(() => { resolve(); })));
  }
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log('shutdown', { signal });
    const timer = setTimeout(() => {
      log('shutdown-timeout');
      process.exit(1);
    }, options.drainMs ?? 30_000);
    timer.unref();
    void (async () => {
      for (const fn of shutdowns) {
        try {
          await fn();
        } catch (error) {
          log('shutdown-error', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      process.exit(0);
    })();
  };
  process.once('SIGTERM', () => { stop('SIGTERM'); });
  process.once('SIGINT', () => { stop('SIGINT'); });
  log('started', { revision: revision(env) });
  return ctx;
}

/**
 * A listener for a protocol whose daemon is not built yet: it answers every connection with one
 * honest line and closes, so the stack's shape (ports, netns, health) can be proved before the
 * protocol exists. Replaced by the real server in the protocol's own phase.
 */
export function placeholderListener(port: number, host: string, line: string): Promise<TcpServer> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { socket.destroy(); });
    socket.end(`${line}\r\n`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { resolve(server); });
  });
}
