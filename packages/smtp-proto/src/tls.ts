// The server-side STARTTLS upgrade, as a ready-made `ServerHooks.upgradeTls` (RFC 3207).
//
// The daemon owns the certificate; this only wraps the socket and waits for the handshake. The
// session engine has already discarded every plaintext byte buffered after STARTTLS before it calls
// this (PST-REQ-029); anything arriving later is fed to the TLS layer, where it is not a handshake.

import { TLSSocket, type SecureContextOptions, type TlsOptions } from 'node:tls';
import type { Duplex } from 'node:stream';

export interface TlsUpgraderOptions extends SecureContextOptions {
  /** Handshake deadline in ms. Default 30 s. */
  readonly handshakeTimeoutMs?: number;
  readonly minVersion?: TlsOptions['minVersion'];
}

export function tlsUpgrader(options: TlsUpgraderOptions): (socket: Duplex) => Promise<TLSSocket> {
  const { handshakeTimeoutMs = 30_000, ...tlsOptions } = options;
  return (socket) =>
    new Promise<TLSSocket>((resolve, reject) => {
      const secure = new TLSSocket(socket, { minVersion: 'TLSv1.2', ...tlsOptions, isServer: true });
      const timer = setTimeout(() => {
        fail(new Error('TLS handshake timed out'));
      }, handshakeTimeoutMs);
      const onError = (err: Error): void => {
        fail(err);
      };
      const onClose = (): void => {
        fail(new Error('connection closed during TLS handshake'));
      };
      const fail = (err: Error): void => {
        clearTimeout(timer);
        secure.off('secure', onSecure);
        secure.off('close', onClose);
        secure.destroy();
        reject(err);
      };
      const onSecure = (): void => {
        clearTimeout(timer);
        secure.off('error', onError);
        secure.off('close', onClose);
        resolve(secure);
      };
      secure.once('secure', onSecure);
      secure.once('error', onError);
      secure.once('close', onClose);
    });
}
