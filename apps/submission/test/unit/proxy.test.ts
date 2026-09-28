// PST-T-4.17 / PST-REQ-016 without a database: the EDGE_PEER_ADDRESS / PROXY_TIMEOUT_MS defaults, the
// stray-header test, and 587 behind the edge up to EHLO (nothing here reaches the database).
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Db } from '@postroom/db';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { looksLikeProxyHeader, proxyConfigFromEnv } from '../../src/proxy.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { SmtpTestClient } from '../integration/client.js';

const header = (source: string): Buffer =>
  encodeProxyV2({ command: 'PROXY', family: 'TCP4', source: { address: source, port: 40_000 }, destination: { address: '10.77.0.2', port: 587 } });

describe('PROXY configuration', () => {
  it('defaults to the edge peer 10.77.0.1 and a 5 s header timeout, and reads a comma list', () => {
    expect(proxyConfigFromEnv({})).toEqual({ edgePeers: ['10.77.0.1'], proxyTimeoutMs: 5_000 });
    expect(proxyConfigFromEnv({ EDGE_PEER_ADDRESS: '10.0.0.1, 10.0.0.2,', PROXY_TIMEOUT_MS: '750' })).toEqual({
      edgePeers: ['10.0.0.1', '10.0.0.2'],
      proxyTimeoutMs: 750,
    });
  });

  it('recognises v2 and v1 headers, and nothing else', () => {
    expect(looksLikeProxyHeader(header('198.51.100.1'))).toBe(true);
    expect(looksLikeProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n'))).toBe(true);
    expect(looksLikeProxyHeader(Buffer.from('EHLO client.test\r\n'))).toBe(false);
    expect(looksLikeProxyHeader(Buffer.from('\r\n'))).toBe(false);
  });
});

describe('587 behind the edge, no database', () => {
  let edge: SubmissionListeners;
  let direct: SubmissionListeners;
  let edgePort = 0;
  let directPort = 0;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    const base = {
      db: {} as Db,
      hostname: 'mail.d3cloud.io',
      maxSize: 1024,
      maxRecipients: 10,
      pepper: 'pepper',
      storage: () => {
        throw new Error('storage must not be reached');
      },
      tls: null,
      log: (event: string, fields: Record<string, unknown> = {}) => logs.push({ event, fields }),
    };
    edge = createSubmissionListeners({ ...base, edgePeers: ['127.0.0.1'], proxyTimeoutMs: 200 });
    direct = createSubmissionListeners(base);
    for (const [l, set] of [
      [edge, (p: number) => (edgePort = p)],
      [direct, (p: number) => (directPort = p)],
    ] as const) {
      l.submission.listen(0, '127.0.0.1');
      await once(l.submission, 'listening');
      set((l.submission.address() as AddressInfo).port);
    }
  });

  afterAll(async () => {
    await edge.close();
    await direct.close();
  });

  it('serves the session after a PROXY v2 header, logging the source as the client', async () => {
    const c = await SmtpTestClient.plain(edgePort, header('198.51.100.7'));
    expect((await c.next()).code).toBe(220);
    expect((await c.send('EHLO client.test')).code).toBe(250);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();
    expect(logs).toContainEqual({ event: 'connection', fields: { clientIp: '198.51.100.7', via: 'proxy', port: 'submission' } });
  });

  it('closes an edge connection that sends no header in time, without a greeting', async () => {
    const c = await SmtpTestClient.plain(edgePort);
    expect(await c.closedWithin(2_000)).toBe(true);
    expect(c.pending).toEqual([]);
  });

  it('closes a direct connection that opens with a PROXY header; serves one that does not', async () => {
    const stray = await SmtpTestClient.plain(directPort, header('203.0.113.9'));
    expect(await stray.closedWithin(2_000)).toBe(true);
    expect(stray.pending.every((r) => r.code === 220)).toBe(true);
    const ok = await SmtpTestClient.plain(directPort);
    expect((await ok.next()).code).toBe(220);
    expect((await ok.send('EHLO client.test')).code).toBe(250);
    ok.close();
  });
});
