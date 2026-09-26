// PST-REQ-100: the hand-rolled SNTP client against a fake UDP server on loopback that answers with
// a deliberately skewed clock, proving the offset calculation surfaces that skew.
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { querySntp } from '../../../src/monitors/sntp.js';

const NTP_EPOCH_OFFSET_S = 2_208_988_800;

function toNtp(msSinceUnixEpoch: number): { seconds: number; fraction: number } {
  const totalSeconds = msSinceUnixEpoch / 1000 + NTP_EPOCH_OFFSET_S;
  const seconds = Math.floor(totalSeconds);
  const fraction = Math.round((totalSeconds - seconds) * 2 ** 32);
  return { seconds, fraction };
}

/** A fake SNTP server that always answers as if its clock were `skewMs` ahead of real time. */
function startFakeSntpServer(skewMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = dgram.createSocket('udp4');
  server.on('message', (_msg, rinfo) => {
    const now = Date.now() + skewMs;
    const reply = Buffer.alloc(48);
    reply[0] = 0b00_100_100; // LI=0, VN=4, Mode=4 (server)
    const { seconds, fraction } = toNtp(now);
    reply.writeUInt32BE(seconds, 32); // receive timestamp
    reply.writeUInt32BE(fraction, 36);
    reply.writeUInt32BE(seconds, 40); // transmit timestamp
    reply.writeUInt32BE(fraction, 44);
    server.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'string' ? 0 : address.port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}

describe('querySntp', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('reports a large offset from a server whose clock is skewed 5s ahead', async () => {
    const fake = await startFakeSntpServer(5_000);
    close = fake.close;
    const result = await querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 });
    expect(result.offsetMs).toBeGreaterThan(4_500);
    expect(result.offsetMs).toBeLessThan(5_500);
  });

  it('reports close to zero offset from an unskewed server', async () => {
    const fake = await startFakeSntpServer(0);
    close = fake.close;
    const result = await querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 });
    expect(Math.abs(result.offsetMs)).toBeLessThan(500);
  });

  it('rejects on timeout when nothing answers', async () => {
    await expect(querySntp({ host: '127.0.0.1', port: 1, timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
