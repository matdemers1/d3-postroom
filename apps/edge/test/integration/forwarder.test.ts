import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProxyHeader } from '@postroom/proxy-protocol';
import { startForwarder, type Forwarder } from '../../src/forwarder.js';
import type { ForwarderConfig } from '../../src/config.js';

/** A fake "home" server that reads the PROXY v2 header, then echoes `client=<ip>:<port>\n`
 * followed by an echo of anything else it receives. */
function startFakeHome(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      readProxyHeader(socket, { timeoutMs: 2000, maxBytes: 4096 })
        .then(({ header, rest }) => {
          const src = header.source;
          socket.write(`client=${src?.address ?? 'none'}:${String(src?.port ?? 0)}\n`);
          if (rest.length > 0) socket.write(rest);
          // Echo anything further written by the client, verbatim, back on the same socket.
          socket.on('data', (chunk: Buffer) => {
            socket.write(chunk);
          });
          socket.resume();
        })
        .catch(() => {
          socket.destroy();
        });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

function connectClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function readLine(socket: Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for a line, got so far: ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(buffer.slice(0, newlineIndex + 1));
      }
    }
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

describe('edge forwarder', () => {
  let fakeHome: { server: Server; port: number } | undefined;
  let forwarder: Forwarder | undefined;

  beforeEach(async () => {
    fakeHome = await startFakeHome();
  });

  afterEach(async () => {
    if (forwarder) await forwarder.close();
    forwarder = undefined;
    if (fakeHome) {
      await new Promise<void>((resolve) => {
        fakeHome?.server.close(() => {
          resolve();
        });
      });
    }
    fakeHome = undefined;
  });

  function baseConfig(overrides: Partial<ForwarderConfig> = {}): ForwarderConfig {
    if (!fakeHome) throw new Error('fakeHome not started');
    return {
      listenHost: '127.0.0.1',
      listeners: [{ port: 0, role: 'smtp', homePort: fakeHome.port }],
      homeHost: '127.0.0.1',
      maxPerIp: 20,
      maxTotal: 1000,
      connectTimeoutMs: 2000,
      idleTimeoutMs: 60_000,
      ...overrides,
    };
  }

  it('forwards the real client address in a PROXY v2 header', async () => {
    forwarder = await startForwarder(baseConfig());
    const ports = forwarder.ports();
    const listenPort = ports[0]?.port;
    expect(listenPort).toBeDefined();
    if (listenPort === undefined) return;

    const client = await connectClient(listenPort);
    const line = await readLine(client);

    const localPort = client.localPort;
    expect(line).toBe(`client=127.0.0.1:${String(localPort)}\n`);

    client.destroy();
  });

  it('answers with a 421 line when home is unreachable', async () => {
    // Point at a port nothing listens on.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => {
          resolve(address.port);
        });
      });
    });

    forwarder = await startForwarder(
      baseConfig({ listeners: [{ port: 0, role: 'smtp', homePort: deadPort }], connectTimeoutMs: 500 }),
    );
    const ports = forwarder.ports();
    const listenPort = ports[0]?.port;
    expect(listenPort).toBeDefined();
    if (listenPort === undefined) return;

    const client = await connectClient(listenPort);
    const line = await readLine(client);
    expect(line.startsWith('421')).toBe(true);
  });

  it('caps concurrent connections per client address, refusing the 21st', async () => {
    forwarder = await startForwarder(baseConfig({ maxPerIp: 20 }));
    const ports = forwarder.ports();
    const listenPort = ports[0]?.port;
    expect(listenPort).toBeDefined();
    if (listenPort === undefined) return;

    const clients: Socket[] = [];
    for (let i = 0; i < 20; i += 1) {
      const client = await connectClient(listenPort);
      await readLine(client); // wait for the "client=" echo so we know it was forwarded, not refused
      clients.push(client);
    }

    const refused = await connectClient(listenPort);
    const line = await readLine(refused);
    expect(line.startsWith('421')).toBe(true);
    expect(line).toContain('Too many connections');

    for (const client of clients) client.destroy();
    refused.destroy();
  });
});
