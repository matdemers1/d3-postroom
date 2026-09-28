// PROXY v2 plumbing for the submission listeners (PST-REQ-016, PST-T-4.17) — the same rule smtp-in
// and imap apply: from the edge's WireGuard peer a PROXY v2 header is required and its source is the
// client; from anyone else a stream that opens with a PROXY header is closed.
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { envInt, envString } from '@postroom/daemon';

/** EDGE_PEER_ADDRESS (comma list, default 10.77.0.1) and PROXY_TIMEOUT_MS (5000), read as smtp-in
 * and imap read them. */
export function proxyConfigFromEnv(env: NodeJS.ProcessEnv): { edgePeers: readonly string[]; proxyTimeoutMs: number } {
  const edgePeers = envString(env, 'EDGE_PEER_ADDRESS', '10.77.0.1')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return { edgePeers, proxyTimeoutMs: envInt(env, 'PROXY_TIMEOUT_MS', 5_000) };
}

/** A PROXY v2 or v1 header at the start of a stream from someone who is not the edge. */
export function looksLikeProxyHeader(chunk: Buffer): boolean {
  const v2 = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00]);
  if (chunk.length >= v2.length && chunk.subarray(0, v2.length).equals(v2)) return true;
  return chunk.length >= 6 && chunk.subarray(0, 6).toString('latin1') === 'PROXY ';
}

/** "::ffff:1.2.3.4" → "1.2.3.4". */
export function canonicalIp(ip: string): string {
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

/**
 * Close a non-peer connection whose first bytes are a PROXY header (PST-REQ-016). The listener is
 * prepended, so it sees the first chunk before the session engine does, and puts it back untouched
 * when it is not a PROXY header. Plaintext (587) only: TLS over a net.Socket reads its handle
 * directly and would never see a chunk put back, and on 465 a header can only fail the handshake.
 */
export function refuseStrayProxyHeader(socket: Socket, onRefused: () => void): void {
  // The unwrapped read, taken before the transcript tap wraps it (PST-T-6.3): a peek that is put
  // back must not be recorded, or the first line would appear twice and throw the AUTH redaction
  // one line out of step. Call this before serveSubmission attaches the tap.
  const read = socket.read.bind(socket);
  const inspect = (): void => {
    const chunk = read() as Buffer | null;
    if (chunk === null) return;
    socket.off('readable', inspect);
    if (looksLikeProxyHeader(chunk)) {
      onRefused();
      socket.destroy();
      return;
    }
    socket.unshift(chunk);
  };
  socket.prependListener('readable', inspect);
  socket.once('close', () => socket.off('readable', inspect));
}

/**
 * A plain Duplex over a socket (as in apps/imap/src/io.ts). TLS over a `net.Socket` reads from its
 * handle directly and would never see bytes already pulled into the stream — the ClientHello that
 * arrived in the same chunk as the PROXY header on 465; over this adapter it reads through the
 * stream, so nothing is lost.
 */
export class SocketDuplex extends Duplex {
  constructor(private readonly socket: Socket) {
    super();
    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      this.push(null);
    });
    socket.on('error', (err) => {
      this.destroy(err);
    });
    socket.on('close', () => {
      this.destroy();
    });
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.socket.write(chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.socket.end(cb);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.socket.destroy();
    cb(err);
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }
}
