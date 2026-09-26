// A hand-rolled SNTP client (RFC 4330) over UDP 123: a 48-byte client request, the server's
// receive/transmit timestamps in the 48-byte reply, and the standard four-timestamp offset
// calculation. No NTP library — this is a health check, but the project's own convention (protocols
// are written here) applies just as well to the one UDP round trip this needs.
import dgram from 'node:dgram';

const NTP_EPOCH_OFFSET_S = 2_208_988_800; // seconds between 1900-01-01 (NTP epoch) and 1970-01-01 (Unix epoch)
const TWO_POW_32 = 2 ** 32;
const PACKET_SIZE = 48;

function toNtpTimestamp(msSinceUnixEpoch: number): { seconds: number; fraction: number } {
  const totalSeconds = msSinceUnixEpoch / 1000 + NTP_EPOCH_OFFSET_S;
  const seconds = Math.floor(totalSeconds);
  const fraction = Math.round((totalSeconds - seconds) * TWO_POW_32);
  return { seconds, fraction };
}

function fromNtpTimestamp(seconds: number, fraction: number): number {
  return (seconds - NTP_EPOCH_OFFSET_S) * 1000 + (fraction / TWO_POW_32) * 1000;
}

function buildRequest(originateMs: number): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  // LI = 0 (no warning), VN = 4, Mode = 3 (client).
  packet[0] = 0b00_100_011;
  const { seconds, fraction } = toNtpTimestamp(originateMs);
  // Transmit timestamp (offset 40): what the server will echo back as the originate timestamp.
  packet.writeUInt32BE(seconds, 40);
  packet.writeUInt32BE(fraction, 44);
  return packet;
}

export interface SntpQueryOptions {
  readonly host: string;
  readonly port?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Wall clock, injectable so a test can pin t1/t4. */
  readonly clockMs?: (() => number) | undefined;
  /** Socket factory, injectable so a test can point at a fake server without a real bind. */
  readonly createSocket?: (() => dgram.Socket) | undefined;
}

export interface SntpResult {
  readonly offsetMs: number;
  readonly server: string;
}

const DEFAULT_PORT = 123;
const DEFAULT_TIMEOUT_MS = 5_000;

/** One SNTP round trip: the standard offset = ((T2 - T1) + (T3 - T4)) / 2. */
export function querySntp(opts: SntpQueryOptions): Promise<SntpResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clockMs = opts.clockMs ?? ((): number => Date.now());
  const createSocket = opts.createSocket ?? ((): dgram.Socket => dgram.createSocket('udp4'));

  return new Promise((resolve, reject) => {
    const socket = createSocket();
    const t1 = clockMs();
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
        reject(new Error(`ntp query to ${opts.host}:${String(port)} timed out after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    socket.once('error', (error) => {
      finish(() => {
        reject(error);
      });
    });

    socket.once('message', (msg) => {
      const t4 = clockMs();
      finish(() => {
        if (msg.length < PACKET_SIZE) {
          reject(new Error(`ntp response from ${opts.host} was ${String(msg.length)} bytes, expected at least ${String(PACKET_SIZE)}`));
          return;
        }
        const t2 = fromNtpTimestamp(msg.readUInt32BE(32), msg.readUInt32BE(36));
        const t3 = fromNtpTimestamp(msg.readUInt32BE(40), msg.readUInt32BE(44));
        const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
        resolve({ offsetMs, server: opts.host });
      });
    });

    const packet = buildRequest(t1);
    socket.send(packet, port, opts.host, (error) => {
      if (error) {
        finish(() => {
          reject(error);
        });
      }
    });
  });
}
