// PST-T-11.13 / PST-REQ-020: the IMAP listeners read the certificate at each connection, so a
// renewed pair serves the next 993 handshake and the next STARTTLS on 143 while a session opened
// before the swap carries on. Bound with a certificate that may appear later, 993 refuses until one
// has loaded and 143 offers no STARTTLS; once it loads, both work without a restart.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, createSecureContext, type SecureContext, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOpenssl, startHarness, type Harness } from './harness.js';

const baseUrl = process.env['DATABASE_URL'];
const canRun = baseUrl !== undefined && (await hasOpenssl());

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

function tlsDial(port: number): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const t = tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false, servername: 'localhost' }, () => {
      resolve(t);
    });
    t.once('error', reject);
  });
}

const cnOf = (tls: TLSSocket): string => String(tls.getPeerCertificate().subject.CN);

const TAGGED = (tag: string): RegExp => new RegExp(`(^|\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n$`);
const GREETING = /^\* OK[^\r\n]*\r\n$/;

async function implicit(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const tls = await tlsDial(port);
  const lines = new Lines(tls);
  await lines.until(GREETING);
  return { tls, lines, cn: cnOf(tls) };
}

async function starttls(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const socket = await plainConnect(port);
  const plain = new Lines(socket);
  await plain.until(GREETING);
  socket.write('s1 STARTTLS\r\n');
  await plain.until(TAGGED('s1'));
  plain.detach();
  const tls = await wrap(socket);
  return { tls, lines: new Lines(tls), cn: cnOf(tls) };
}

async function logout(s: { tls: TLSSocket; lines: Lines }): Promise<void> {
  const closed = once(s.tls, 'close');
  s.tls.write('z LOGOUT\r\n');
  await s.lines.until(TAGGED('z'));
  await closed;
}

describe.skipIf(!canRun)('imap certificate reload (PST-T-11.13)', () => {
  let h: Harness;
  let dir = '';
  let pairs: { old: { cert: Buffer; key: Buffer }; renewed: { cert: Buffer; key: Buffer } };

  beforeAll(async () => {
    h = await startHarness('pst_t1113_imap');
    dir = mkdtempSync(join(tmpdir(), 'imap-reload-'));
    pairs = { old: makePair(dir, 'old.imap.test'), renewed: makePair(dir, 'new.imap.test') };
  }, 120_000);

  afterAll(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('new 993 and STARTTLS handshakes present the swapped certificate while open sessions continue', async () => {
    const tls = swappable(contextOf(pairs.old));
    const { port, tlsPort } = await h.listenersWith({ tls });
    const a993 = await implicit(tlsPort);
    const a143 = await starttls(port);
    expect([a993.cn, a143.cn]).toEqual(['old.imap.test', 'old.imap.test']);

    tls.set(contextOf(pairs.renewed));
    const b993 = await implicit(tlsPort);
    const b143 = await starttls(port);
    expect([b993.cn, b143.cn]).toEqual(['new.imap.test', 'new.imap.test']);

    for (const s of [a993, a143]) {
      expect(cnOf(s.tls)).toBe('old.imap.test');
      s.tls.write('n1 NOOP\r\n');
      expect(await s.lines.until(TAGGED('n1'))).toMatch(/n1 OK/);
    }
    for (const s of [a993, a143, b993, b143]) await logout(s);
  });

  it('before a certificate loads: 993 is bound but refuses, 143 has no STARTTLS; after, both serve it', async () => {
    const tls = swappable(null);
    const { listeners, port, tlsPort } = await h.listenersWith({ tls });
    expect(listeners.imaps).not.toBeNull();
    await expect(implicit(tlsPort)).rejects.toThrow();
    const socket = await plainConnect(port);
    const plain = new Lines(socket);
    const greeting = await plain.until(GREETING);
    socket.write('c1 CAPABILITY\r\n');
    const caps = greeting + (await plain.until(TAGGED('c1')));
    expect(caps).not.toMatch(/STARTTLS/);
    expect(caps).toMatch(/LOGINDISABLED/);
    socket.destroy();

    tls.set(contextOf(pairs.renewed));
    const s993 = await implicit(tlsPort);
    const s143 = await starttls(port);
    expect([s993.cn, s143.cn]).toEqual(['new.imap.test', 'new.imap.test']);
    await logout(s993);
    await logout(s143);
  });

  it('a fixed pair of none still has no 993 listener at all', async () => {
    const { listeners } = await h.listenersWith({ tls: null });
    expect(listeners.imaps).toBeNull();
  });
});
