// UDP-first transport with OS-assigned source ports (bind 0 per query) and a 2-byte-length-prefixed
// TCP fallback for truncated (TC=1) responses, per RFC 1035 §4.2.
import { createSocket } from 'node:dgram';
import { Socket as NetSocket } from 'node:net';
import { DnsProtocolError, DnsTimeoutError } from './errors.js';

/** Send `packet` over UDP and wait for a response whose id matches `expectedId`. Any datagram
 * with a different (or unreadable) id is a stray or spoofed reply and is silently ignored while
 * the timeout keeps running — this is the transport-layer half of the anti-spoofing defense. */
export function sendUdp(host: string, port: number, packet: Uint8Array, expectedId: number, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new DnsTimeoutError(`UDP query to ${host}:${String(port)} timed out after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    socket.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });

    socket.on('message', (msg: Buffer) => {
      if (msg.length < 2) return; // too short to carry an id; keep waiting
      const id = msg.readUInt16BE(0);
      if (id !== expectedId) return; // stray or spoofed reply; keep waiting for the real one
      finish(() => {
        resolve(msg);
      });
    });

    // connect() binds an ephemeral port AND makes the kernel drop datagrams from any address but
    // the resolver's, so an off-path spoofer must forge the source address as well as guess the
    // port and the 16-bit id.
    socket.connect(port, host, () => {
      socket.send(packet, (err) => {
        if (err) {
          finish(() => {
            reject(err);
          });
        }
      });
    });
  });
}

/** Send `packet` over TCP with a 2-byte big-endian length prefix and read exactly that many
 * response bytes back, per RFC 1035 §4.2.2. Used as the TC=1 fallback. */
export function sendTcp(host: string, port: number, packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = new NetSocket();
    let settled = false;
    let buffered = Buffer.alloc(0);
    let expectedLength: number | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs, () => {
      finish(() => {
        reject(new DnsTimeoutError(`TCP query to ${host}:${String(port)} timed out after ${String(timeoutMs)}ms`));
      });
    });

    socket.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });

    socket.on('close', () => {
      finish(() => {
        reject(new DnsProtocolError('TCP connection closed before the full response arrived'));
      });
    });

    socket.connect(port, host, () => {
      const lengthPrefix = Buffer.alloc(2);
      lengthPrefix.writeUInt16BE(packet.length, 0);
      socket.write(Buffer.concat([lengthPrefix, Buffer.from(packet)]));
    });

    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (expectedLength === null && buffered.length >= 2) {
        expectedLength = buffered.readUInt16BE(0);
        buffered = buffered.subarray(2);
      }
      if (expectedLength !== null && buffered.length >= expectedLength) {
        finish(() => {
          resolve(buffered.subarray(0, expectedLength ?? 0));
        });
      }
    });
  });
}
