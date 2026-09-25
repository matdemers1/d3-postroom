import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProxyHeader } from '@postroom/proxy-protocol';
import { startForwarder, type Forwarder } from '../../src/forwarder.js';
import type { ForwarderConfig } from '../../src/config.js';

/** A documentation-only, non-routable address (RFC 5737 TEST-NET-3). Connecting to it from this
 * sandbox produces no SYN-ACK and no RST, so a TCP connect attempt genuinely stalls until our own
 * `connectTimeoutMs` fires — the only reliable way to hold a home connection "in flight" for a
 * test, since on loopback a TCP handshake completes at the kernel level before any application
 * code (ours or a fake server's) runs. */
const BLACKHOLE_HOST = '203.0.113.1';
const BLACKHOLE_PORT = 9;

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

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('frees the per-IP slot when a client aborts a still-connecting home attempt (PST-T-0.13 refutation 1)', async () => {
    forwarder = await startForwarder(
      baseConfig({
        homeHost: BLACKHOLE_HOST,
        listeners: [{ port: 0, role: 'smtp', homePort: BLACKHOLE_PORT }],
        maxPerIp: 20,
        connectTimeoutMs: 5000, // long enough that it never fires during this test
      }),
    );
    const activeForwarder = forwarder;
    const listenPort = activeForwarder.ports()[0]?.port;
    expect(listenPort).toBeDefined();
    if (listenPort === undefined) return;

    const clients: Socket[] = [];
    for (let i = 0; i < 20; i += 1) {
      clients.push(await connectClient(listenPort));
    }
    // All 20 slots should be occupied — the home connect is stalled, so none has resolved yet.
    await waitUntil(() => activeForwarder.stats().total === 20);
    expect(activeForwarder.stats().perIp.get('127.0.0.1')).toBe(20);

    for (const client of clients) client.destroy();

    // The slots must come back even though home never connected or errored.
    await waitUntil(() => activeForwarder.stats().total === 0);
    expect(activeForwarder.stats().perIp.size).toBe(0);

    // A 21st connection must be accepted, not refused — proving the cap was not permanently hit.
    const next = await connectClient(listenPort);
    await waitUntil(() => activeForwarder.stats().total === 1);

    let sawData = false;
    next.on('data', () => {
      sawData = true;
    });
    await sleep(200);
    expect(sawData).toBe(false); // no 421 banner, no premature data — it was accepted, not refused

    next.destroy();
    await waitUntil(() => activeForwarder.stats().total === 0);
  });

  it('does not crash the forwarder when a client RSTs during the home-connect window (PST-T-0.13 refutation 2)', async () => {
    let uncaught: unknown;
    function onUncaught(err: unknown): void {
      uncaught = err;
    }
    process.once('uncaughtException', onUncaught);

    try {
      forwarder = await startForwarder(
        baseConfig({
          homeHost: BLACKHOLE_HOST,
          listeners: [{ port: 0, role: 'smtp', homePort: BLACKHOLE_PORT }],
          connectTimeoutMs: 300,
        }),
      );
      const listenPort = forwarder.ports()[0]?.port;
      expect(listenPort).toBeDefined();
      if (listenPort === undefined) return;

      const client1 = await connectClient(listenPort);
      client1.resetAndDestroy();

      // Give any unhandled 'error' a chance to surface as an uncaught exception before we move on.
      await sleep(50);
      expect(uncaught).toBeUndefined();

      // The forwarder process must still be alive and answering: a second client on the same
      // (still black-holed) listener gets the home-unreachable 421 once connectTimeoutMs fires.
      const client2 = await connectClient(listenPort);
      const line = await readLine(client2, 2000);
      expect(line.startsWith('421')).toBe(true);
      expect(uncaught).toBeUndefined();
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('returns the per-IP count to zero after both a forwarded close and a home refusal (stats())', async () => {
    // Scenario 1: a normal forwarded connection that closes cleanly.
    const forwarded = await startForwarder(baseConfig());
    try {
      const listenPort = forwarded.ports()[0]?.port;
      expect(listenPort).toBeDefined();
      if (listenPort === undefined) return;
      const client = await connectClient(listenPort);
      await readLine(client);
      expect(forwarded.stats().total).toBe(1);
      client.destroy();
      await waitUntil(() => forwarded.stats().total === 0);
      expect(forwarded.stats().perIp.size).toBe(0);
    } finally {
      await forwarded.close();
    }

    // Scenario 2: a connection refused with 421 because home is unreachable.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => {
          resolve(address.port);
        });
      });
    });
    const unreachable = await startForwarder(
      baseConfig({ listeners: [{ port: 0, role: 'smtp', homePort: deadPort }], connectTimeoutMs: 300 }),
    );
    try {
      const listenPort = unreachable.ports()[0]?.port;
      expect(listenPort).toBeDefined();
      if (listenPort === undefined) return;
      const client = await connectClient(listenPort);
      const line = await readLine(client);
      expect(line.startsWith('421')).toBe(true);
      await waitUntil(() => unreachable.stats().total === 0);
      expect(unreachable.stats().perIp.size).toBe(0);
    } finally {
      await unreachable.close();
    }
  });
});
