// PST-REQ-100: the hand-rolled SNTP client against a fake UDP server on loopback — a well-formed,
// deliberately skewed reply reports the skew; a malformed, kiss-of-death, or wrong-origin reply is
// rejected rather than trusted (PST-T-4.7).
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { querySntp, SntpKissOfDeathError } from '../../../src/monitors/sntp.js';

const NTP_EPOCH_OFFSET_S = 2_208_988_800;

function toNtp(msSinceUnixEpoch: number): { seconds: number; fraction: number } {
  const totalSeconds = msSinceUnixEpoch / 1000 + NTP_EPOCH_OFFSET_S;
  const seconds = Math.floor(totalSeconds);
  const fraction = Math.round((totalSeconds - seconds) * 2 ** 32);
  return { seconds, fraction };
}

type ReplyBuilder = (request: Buffer) => Buffer;

/** Echoes the client's own Transmit Timestamp (offset 40) into the reply's Originate Timestamp
 * (offset 24) — a conformant server's behaviour, and what proves a reply answers *this* request. */
function goodReply(skewMs: number): ReplyBuilder {
  return (request: Buffer): Buffer => {
    const now = Date.now() + skewMs;
    const reply = Buffer.alloc(48);
    reply[0] = 0b00_100_100; // LI=0, VN=4, Mode=4 (server)
    reply[1] = 2; // stratum 2: a valid secondary reference
    request.copy(reply, 24, 40, 48); // client's Transmit Timestamp -> reply's Originate Timestamp
    const { seconds, fraction } = toNtp(now);
    reply.writeUInt32BE(seconds, 32); // receive timestamp
    reply.writeUInt32BE(fraction, 36);
    reply.writeUInt32BE(seconds, 40); // transmit timestamp
    reply.writeUInt32BE(fraction, 44);
    return reply;
  };
}

function startFakeSntpServer(build: ReplyBuilder): Promise<{ port: number; close: () => Promise<void> }> {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    server.send(build(msg), rinfo.port, rinfo.address);
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
    const fake = await startFakeSntpServer(goodReply(5_000));
    close = fake.close;
    const result = await querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 });
    expect(result.offsetMs).toBeGreaterThan(4_500);
    expect(result.offsetMs).toBeLessThan(5_500);
  });

  it('reports close to zero offset from an unskewed server', async () => {
    const fake = await startFakeSntpServer(goodReply(0));
    close = fake.close;
    const result = await querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 });
    expect(Math.abs(result.offsetMs)).toBeLessThan(500);
  });

  it('rejects when nothing answers (a timeout, or an immediate ECONNREFUSED on a closed port)', async () => {
    // A connected UDP socket surfaces ICMP port-unreachable as an 'error' event; an unreachable
    // host would instead time out. Either way, the query rejects rather than hanging or resolving.
    await expect(querySntp({ host: '127.0.0.1', port: 1, timeoutMs: 200 })).rejects.toThrow(/timed out|ECONNREFUSED/);
  });

  it('rejects a reply shorter than the 48-byte packet', async () => {
    const fake = await startFakeSntpServer(() => Buffer.alloc(10));
    close = fake.close;
    await expect(querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 })).rejects.toThrow(/10 bytes, expected at least 48/);
  });

  it('rejects a client-mode (not server) reply', async () => {
    const fake = await startFakeSntpServer((request) => {
      const reply = goodReply(0)(request);
      reply[0] = 0b00_100_011; // Mode=3 (client) — never a valid reply
      return reply;
    });
    close = fake.close;
    await expect(querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 })).rejects.toThrow(/mode 3, expected 4/);
  });

  it('rejects stratum 16 (outside the valid 1-15 range)', async () => {
    const fake = await startFakeSntpServer((request) => {
      const reply = goodReply(0)(request);
      reply[1] = 16;
      return reply;
    });
    close = fake.close;
    await expect(querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 })).rejects.toThrow(/stratum 16/);
  });

  it('treats stratum 0 as a kiss-of-death, surfacing the four-character code', async () => {
    const fake = await startFakeSntpServer((request) => {
      const reply = goodReply(0)(request);
      reply[1] = 0;
      reply.write('RATE', 12, 'ascii');
      return reply;
    });
    close = fake.close;
    const rejection = querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 });
    await expect(rejection).rejects.toBeInstanceOf(SntpKissOfDeathError);
    await expect(rejection).rejects.toMatchObject({ code: 'RATE' });
  });

  it('rejects a reply whose Originate Timestamp does not echo this request (a stale or forged reply)', async () => {
    const fake = await startFakeSntpServer((request) => {
      const reply = goodReply(0)(request);
      reply.writeUInt32BE(reply.readUInt32BE(24) + 1, 24); // corrupt the echoed timestamp by 1s
      return reply;
    });
    close = fake.close;
    await expect(querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 })).rejects.toThrow(/echoed a different Originate Timestamp/);
  });

  it('rejects an unsupported NTP version', async () => {
    const fake = await startFakeSntpServer((request) => {
      const reply = goodReply(0)(request);
      reply[0] = 0b00_001_100; // VN=1, Mode=4
      return reply;
    });
    close = fake.close;
    await expect(querySntp({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000 })).rejects.toThrow(/unsupported NTP version 1/);
  });

  it('never delivers a datagram from a source other than the connected server (the mechanism querySntp relies on)', async () => {
    // querySntp connects its client socket to the one server it queried; a connected UDP socket
    // only ever fires 'message' for datagrams from that exact address/port — proven directly here,
    // independent of querySntp's own reply validation.
    const target = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => {
      target.bind(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const targetAddress = target.address();
    const targetPort = typeof targetAddress === 'string' ? 0 : targetAddress.port;

    const client = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => {
      client.connect(targetPort, '127.0.0.1', () => {
        resolve();
      });
    });

    const impostor = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => {
      impostor.bind(0, '127.0.0.1', () => {
        resolve();
      });
    });

    const clientAddress = client.address();
    const clientPort = typeof clientAddress === 'string' ? 0 : clientAddress.port;

    const received = new Promise<string>((resolve) => {
      client.once('message', (msg) => {
        resolve(msg.toString());
      });
    });

    impostor.send(Buffer.from('spoofed'), clientPort, '127.0.0.1', () => {
      // Sent from a port the client never connected to — must never arrive.
      target.send(Buffer.from('genuine'), clientPort, '127.0.0.1');
    });

    await expect(received).resolves.toBe('genuine');

    target.close();
    client.close();
    impostor.close();
  });
});
