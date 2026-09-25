// A loopback-only fake DNS server for integration tests: answers from a fixture table keyed by
// "name|type", exercising real UDP + TCP sockets against the production transport and wire code.
import { createSocket } from 'node:dgram';
import { createServer, type Server, type Socket as NetSocket } from 'node:net';
import { encodeName } from '../../../src/name.js';
import { DNS_CLASS_IN } from '../../../src/types.js';
import { decodeMessage } from '../../../src/wire.js';
import type { DecodeResult } from '../../../src/types.js';

export interface FakeAnswerSpec {
  /** Raw response packet bytes to send back, minus the id (patched in on the fly). */
  buildResponse: (query: DecodeResult) => Buffer;
  /** When true, the UDP response is truncated (TC=1) so the client must retry over TCP. */
  truncateOnUdp?: boolean;
  /** When true, drop the query entirely (used for timeout/retry tests). */
  dropRequests?: number;
}

export interface FakeDnsServer {
  /** UDP and TCP are bound to the same port number, as a real DNS server would be. */
  port: number;
  close: () => Promise<void>;
  requestCount: () => number;
}

function fixtureKey(name: string, type: number): string {
  return `${name.toLowerCase().replace(/\.$/, '')}|${String(type)}`;
}

export async function startFakeDnsServer(fixtures: Map<string, FakeAnswerSpec>): Promise<FakeDnsServer> {
  let requestCount = 0;
  const dropCounters = new Map<string, number>();

  function respondFor(query: DecodeResult): Buffer | null {
    if (!query.ok) return null;
    const question = query.message.questions[0];
    if (!question) return null;
    const key = fixtureKey(question.name, question.type);
    const spec = fixtures.get(key);
    if (!spec) return null;
    if (spec.dropRequests) {
      const dropped = dropCounters.get(key) ?? 0;
      if (dropped < spec.dropRequests) {
        dropCounters.set(key, dropped + 1);
        return null;
      }
    }
    return spec.buildResponse(query);
  }

  const udpSocket = createSocket('udp4');
  udpSocket.on('message', (msg: Buffer, rinfo) => {
    requestCount += 1;
    const decoded = decodeMessage(msg);
    const spec = decoded.ok ? fixtures.get(fixtureKey(decoded.message.questions[0]?.name ?? '', decoded.message.questions[0]?.type ?? -1)) : undefined;
    const response = respondFor(decoded);
    if (!response) return; // simulate a dropped/timed-out request
    if (spec?.truncateOnUdp && decoded.ok) {
      // A minimal, honestly-truncated response: header (TC=1, all section counts zeroed) plus the
      // echoed question, and nothing else — the client must fall back to TCP to get real data.
      const header = Buffer.alloc(12);
      header.writeUInt16BE(decoded.message.id, 0);
      header.writeUInt16BE((1 << 15) | (1 << 9) | (1 << 8), 2); // QR=1, TC=1, RD=1
      header.writeUInt16BE(1, 4); // QDCOUNT
      header.writeUInt16BE(0, 6);
      header.writeUInt16BE(0, 8);
      header.writeUInt16BE(0, 10);
      const question = decoded.message.questions[0];
      const questionBytes = question
        ? Buffer.concat([
            Buffer.from(encodeName(question.name)),
            (() => {
              const tail = Buffer.alloc(4);
              tail.writeUInt16BE(question.type, 0);
              tail.writeUInt16BE(DNS_CLASS_IN, 2);
              return tail;
            })(),
          ])
        : Buffer.alloc(0);
      udpSocket.send(Buffer.concat([header, questionBytes]), rinfo.port, rinfo.address);
      return;
    }
    udpSocket.send(response, rinfo.port, rinfo.address);
  });

  const tcpServer: Server = createServer((socket: NetSocket) => {
    let buffered = Buffer.alloc(0);
    let expectedLength: number | null = null;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (expectedLength === null && buffered.length >= 2) {
        expectedLength = buffered.readUInt16BE(0);
        buffered = buffered.subarray(2);
      }
      if (expectedLength !== null && buffered.length >= expectedLength) {
        const queryBytes = buffered.subarray(0, expectedLength);
        requestCount += 1;
        const decoded = decodeMessage(queryBytes);
        const response = respondFor(decoded);
        if (response) {
          const lengthPrefix = Buffer.alloc(2);
          lengthPrefix.writeUInt16BE(response.length, 0);
          socket.write(Buffer.concat([lengthPrefix, response]));
        }
        socket.end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    udpSocket.bind(0, '127.0.0.1', resolve);
  });
  const udpAddress = udpSocket.address();
  if (typeof udpAddress !== 'object') {
    throw new Error('failed to bind fake DNS server UDP socket');
  }
  const port = udpAddress.port;

  await new Promise<void>((resolve) => {
    tcpServer.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    requestCount: () => requestCount,
    close: async () => {
      await new Promise<void>((resolve) => {
        udpSocket.close(() => {
          resolve();
        });
      });
      await new Promise<void>((resolve) => {
        tcpServer.close(() => {
          resolve();
        });
      });
    },
  };
}
