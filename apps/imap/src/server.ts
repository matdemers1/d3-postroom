// The IMAP listeners: 993 with implicit TLS and 143 with STARTTLS (PST-REQ-070).
//
//   PST-REQ-016  PROXY v2 is accepted only from the edge's WireGuard peer, and required from it; a
//                PROXY header from anyone else closes the connection.
//   PST-REQ-027  credentials are checked by verifyProtocolLogin with scope 'imap' — app passwords
//                only; the account password is never consulted.
//   PST-REQ-075  every check goes through the shared, audit-backed throttle.
//
// Without a certificate there is no 993 at all (fail closed), and 143 advertises LOGINDISABLED with
// no STARTTLS, so nothing can log in.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSecureContext, type SecureContext } from 'node:tls';
import { createAuthThrottle, type AuthThrottle } from '@postroom/auth-throttle';
import type { BlobStore } from '@postroom/blobstore';
import { verifyProtocolLogin } from '@postroom/credentials';
import type { Db } from '@postroom/db';
import { untaggedStatus, writeResponse } from '@postroom/imap-proto';
import { isTrustedProxyPeer, readProxyHeader } from '@postroom/proxy-protocol';
import { CapabilityRegistry } from './capabilities.js';
import { createStructureCache, type StructureCache } from './content.js';
import { EXTENSIONS } from './extensions/index.js';
import { SocketDuplex, upgradeToTls } from './io.js';
import { ImapSession, type Authenticator, type Log } from './session.js';
import { MailStore } from './store.js';

export interface ImapServerOptions {
  readonly db: Db;
  readonly blobs: BlobStore;
  /** PASSWORD_PEPPER; without it every login is refused as temporarily unavailable. */
  readonly pepper: string | undefined;
  readonly tls: { readonly key: Buffer | string; readonly cert: Buffer | string } | null;
  readonly edgePeers: readonly string[];
  readonly proxyTimeoutMs?: number;
  readonly maxConnectionsPerIp?: number;
  readonly idleTimeoutMs?: number;
  readonly preauthTimeoutMs?: number;
  readonly maxAppendSize?: number;
  readonly structureCacheEntries?: number;
  readonly throttle?: AuthThrottle;
  readonly registry?: CapabilityRegistry;
  readonly log?: Log;
}

export interface ImapListeners {
  /** 993, implicit TLS; null without a certificate. */
  readonly imaps: Server | null;
  /** 143, STARTTLS. */
  readonly imap: Server;
  readonly store: MailStore;
  readonly structures: StructureCache;
  listen(server: Server, port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
  activeSessions(): number;
}

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

export function imapAuthenticator(db: Db, pepper: string | undefined, throttle: AuthThrottle): Authenticator {
  return async (username, password, ip, signal) => {
    const attempt = { protocol: 'imap', username, ip };
    // The tarpit runs before the credentials are looked at (PST-REQ-075).
    const gate = await throttle.before(attempt, signal);
    if (gate.outcome === 'aborted') return { ok: false, kind: 'aborted' };
    if (gate.outcome === 'refuse') return { ok: false, kind: 'locked' };
    if (username === '' || password === '') {
      await throttle.failure(attempt, 'malformed');
      return { ok: false, kind: 'failed' };
    }
    if (pepper === undefined) return { ok: false, kind: 'unavailable' };
    const result = await verifyProtocolLogin(db, { username, password, scope: 'imap', ip }, { pepper });
    if (!result.ok) {
      await throttle.failure(attempt, result.reason);
      return { ok: false, kind: 'failed' };
    }
    await throttle.success(attempt);
    return { ok: true, accountId: result.accountId };
  };
}

export function createImapListeners(o: ImapServerOptions): ImapListeners {
  const log: Log = o.log ?? (() => undefined);
  const store = new MailStore(o.db, o.blobs);
  const structures = createStructureCache(o.blobs, o.structureCacheEntries ?? 1000);
  const registry = o.registry ?? new CapabilityRegistry(EXTENSIONS);
  const authenticate = imapAuthenticator(o.db, o.pepper, o.throttle ?? createAuthThrottle({ db: o.db }));
  const secureContext: SecureContext | null = o.tls === null ? null : createSecureContext({ key: o.tls.key, cert: o.tls.cert, minVersion: 'TLSv1.2' });
  const maxPerIp = o.maxConnectionsPerIp ?? 20;
  const perIp = new Map<string, number>();
  const sessions = new Set<ImapSession>();
  const sockets = new Set<Socket>();

  const sessionOptions = {
    store,
    blobs: o.blobs,
    structures,
    authenticate,
    secureContext,
    registry,
    log,
    ...(o.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: o.idleTimeoutMs }),
    ...(o.preauthTimeoutMs === undefined ? {} : { preauthTimeoutMs: o.preauthTimeoutMs }),
    ...(o.maxAppendSize === undefined ? {} : { maxAppendSize: o.maxAppendSize }),
  };

  async function handle(socket: Socket, implicitTls: boolean): Promise<void> {
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
        // TLS must see the bytes already read past the header; the adapter reads through the stream.
        stream = new SocketDuplex(socket);
      } catch (err) {
        log('proxy-refused', { peer, reason: errorText(err) });
        socket.destroy();
        return;
      }
    } else if (!implicitTls) {
      // A stray PROXY header on the plaintext port closes the connection. (On 993 it can only fail
      // the TLS handshake, so no inspection is needed.)
      refuseStrayProxyHeader(socket, () => {
        log('proxy-refused', { peer, reason: 'PROXY header from a peer that is not the edge' });
      });
    }

    const open = perIp.get(clientIp) ?? 0;
    if (open >= maxPerIp) {
      log('connection-refused', { clientIp, via, reason: 'per-IP connection limit', open });
      if (implicitTls) {
        // No handshake is spent on a connection that is refused anyway.
        socket.destroy();
        return;
      }
      await writeResponse(untaggedStatus('BYE', 'Too many connections from your address'), stream).catch(() => undefined);
      stream.end();
      return;
    }
    perIp.set(clientIp, open + 1);
    socket.once('close', () => {
      const n = (perIp.get(clientIp) ?? 1) - 1;
      if (n <= 0) perIp.delete(clientIp);
      else perIp.set(clientIp, n);
    });

    let secure = false;
    if (implicitTls) {
      if (secureContext === null) {
        socket.destroy();
        return;
      }
      try {
        stream = await upgradeToTls(stream, secureContext);
        secure = true;
      } catch (err) {
        log('tls-error', { clientIp, via, error: errorText(err) });
        socket.destroy();
        return;
      }
    }
    const session = new ImapSession(stream, secure, clientIp, sessionOptions);
    sessions.add(session);
    await session.done;
    sessions.delete(session);
  }

  const onConnection = (implicitTls: boolean) => (socket: Socket) => {
    handle(socket, implicitTls).catch((err: unknown) => {
      log('connection-error', { error: errorText(err) });
      socket.destroy();
    });
  };

  const imap = createServer(onConnection(false));
  const imaps = secureContext === null ? null : createServer(onConnection(true));

  const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });

  return {
    imap,
    imaps,
    store,
    structures,
    listen: (server, port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: async () => {
      const closing = [closeServer(imap), ...(imaps === null ? [] : [closeServer(imaps)])];
      await Promise.all([...sessions].map((s) => s.shutdown()));
      setTimeout(() => {
        for (const s of sockets) s.destroy();
      }, 1_000).unref();
      for (const s of sockets) s.destroy();
      await Promise.all(closing);
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
