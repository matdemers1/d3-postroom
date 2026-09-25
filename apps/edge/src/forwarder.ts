// The edge forwarder (PST-ADR-002, PST-REQ-013/014/015/018): a pure L4 relay. It never parses
// TLS or SMTP — it only accepts a client TCP connection, counts it against per-IP and total
// caps, opens a matching connection to home over WireGuard, prefixes that stream with a PROXY
// protocol v2 header carrying the client's real address, and then pipes bytes both ways.
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import type { ForwarderConfig, ListenerConfig, ListenerRole } from './config.js';

const CRLF = '\r\n';

function smtpLine(code: number, enhanced: string, text: string): string {
  return `${String(code)} ${enhanced} ${text}${CRLF}`;
}

/** Roles that speak plaintext SMTP before any TLS handshake, so a 421 banner is meaningful. */
function speaksPlaintextSmtpBanner(role: ListenerRole): boolean {
  return role === 'smtp' || role === 'submission-starttls';
}

export interface LogEvent {
  readonly ts: string;
  readonly port: number;
  readonly role: ListenerRole;
  readonly client: string;
  readonly outcome:
    | 'forwarded'
    | 'refused-per-ip-cap'
    | 'refused-total-cap'
    | 'home-unreachable'
    | 'error';
  readonly bytesIn?: number;
  readonly bytesOut?: number;
  readonly durationMs?: number;
}

export type Logger = (event: LogEvent) => void;

const defaultLogger: Logger = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

export interface StartForwarderOptions {
  readonly logger?: Logger;
}

export interface CloseOptions {
  /** Milliseconds to let open connections drain before force-closing them. Default: 0 (immediate). */
  readonly graceMs?: number;
}

export interface ForwarderStats {
  readonly total: number;
  readonly perIp: ReadonlyMap<string, number>;
}

export interface Forwarder {
  close(options?: CloseOptions): Promise<void>;
  ports(): readonly { port: number; role: ListenerRole }[];
  stats(): ForwarderStats;
}

interface ConnectionCounters {
  total: number;
  readonly perIp: Map<string, number>;
}

function normalizeClientAddress(address: string | undefined): string {
  if (address === undefined) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function endWithSmtpLine(socket: Socket, code: number, enhanced: string, text: string): void {
  socket.end(smtpLine(code, enhanced, text));
}

export function startForwarder(
  config: ForwarderConfig,
  options: StartForwarderOptions = {},
): Promise<Forwarder> {
  const log = options.logger ?? defaultLogger;
  const counters: ConnectionCounters = { total: 0, perIp: new Map() };
  const servers: Server[] = [];
  const openSockets = new Set<Socket>();

  function acquire(ip: string): boolean {
    if (counters.total >= config.maxTotal) return false;
    const current = counters.perIp.get(ip) ?? 0;
    if (current >= config.maxPerIp) return false;
    counters.total += 1;
    counters.perIp.set(ip, current + 1);
    return true;
  }

  function release(ip: string): void {
    counters.total = Math.max(0, counters.total - 1);
    const current = counters.perIp.get(ip) ?? 0;
    if (current <= 1) {
      counters.perIp.delete(ip);
    } else {
      counters.perIp.set(ip, current - 1);
    }
  }

  function handleConnection(listener: ListenerConfig, client: Socket): void {
    const start = Date.now();
    const clientIp = normalizeClientAddress(client.remoteAddress);
    const clientPort = client.remotePort ?? 0;

    openSockets.add(client);
    client.once('close', () => {
      openSockets.delete(client);
    });

    if (!acquire(clientIp)) {
      const outcome = counters.total >= config.maxTotal ? 'refused-total-cap' : 'refused-per-ip-cap';
      if (speaksPlaintextSmtpBanner(listener.role)) {
        endWithSmtpLine(client, 421, '4.7.0', 'mx.d3cloud.io Too many connections from your address');
      } else {
        client.destroy();
      }
      log({
        ts: new Date().toISOString(),
        port: listener.port,
        role: listener.role,
        client: `${clientIp}:${String(clientPort)}`,
        outcome,
        durationMs: Date.now() - start,
      });
      return;
    }

    let released = false;
    function releaseOnce(): void {
      if (released) return;
      released = true;
      release(clientIp);
    }

    // The slot acquired above must come back no matter what happens next — including a client
    // that errors or disconnects before home ever connects (PST-T-0.13 refutation #1), and
    // including a client RST arriving during the home-connect window, which must not throw an
    // uncaught 'error' and take the whole process down (refutation #2).
    let clientGoneBeforeHome = false;
    client.once('close', () => {
      clientGoneBeforeHome = true;
      releaseOnce();
    });
    client.on('error', () => {
      // Swallowed deliberately: an error on the client socket (e.g. ECONNRESET) is handled by
      // the 'close' listener above, which always fires after 'error' and releases the slot. A
      // socket 'error' with no listener is what crashes the process — this listener's only job
      // is to exist.
    });

    client.setTimeout(config.idleTimeoutMs, () => {
      client.destroy();
    });

    const home = createConnection({
      host: config.homeHost,
      port: listener.homePort,
      timeout: config.connectTimeoutMs,
    });
    openSockets.add(home);
    home.once('close', () => {
      openSockets.delete(home);
    });
    // Same reasoning as the client: never let an unhandled 'error' on the home socket crash the
    // forwarder. onHomeUnreachable (below) and the post-connect handler (further below) both
    // attach their own 'error' listeners, so this is a safety net for any gap between them.
    home.on('error', () => {
      // Swallowed deliberately — see the comment above.
    });

    let connectedToHome = false;

    client.once('close', () => {
      if (!connectedToHome) {
        home.destroy();
      }
    });

    function onHomeUnreachable(): void {
      if (connectedToHome) return;
      home.destroy();
      if (speaksPlaintextSmtpBanner(listener.role)) {
        endWithSmtpLine(client, 421, '4.3.2', 'mx.d3cloud.io Service temporarily unavailable, try again later');
      } else {
        client.destroy();
      }
      releaseOnce();
      log({
        ts: new Date().toISOString(),
        port: listener.port,
        role: listener.role,
        client: `${clientIp}:${String(clientPort)}`,
        outcome: 'home-unreachable',
        durationMs: Date.now() - start,
      });
    }

    home.once('error', onHomeUnreachable);
    home.once('timeout', onHomeUnreachable);

    home.once('connect', () => {
      if (clientGoneBeforeHome) {
        home.destroy();
        releaseOnce();
        return;
      }
      connectedToHome = true;
      home.off('error', onHomeUnreachable);
      home.off('timeout', onHomeUnreachable);
      home.setTimeout(0);

      const localAddress = client.localAddress ?? config.homeHost;
      const localPort = client.localPort ?? 0;
      const sourceFamily = client.remoteFamily === 'IPv6' ? 'TCP6' : 'TCP4';

      const header = encodeProxyV2({
        command: 'PROXY',
        family: sourceFamily,
        source: { address: normalizeClientAddress(client.remoteAddress), port: clientPort },
        destination: { address: normalizeClientAddress(localAddress), port: localPort },
      });

      let bytesIn = 0;
      let bytesOut = 0;
      let forwardingError = false;

      home.write(header);

      client.on('data', (chunk: Buffer) => {
        bytesIn += chunk.length;
      });
      home.on('data', (chunk: Buffer) => {
        bytesOut += chunk.length;
      });

      function finish(outcome: LogEvent['outcome']): void {
        releaseOnce();
        log({
          ts: new Date().toISOString(),
          port: listener.port,
          role: listener.role,
          client: `${clientIp}:${String(clientPort)}`,
          outcome,
          bytesIn,
          bytesOut,
          durationMs: Date.now() - start,
        });
      }

      client.on('error', () => {
        forwardingError = true;
      });
      home.on('error', () => {
        forwardingError = true;
      });

      client.pipe(home);
      home.pipe(client);

      client.once('close', () => {
        home.destroy();
        finish(forwardingError ? 'error' : 'forwarded');
      });
      home.once('close', () => {
        client.destroy();
      });
    });
  }

  const listenPromises = config.listeners.map(
    (listener) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((socket) => {
          handleConnection(listener, socket);
        });
        server.once('error', reject);
        server.listen(listener.port, config.listenHost, () => {
          server.off('error', reject);
          resolve(server);
        });
      }),
  );

  return Promise.all(listenPromises).then((startedServers) => {
    servers.push(...startedServers);
    return {
      ports(): readonly { port: number; role: ListenerRole }[] {
        return config.listeners.map((listener, i) => {
          const server = servers[i];
          const address = server?.address();
          const port =
            address !== null && address !== undefined && typeof address !== 'string'
              ? address.port
              : listener.port;
          return { port, role: listener.role };
        });
      },
      stats(): ForwarderStats {
        return { total: counters.total, perIp: new Map(counters.perIp) };
      },
      close(closeOptions: CloseOptions = {}): Promise<void> {
        const graceMs = closeOptions.graceMs ?? 0;
        return new Promise((resolve) => {
          for (const server of servers) {
            server.close();
          }
          if (openSockets.size === 0 || graceMs <= 0) {
            for (const socket of openSockets) {
              socket.destroy();
            }
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            for (const socket of openSockets) {
              socket.destroy();
            }
            resolve();
          }, graceMs);
          const check = setInterval(() => {
            if (openSockets.size === 0) {
              clearInterval(check);
              clearTimeout(timer);
              resolve();
            }
          }, 100);
        });
      },
    };
  });
}
