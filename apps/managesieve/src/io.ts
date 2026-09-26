// Socket plumbing, as the IMAP daemon has it (apps/imap/src/io.ts): a pull-based reader that STARTTLS can
// detach, an adapter so TLS can run over a socket whose first bytes (the PROXY v2 header) were already
// read, and the server-side TLS handshake.
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { TLSSocket, type SecureContext } from 'node:tls';

export class TimeoutError extends Error {
  constructor() {
    super('read timed out');
  }
}

/** Pulls chunks off a stream one at a time; `read` resolves null at end of stream. */
export class ChunkSource {
  private ended = false;
  private error: Error | null = null;
  private waiter: (() => void) | null = null;
  private readonly onReadable = (): void => {
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };
  private readonly onError = (err: Error): void => {
    this.error = err;
    this.wake();
  };

  constructor(readonly stream: Duplex) {
    stream.on('readable', this.onReadable);
    stream.on('end', this.onEnd);
    stream.on('close', this.onEnd);
    stream.on('error', this.onError);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next chunk, null at end of stream; rejects with TimeoutError after `timeoutMs` of silence. */
  async read(timeoutMs: number): Promise<Buffer | null> {
    for (;;) {
      if (this.error !== null) throw this.error;
      const chunk = this.stream.read() as Buffer | string | null;
      if (chunk !== null) return typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
      if (this.ended || this.stream.destroyed) return null;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new TimeoutError());
        }, timeoutMs);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Stop listening (before handing the underlying socket to TLS). */
  detach(): void {
    this.stream.off('readable', this.onReadable);
    this.stream.off('end', this.onEnd);
    this.stream.off('close', this.onEnd);
    this.stream.off('error', this.onError);
    this.wake();
  }
}

/**
 * A plain Duplex over a socket. TLS over a `net.Socket` reads from its handle directly and would
 * never see bytes already pulled into the stream (the ClientHello that arrived with the PROXY
 * header); over this adapter it reads through the stream, so nothing is lost.
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

/** Server-side TLS over `stream`; resolves once the handshake completes. */
export function upgradeToTls(stream: Duplex, secureContext: SecureContext, handshakeTimeoutMs = 30_000): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const secure = new TLSSocket(stream, { isServer: true, secureContext });
    const fail = (err: Error): void => {
      clearTimeout(timer);
      secure.off('secure', onSecure);
      secure.off('close', onClose);
      secure.destroy();
      reject(err);
    };
    const onError = (err: Error): void => {
      fail(err);
    };
    const onClose = (): void => {
      fail(new Error('connection closed during TLS handshake'));
    };
    const onSecure = (): void => {
      clearTimeout(timer);
      secure.off('error', onError);
      secure.off('close', onClose);
      resolve(secure);
    };
    const timer = setTimeout(() => {
      fail(new Error('TLS handshake timed out'));
    }, handshakeTimeoutMs);
    secure.once('secure', onSecure);
    secure.once('error', onError);
    secure.once('close', onClose);
  });
}
