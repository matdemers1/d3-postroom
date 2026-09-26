// A hand-rolled SNTP client (RFC 4330) over UDP 123: a 48-byte client request, the server's
// receive/transmit timestamps in the 48-byte reply, and the standard four-timestamp offset
// calculation. No NTP library — this is a health check, but the project's own convention (protocols
// are written here) applies just as well to the one UDP round trip this needs.
//
// The reply is validated before it is trusted (PST-REQ-100): mode must be 4 (server), stratum must
// be 1-15 (0 is a kiss-of-death — a distinct, explanatory failure, not a generic parse error), the
// version must be one we understand, and the reply's Originate Timestamp must echo exactly the
// Transmit Timestamp we sent — otherwise it is not an answer to *this* query (a stale reply to an
// earlier one, or a forgery) and is rejected rather than used. `socket.connect()` additionally makes
// the OS itself drop any datagram not from the connected server's address and port, so a spoofed
// source never reaches the 'message' handler at all.
import dgram from 'node:dgram';

const NTP_EPOCH_OFFSET_S = 2_208_988_800; // seconds between 1900-01-01 (NTP epoch) and 1970-01-01 (Unix epoch)
const TWO_POW_32 = 2 ** 32;
const PACKET_SIZE = 48;
const MODE_SERVER = 4;
const SUPPORTED_VERSIONS = new Set([3, 4]);

function toNtpTimestamp(msSinceUnixEpoch: number): { seconds: number; fraction: number } {
  const totalSeconds = msSinceUnixEpoch / 1000 + NTP_EPOCH_OFFSET_S;
  const seconds = Math.floor(totalSeconds);
  const fraction = Math.round((totalSeconds - seconds) * TWO_POW_32);
  return { seconds, fraction };
}

function fromNtpTimestamp(seconds: number, fraction: number): number {
  return (seconds - NTP_EPOCH_OFFSET_S) * 1000 + (fraction / TWO_POW_32) * 1000;
}

interface Request {
  readonly packet: Buffer;
  readonly transmitSeconds: number;
  readonly transmitFraction: number;
}

function buildRequest(originateMs: number): Request {
  const packet = Buffer.alloc(PACKET_SIZE);
  // LI = 0 (no warning), VN = 4, Mode = 3 (client).
  packet[0] = 0b00_100_011;
  const { seconds, fraction } = toNtpTimestamp(originateMs);
  // Transmit timestamp (offset 40): what a conformant server echoes back as the reply's Originate
  // Timestamp (offset 24), proving the reply answers this request and not some earlier one.
  packet.writeUInt32BE(seconds, 40);
  packet.writeUInt32BE(fraction, 44);
  return { packet, transmitSeconds: seconds, transmitFraction: fraction };
}

/** Thrown when the server flags a problem with the query itself (RFC 4330 kiss-of-death, stratum 0):
 * the four-character kiss code (e.g. "RATE", "DENY") is in the reply's Reference Identifier field. */
export class SntpKissOfDeathError extends Error {
  readonly code: string;
  constructor(server: string, code: string) {
    super(`ntp server ${server} sent a kiss-of-death (${code})`);
    this.name = 'SntpKissOfDeathError';
    this.code = code;
  }
}

function validateReply(msg: Buffer, request: Request, server: string): void {
  if (msg.length < PACKET_SIZE) {
    throw new Error(`ntp response from ${server} was ${String(msg.length)} bytes, expected at least ${String(PACKET_SIZE)}`);
  }
  const firstByte = msg[0] ?? 0;
  const version = (firstByte >> 3) & 0b111;
  const mode = firstByte & 0b111;
  const stratum = msg[1] ?? 0;

  if (stratum === 0) {
    // Reference Identifier (offset 12-15) carries the four-character kiss code when stratum is 0.
    const code = msg.subarray(12, 16).toString('ascii').replace(/\0+$/, '') || 'unknown';
    throw new SntpKissOfDeathError(server, code);
  }
  if (stratum > 15) {
    throw new Error(`ntp response from ${server} reports stratum ${String(stratum)}, outside the valid 1-15 range`);
  }
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`ntp response from ${server} used unsupported NTP version ${String(version)}`);
  }
  if (mode !== MODE_SERVER) {
    throw new Error(`ntp response from ${server} had mode ${String(mode)}, expected ${String(MODE_SERVER)} (server)`);
  }
  const originateSeconds = msg.readUInt32BE(24);
  const originateFraction = msg.readUInt32BE(28);
  if (originateSeconds !== request.transmitSeconds || originateFraction !== request.transmitFraction) {
    throw new Error(`ntp response from ${server} echoed a different Originate Timestamp than this query sent — not an answer to this request`);
  }
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

/** One SNTP round trip: the standard offset = ((T2 - T1) + (T3 - T4)) / 2, after validating the
 * reply actually answers this request and comes from the server this query was sent to. */
export function querySntp(opts: SntpQueryOptions): Promise<SntpResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clockMs = opts.clockMs ?? ((): number => Date.now());
  const createSocket = opts.createSocket ?? ((): dgram.Socket => dgram.createSocket('udp4'));

  return new Promise((resolve, reject) => {
    const socket = createSocket();
    const t1 = clockMs();
    const request = buildRequest(t1);
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
        try {
          validateReply(msg, request, opts.host);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const t2 = fromNtpTimestamp(msg.readUInt32BE(32), msg.readUInt32BE(36));
        const t3 = fromNtpTimestamp(msg.readUInt32BE(40), msg.readUInt32BE(44));
        const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
        resolve({ offsetMs, server: opts.host });
      });
    });

    // A connected UDP socket only ever delivers datagrams from the address/port it is connected
    // to — the OS itself discards anything else, so a spoofed source never reaches 'message' above.
    // connect()'s callback (mirroring the 'connect' event) takes no error argument; a connection
    // failure surfaces on the 'error' listener above instead.
    socket.connect(port, opts.host, () => {
      socket.send(request.packet, (sendError) => {
        if (sendError) {
          finish(() => {
            reject(sendError);
          });
        }
      });
    });
  });
}
