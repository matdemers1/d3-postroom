// PST-T-11.13 / PST-REQ-020: ManageSieve reads the certificate at each connection, so a renewed
// pair serves the next STARTTLS while a session opened before the swap carries on; without one there
// is no STARTTLS, and once one loads there is, without a restart.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, createSecureContext, type SecureContext, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const baseUrl = process.env['DATABASE_URL'];

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const canRun = baseUrl !== undefined && haveOpenssl();

function makePair(dir: string, cn: string): { cert: Buffer; key: Buffer } {
  const keyFile = join(dir, `${cn}.key`);
  const certFile = join(dir, `${cn}.crt`);
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', `/CN=${cn}`],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

/** Reads a stream until a pattern matches the text received since the last match. */
class Lines {
  private buf = '';
  private wake: (() => void) | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('latin1');
    this.wake?.();
  };
  constructor(readonly stream: Duplex) {
    stream.on('data', this.onData);
  }
  async until(pattern: RegExp, ms = 10_000): Promise<string> {
    const deadline = Date.now() + ms;
    while (!pattern.test(this.buf)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(pattern)}; got ${JSON.stringify(this.buf)}`);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    const text = this.buf;
    this.buf = '';
    return text;
  }
  detach(): void {
    this.stream.off('data', this.onData);
  }
}

/**
 * A provider the test swaps by hand — what watchTlsPair (@postroom/smtp-proto) does on a file change.
 * The file watching itself is covered there and in the smtp-in/submission reload tests.
 */
function swappable(initial: SecureContext | null): { context(): SecureContext | null; readonly canChange: true; set(next: SecureContext | null): void } {
  let current = initial;
  return {
    context: () => current,
    canChange: true,
    set: (next) => {
      current = next;
    },
  };
}

function contextOf(pair: { cert: Buffer; key: Buffer }): SecureContext {
  return createSecureContext({ key: pair.key, cert: pair.cert, minVersion: 'TLSv1.2' });
}

async function plainConnect(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const s = connect({ port, host: '127.0.0.1' }, () => {
      resolve(s);
    });
    s.once('error', reject);
  });
}

function wrap(socket: Socket): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const t = tlsConnect({ socket, rejectUnauthorized: false, servername: 'localhost' }, () => {
      resolve(t);
    });
    t.once('error', reject);
  });
}

const cnOf = (tls: TLSSocket): string => String(tls.getPeerCertificate().subject.CN);

const FINAL = /(^|\n)(OK|NO|BYE)[^\r\n]*\r\n$/;

/** Connect, read the capability greeting. */
async function greet(port: number): Promise<{ socket: Socket; lines: Lines; caps: string }> {
  const socket = await plainConnect(port);
  const lines = new Lines(socket);
  return { socket, lines, caps: await lines.until(FINAL) };
}

async function starttls(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const { socket, lines } = await greet(port);
  socket.write('STARTTLS\r\n');
  await lines.until(FINAL);
  lines.detach();
  const tls = await wrap(socket);
  const secure = new Lines(tls);
  // RFC 5804: the server re-issues its capabilities after the handshake.
  await secure.until(FINAL);
  return { tls, lines: secure, cn: cnOf(tls) };
}

async function logout(s: { tls: TLSSocket; lines: Lines }): Promise<void> {
  const closed = once(s.tls, 'close');
  s.tls.write('LOGOUT\r\n');
  await s.lines.until(FINAL);
  await closed;
}

describe.skipIf(!canRun)('managesieve certificate reload (PST-T-11.13)', () => {
  let h: Harness;
  let dir = '';
  let pairs: { old: { cert: Buffer; key: Buffer }; renewed: { cert: Buffer; key: Buffer } };

  beforeAll(async () => {
    h = await startHarness('pst_t1113_sieve');
    dir = mkdtempSync(join(tmpdir(), 'sieve-reload-'));
    pairs = { old: makePair(dir, 'old.sieve.test'), renewed: makePair(dir, 'new.sieve.test') };
  }, 120_000);

  afterAll(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new STARTTLS handshake presents the swapped certificate while an open session continues', async () => {
    const tls = swappable(contextOf(pairs.old));
    const { port } = await h.serverWith({ tls });
    const before = await starttls(port);
    expect(before.cn).toBe('old.sieve.test');

    tls.set(contextOf(pairs.renewed));
    const after = await starttls(port);
    expect(after.cn).toBe('new.sieve.test');

    expect(cnOf(before.tls)).toBe('old.sieve.test');
    before.tls.write('NOOP\r\n');
    expect(await before.lines.until(FINAL)).toMatch(/^OK/m);
    await logout(before);
    await logout(after);
  });

  it('offers no STARTTLS before a certificate loads, and does once one has, without a restart', async () => {
    const tls = swappable(null);
    const { port } = await h.serverWith({ tls });
    const none = await greet(port);
    expect(none.caps).not.toMatch(/"STARTTLS"/);
    none.socket.destroy();

    tls.set(contextOf(pairs.renewed));
    const offered = await greet(port);
    expect(offered.caps).toMatch(/"STARTTLS"/);
    offered.socket.destroy();
    const s = await starttls(port);
    expect(s.cn).toBe('new.sieve.test');
    await logout(s);
  });
});
