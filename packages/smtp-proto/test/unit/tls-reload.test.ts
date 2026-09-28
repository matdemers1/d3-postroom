// PST-T-11.13: the reloadable pair — loads at start, swaps on a rename (how certificate managers
// replace files), keeps the old pair when the new one does not load (logged once), reports a daemon
// without one as degraded, and picks up a first issuance after start.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NO_TLS_CERTIFICATE, staticTlsSource, tlsHealth, toTlsSource, watchTlsPair, type TlsContextSource } from '../../src/tls-reload.js';

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const OPENSSL = haveOpenssl();

interface Pem {
  cert: Buffer;
  key: Buffer;
}

function makePair(dir: string, cn: string): Pem {
  const keyFile = join(dir, `${cn}.key`);
  const certFile = join(dir, `${cn}.crt`);
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', `/CN=${cn}`],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

/** Replace a file the way a certificate manager does: write beside it, then rename over it. */
function replace(file: string, data: Buffer): void {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

function cnOf(source: TlsContextSource): string | undefined {
  const pair = source.pair();
  return pair === null ? undefined : new X509Certificate(pair.cert).subject.replace(/^CN=/, '');
}

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!OPENSSL)('watchTlsPair (PST-T-11.13)', () => {
  let pairs: Record<'old' | 'new' | 'other', Pem>;
  let fixtures = '';
  let dir = '';
  const sources: TlsContextSource[] = [];

  beforeAll(() => {
    fixtures = mkdtempSync(join(tmpdir(), 'tls-reload-fixtures-'));
    pairs = { old: makePair(fixtures, 'old.test'), new: makePair(fixtures, 'new.test'), other: makePair(fixtures, 'other.test') };
    return () => {
      rmSync(fixtures, { recursive: true, force: true });
    };
  });

  afterEach(() => {
    for (const s of sources.splice(0)) s.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function watched(log: (event: string) => void = () => undefined, pollMs = 60_000): TlsContextSource {
    const s = watchTlsPair({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem'), log, debounceMs: 30, pollMs });
    sources.push(s);
    return s;
  }

  it('loads the pair at start and swaps in a renewed one replaced by rename', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
    writeFileSync(join(dir, 'cert.pem'), pairs.old.cert);
    writeFileSync(join(dir, 'key.pem'), pairs.old.key);
    const events: string[] = [];
    const source = watched((e) => events.push(e));
    expect(cnOf(source)).toBe('old.test');
    expect(source.canChange).toBe(true);
    expect(tlsHealth(source)).toEqual({ tls: 'ok' });
    const before = source.context();
    const changed: string[] = [];
    source.onChange((p) => changed.push(new X509Certificate(p.cert).subject));

    replace(join(dir, 'key.pem'), pairs.new.key);
    replace(join(dir, 'cert.pem'), pairs.new.cert);
    await until(() => cnOf(source) === 'new.test');
    expect(source.context()).not.toBe(before);
    expect(changed).toEqual(['CN=new.test']);
    expect(events).toContain('tls-certificate-reloaded');
  });

  it('keeps the old pair when the new one does not load, and logs it once per version', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
    writeFileSync(join(dir, 'cert.pem'), pairs.old.cert);
    writeFileSync(join(dir, 'key.pem'), pairs.old.key);
    const events: string[] = [];
    const source = watched((e) => events.push(e), 50);
    const before = source.context();

    // The renewal's failure mode: a new certificate beside a key that is not its own.
    replace(join(dir, 'cert.pem'), pairs.other.cert);
    await until(() => events.includes('tls-certificate-rejected'));
    // Garbage is rejected too, and logged as its own version.
    replace(join(dir, 'cert.pem'), Buffer.from('-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n'));
    await until(() => events.filter((e) => e === 'tls-certificate-rejected').length === 2);
    // Several polls later, the same bad pair has not been logged again.
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e === 'tls-certificate-rejected')).toHaveLength(2);
    expect(source.context()).toBe(before);
    expect(cnOf(source)).toBe('old.test');

    // Once the pair is whole again it loads.
    replace(join(dir, 'key.pem'), pairs.new.key);
    replace(join(dir, 'cert.pem'), pairs.new.cert);
    await until(() => cnOf(source) === 'new.test');
  });

  it('reports degraded without a certificate, then loads one issued after start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
    const source = watched(undefined, 50);
    expect(source.context()).toBeNull();
    expect(source.canChange).toBe(true);
    expect(tlsHealth(source)).toEqual({ status: 'degraded', reason: NO_TLS_CERTIFICATE, tls: 'none' });
    expect(NO_TLS_CERTIFICATE).toBe('no TLS certificate loaded');

    replace(join(dir, 'key.pem'), pairs.new.key);
    replace(join(dir, 'cert.pem'), pairs.new.cert);
    await until(() => source.context() !== null);
    expect(cnOf(source)).toBe('new.test');
    expect(tlsHealth(source)).toEqual({ tls: 'ok' });
  });

  it('with the files unset: nothing loaded, nothing to watch, degraded', () => {
    const events: string[] = [];
    const source = watchTlsPair({ certFile: undefined, keyFile: '', log: (e) => events.push(e) });
    sources.push(source);
    expect(source.context()).toBeNull();
    expect(source.canChange).toBe(false);
    expect(events).toEqual(['no-tls-certificate']);
    expect(tlsHealth(source)['status']).toBe('degraded');
  });

  it('a fixed pair is a source that never changes; a source passes through toTlsSource as itself', () => {
    const fixed = staticTlsSource(pairs.old);
    expect(fixed.context()).not.toBeNull();
    expect(fixed.canChange).toBe(false);
    expect(toTlsSource(fixed)).toBe(fixed);
    expect(toTlsSource(null).context()).toBeNull();
    expect(() => staticTlsSource({ cert: pairs.old.cert, key: pairs.other.key })).toThrow(/does not match/);
  });
});
