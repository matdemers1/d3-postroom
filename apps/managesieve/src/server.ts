// The ManageSieve listener on 4190 (RFC 5804: plaintext with STARTTLS; there is no implicit-TLS port).
//
//   PST-REQ-016  PROXY v2 is accepted only from the edge's WireGuard peer, and required from it; a
//                PROXY header from anyone else closes the connection.
//   PST-REQ-027  credentials are checked by verifyProtocolLogin with scope 'sieve' — app passwords
//                only; the account password is never consulted.
//   PST-REQ-075  every check goes through the shared, audit-backed throttle (protocol 'managesieve').
//
// Without a certificate there is no STARTTLS, so nothing can authenticate: fail closed.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSecureContext, type SecureContext } from 'node:tls';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import { verifyProtocolLogin } from '@postroom/credentials';
import type { Db } from '@postroom/db';
import { isTrustedProxyPeer, readProxyHeader } from '@postroom/proxy-protocol';
import { SocketDuplex } from './io.js';
import { status } from './protocol.js';
import { ManageSieveSession, type Authenticator, type Log } from './session.js';

export interface ManageSieveServerOptions {
  readonly db: Db;
  /** PASSWORD_PEPPER; without it every login is refused as temporarily unavailable. */
  readonly pepper: string | undefined;
  readonly tls: { readonly key: Buffer | string; readonly cert: Buffer | string } | null;
  readonly edgePeers: readonly string[];
  readonly proxyTimeoutMs?: number;
  readonly maxConnectionsPerIp?: number;
  readonly preauthTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly throttle?: AuthThrottle;
  readonly log?: Log;
}

export interface ManageSieveServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
  activeSessions(): number;
}

export const THROTTLE_PROTOCOL = 'managesieve';

/** A PROXY v2 or v1 header at the start of a stream from someone who is not the edge. */
export function looksLikeProxyHeader(chunk: Buffer): boolean {
  const v2 = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00]);
  if (chunk.length >= v2.length && chunk.subarray(0, v2.length).equals(v2)) return true;
  return chunk.length >= 6 && chunk.subarray(0, 6).toString('latin1') === 'PROXY ';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "::ffff:1.2.3.4" → "1.2.3.4". */
function canonicalIp(ip: string): string {
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

export function manageSieveAuthenticator(db: Db, pepper: string | undefined, throttle: AuthThrottle): Authenticator {
  return async (username, password, ip, signal) => {
    const attempt = { protocol: THROTTLE_PROTOCOL, username, ip };
    // The tarpit runs before the credentials are looked at (PST-REQ-075).
    const gate = await throttle.before(attempt, signal);
    if (gate.outcome === 'aborted') return { ok: false, kind: 'aborted' };
    if (gate.outcome === 'refuse') return { ok: false, kind: 'locked' };
    if (username === '' || password === '') {
      await throttle.failure(attempt, 'malformed');
      return { ok: false, kind: 'failed' };
    }
    if (pepper === undefined) return { ok: false, kind: 'unavailable' };
    const result = await verifyProtocolLogin(db, { username, password, scope: 'sieve', ip }, { pepper });
    if (!result.ok) {
      await throttle.failure(attempt, result.reason);
      return { ok: false, kind: 'failed' };
    }
    await throttle.success(attempt);
    return { ok: true, accountId: result.accountId };
  };
}

export function createManageSieveServer(o: ManageSieveServerOptions): ManageSieveServer {
  const log: Log = o.log ?? (() => undefined);
  const authenticate = manageSieveAuthenticator(o.db, o.pepper, o.throttle ?? createAuthThrottle({ db: o.db }));
  const secureContext: SecureContext | null = o.tls === null ? null : createSecureContext({ key: o.tls.key, cert: o.tls.cert, minVersion: 'TLSv1.2' });
  const maxPerIp = o.maxConnectionsPerIp ?? 10;
  const perIp = new Map<string, number>();
  const sessions = new Set<ManageSieveSession>();
  const sockets = new Set<Socket>();

  async function handle(socket: Socket): Promise<void> {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', (err) => {
      log('socket-error', { error: err.message });
    });
    const peer = socket.remoteAddress ?? '';
    let clientIp = canonicalIp(peer);
    let stream: Duplex = socket;
    let via: 'proxy' | 'direct' = 'direct';

    if (isTrustedProxyPeer(peer, o.edgePeers)) {
      try {
        const { header, rest } = await readProxyHeader(socket, { timeoutMs: o.proxyTimeoutMs ?? 5_000, maxBytes: 4096 });
        if (header.command !== 'PROXY' || header.source === undefined) {
          log('proxy-refused', { peer, reason: `PROXY ${header.command} without a source address` });
          socket.destroy();
          return;
        }
        clientIp = canonicalIp(header.source.address);
        via = 'proxy';
        if (rest.length > 0) socket.unshift(rest);
        // STARTTLS must see bytes already read past the header; the adapter reads through the stream.
        stream = new SocketDuplex(socket);
      } catch (err) {
        log('proxy-refused', { peer, reason: errorText(err) });
        socket.destroy();
        return;
      }
    } else {
      refuseStrayProxyHeader(socket, () => {
        log('proxy-refused', { peer, reason: 'PROXY header from a peer that is not the edge' });
      });
    }

    const open = perIp.get(clientIp) ?? 0;
    if (open >= maxPerIp) {
      log('connection-refused', { clientIp, via, reason: 'per-IP connection limit', open });
      stream.end(status('BYE', 'Too many connections from your address', 'TRYLATER'));
      return;
    }
    perIp.set(clientIp, open + 1);
    socket.once('close', () => {
      const n = (perIp.get(clientIp) ?? 1) - 1;
      if (n <= 0) perIp.delete(clientIp);
      else perIp.set(clientIp, n);
    });

    const session = new ManageSieveSession(stream, false, clientIp, {
      db: o.db,
      authenticate,
      secureContext,
      log,
      ...(o.preauthTimeoutMs === undefined ? {} : { preauthTimeoutMs: o.preauthTimeoutMs }),
      ...(o.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: o.idleTimeoutMs }),
    });
    sessions.add(session);
    await session.done;
    sessions.delete(session);
  }

  const server = createServer((socket) => {
    handle(socket).catch((err: unknown) => {
      log('connection-error', { error: errorText(err) });
      socket.destroy();
    });
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: async () => {
      const closing = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
      await Promise.all([...sessions].map((s) => s.shutdown()));
      for (const s of sockets) s.destroy();
      await closing;
    },
    activeSessions: () => sessions.size,
  };
}

/**
 * Close a non-peer connection whose first bytes are a PROXY header (PST-REQ-016). The listener is
 * prepended, so it sees the first chunk before the session does, and puts it back untouched when
 * it is not a PROXY header.
 */
function refuseStrayProxyHeader(socket: Socket, onRefused: () => void): void {
  const inspect = (): void => {
    const chunk = socket.read() as Buffer | null;
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
