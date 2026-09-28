// Reloadable TLS certificates for the protocol daemons (PST-REQ-020, PST-T-11.13): a certificate
// manager renews the pair on disk and every daemon picks it up without a restart.
//
// A new pair replaces the current one only once it parses and its key matches its certificate; a
// bad or half-written pair (the manager replaced the certificate but not yet the key) keeps the old
// one serving, and is logged once per version. Existing sessions keep whatever they negotiated —
// only new handshakes see the new pair.
//
// Watching: fs.watch on the containing directory, not the files, because managers replace files
// by rename (and Kubernetes-style mounts by swapping a symlinked directory), which a watch on the
// file itself misses. fs.watch is unreliable on some filesystems and volumes, so a periodic
// stat-based check runs as well.
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { createSecureContext, type SecureContext, type TlsOptions } from 'node:tls';

/** The /health reason when a daemon runs without a certificate. */
export const NO_TLS_CERTIFICATE = 'no TLS certificate loaded';

export interface TlsPair {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/** The pair a daemon serves right now; the one source every listener and upgrade reads from. */
export interface TlsContextSource {
  /** The current context, or null when no certificate is loaded. Read at each handshake. */
  context(): SecureContext | null;
  /** The PEM pair behind `context()` — what tls.Server#setSecureContext takes. */
  pair(): TlsPair | null;
  /** Whether a certificate can appear or change later (a watched pair), so an implicit-TLS
   * listener is worth binding even while none is loaded. */
  readonly canChange: boolean;
  /** Called after each swap. Returns an unsubscribe. */
  onChange(fn: (pair: TlsPair) => void): () => void;
  close(): void;
}

type Log = (event: string, fields?: Record<string, unknown>) => void;

const MIN_VERSION: TlsOptions['minVersion'] = 'TLSv1.2';

/**
 * Validate a pair: it must build a context (TLS 1.2+), and the key must be the certificate's. The
 * explicit check matters because the failure mode during renewal is a valid key next to the other
 * certificate.
 */
export function buildSecureContext(pair: { readonly key: Buffer | string; readonly cert: Buffer | string }): SecureContext {
  const x509 = new X509Certificate(pair.cert);
  if (!x509.checkPrivateKey(createPrivateKey(pair.key))) throw new Error('the TLS key does not match the certificate');
  return createSecureContext({ key: pair.key, cert: pair.cert, minVersion: MIN_VERSION });
}

/** A fixed pair (or none) — what a test or an unconfigured daemon passes. */
export function staticTlsSource(pair: { readonly key: Buffer | string; readonly cert: Buffer | string } | null | undefined): TlsContextSource {
  const loaded = pair === null || pair === undefined ? null : { key: Buffer.from(pair.key), cert: Buffer.from(pair.cert) };
  const context = loaded === null ? null : buildSecureContext(loaded);
  return {
    context: () => context,
    pair: () => loaded,
    canChange: false,
    onChange: () => () => undefined,
    close: () => undefined,
  };
}

function isTlsContextSource(value: unknown): value is TlsContextSource {
  return typeof value === 'object' && value !== null && typeof (value as { context?: unknown }).context === 'function';
}

/** A daemon's `tls` option: a fixed pair, a source, or nothing. */
export type TlsInput = { readonly key: Buffer | string; readonly cert: Buffer | string } | TlsContextSource | null | undefined;

export function toTlsSource(input: TlsInput): TlsContextSource {
  return isTlsContextSource(input) ? input : staticTlsSource(input);
}

/** The /health fields for a source: degraded, with the reason, while no certificate is loaded. */
export function tlsHealth(source: TlsContextSource): Record<string, unknown> {
  return source.context() === null ? { status: 'degraded', reason: NO_TLS_CERTIFICATE, tls: 'none' } : { tls: 'ok' };
}

export interface WatchTlsPairOptions {
  /** TLS_CERT_FILE; unset or blank means no certificate, ever (nothing is watched). */
  readonly certFile: string | undefined;
  readonly keyFile: string | undefined;
  readonly log?: Log;
  /** Settle time after a directory event, so a manager writing both files is read once. Default 250 ms. */
  readonly debounceMs?: number;
  /** The stat-based fallback's interval. Default 60 s. */
  readonly pollMs?: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Load the pair now, then keep it current. Never throws: a missing or bad pair is logged. */
export function watchTlsPair(o: WatchTlsPairOptions): TlsContextSource {
  const log: Log = o.log ?? (() => undefined);
  const certFile = o.certFile?.trim() ?? '';
  const keyFile = o.keyFile?.trim() ?? '';
  const configured = certFile !== '' && keyFile !== '';
  let current: { pair: TlsPair; context: SecureContext; version: string } | null = null;
  // Logged once per version, so a stuck bad pair is not a line every minute.
  let lastFailure = '';
  let lastStat = '';
  const listeners = new Set<(pair: TlsPair) => void>();
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let closed = false;

  const statSignature = (): string => {
    const parts: string[] = [];
    for (const file of [certFile, keyFile]) {
      try {
        const s = statSync(file);
        parts.push(`${String(s.ino)}:${String(s.size)}:${String(s.mtimeMs)}`);
      } catch {
        parts.push('missing');
      }
    }
    return parts.join('|');
  };

  const check = (): void => {
    if (closed || !configured) return;
    lastStat = statSignature();
    let pair: TlsPair;
    try {
      pair = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
    } catch (err) {
      const failure = `unreadable:${errorText(err)}`;
      if (failure !== lastFailure) {
        lastFailure = failure;
        log(current === null ? 'no-tls-certificate' : 'tls-certificate-unreadable', {
          message: current === null ? `cannot read the TLS certificate: ${NO_TLS_CERTIFICATE}` : 'cannot read the TLS certificate: keeping the loaded one',
          error: errorText(err),
        });
      }
      return;
    }
    const version = createHash('sha256').update(pair.cert).update('\0').update(pair.key).digest('hex');
    if (version === current?.version) return;
    let context: SecureContext;
    try {
      context = buildSecureContext(pair);
    } catch (err) {
      if (version !== lastFailure) {
        lastFailure = version;
        log('tls-certificate-rejected', {
          message: current === null ? `the TLS certificate does not load: ${NO_TLS_CERTIFICATE}` : 'the new TLS certificate does not load: keeping the old one',
          error: errorText(err),
        });
      }
      return;
    }
    const replaced = current !== null;
    current = { pair, context, version };
    lastFailure = '';
    log(replaced ? 'tls-certificate-reloaded' : 'tls-certificate-loaded', { subject: subjectOf(pair.cert), notAfter: notAfterOf(pair.cert) });
    for (const fn of listeners) {
      try {
        fn(pair);
      } catch (err) {
        log('tls-reload-listener-error', { error: errorText(err) });
      }
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      check();
    }, o.debounceMs ?? 250);
    debounce.unref();
  };

  if (configured) {
    check();
    for (const dir of new Set([dirname(certFile), dirname(keyFile)])) {
      try {
        const w = watch(dir, { persistent: false }, () => {
          schedule();
        });
        w.on('error', (err) => {
          log('tls-watch-error', { dir, error: errorText(err), fallback: 'polling' });
          w.close();
        });
        watchers.push(w);
      } catch (err) {
        // No such directory yet (the manager has not issued), or no inotify: the poll covers it.
        log('tls-watch-error', { dir, error: errorText(err), fallback: 'polling' });
      }
    }
    poll = setInterval(() => {
      if (statSignature() !== lastStat) check();
    }, o.pollMs ?? 60_000);
    poll.unref();
  } else {
    log('no-tls-certificate', { message: `TLS_CERT_FILE/TLS_KEY_FILE not set: ${NO_TLS_CERTIFICATE}` });
  }

  return {
    context: () => current?.context ?? null,
    pair: () => current?.pair ?? null,
    canChange: configured,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () => {
      closed = true;
      if (debounce !== undefined) clearTimeout(debounce);
      if (poll !== undefined) clearInterval(poll);
      for (const w of watchers) w.close();
      listeners.clear();
    },
  };
}

function subjectOf(cert: Buffer): string | undefined {
  try {
    return new X509Certificate(cert).subject;
  } catch {
    return undefined;
  }
}

function notAfterOf(cert: Buffer): string | undefined {
  try {
    return new X509Certificate(cert).validTo;
  } catch {
    return undefined;
  }
}
