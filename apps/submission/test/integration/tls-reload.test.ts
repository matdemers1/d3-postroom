// PST-T-11.13 / PST-REQ-020: submission serves a renewed certificate without a restart, on 587
// (STARTTLS) and 465 (implicit TLS, via tls.Server#setSecureContext). The watched files are replaced
// by rename, as a certificate manager does; new handshakes present the new certificate while a
// session opened before the swap carries on. With the files configured but not yet issued, 465 is
// bound and refuses connections, 587 offers no STARTTLS, and both start working once they appear.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { watchTlsPair, type TlsContextSource } from '@postroom/smtp-proto';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';

const baseUrl = process.env['DATABASE_URL'];

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const OPENSSL = haveOpenssl();

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

function install(dir: string, pair: { cert: Buffer; key: Buffer }): void {
  for (const [name, data] of [['key.pem', pair.key], ['cert.pem', pair.cert]] as const) {
    writeFileSync(join(dir, `${name}.tmp`), data);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  }
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

const FINAL = (code: number): RegExp => new RegExp(`(^|\\n)${String(code)} [^\\r\\n]*\\r\\n$`);

async function ehlo(port: number): Promise<{ socket: Socket; lines: Lines; ehlo: string }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ port, host: '127.0.0.1' }, () => {
      resolve(s);
    });
    s.once('error', reject);
  });
  const lines = new Lines(socket);
  await lines.until(FINAL(220));
  socket.write('EHLO client.test\r\n');
  return { socket, lines, ehlo: await lines.until(FINAL(250)) };
}

async function secure(tls: TLSSocket): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const lines = new Lines(tls);
  tls.write('EHLO client.test\r\n');
  await lines.until(FINAL(250));
  return { tls, lines, cn: String(tls.getPeerCertificate().subject.CN) };
}

/** 587: EHLO, STARTTLS, EHLO again. */
async function starttls(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const { socket, lines } = await ehlo(port);
  socket.write('STARTTLS\r\n');
  await lines.until(FINAL(220));
  lines.detach();
  const tls = await new Promise<TLSSocket>((resolve, reject) => {
    const t = tlsConnect({ socket, rejectUnauthorized: false, servername: 'mail.test' }, () => {
      resolve(t);
    });
    t.once('error', reject);
  });
  return secure(tls);
}

/** 465: the handshake first, then the greeting. */
async function implicit(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const tls = await new Promise<TLSSocket>((resolve, reject) => {
    const t = tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false, servername: 'mail.test' }, () => {
      resolve(t);
    });
    t.once('error', reject);
  });
  const greeting = new Lines(tls);
  await greeting.until(FINAL(220));
  greeting.detach();
  return secure(tls);
}

/** End a session politely, so its transcript is written before the database goes away. */
async function quit(s: { tls?: TLSSocket; socket?: Socket; lines: Lines }): Promise<void> {
  const stream = s.tls ?? s.socket;
  if (stream === undefined) return;
  const closed = once(stream, 'close');
  stream.write('QUIT\r\n');
  await s.lines.until(FINAL(221));
  await closed;
}

async function waitFor(fn: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(baseUrl === undefined || !OPENSSL)('submission certificate reload (PST-T-11.13)', () => {
  let t: TestDatabase;
  const dirs: string[] = [];
  const open: SubmissionListeners[] = [];
  const sources: TlsContextSource[] = [];
  let pairs: { old: { cert: Buffer; key: Buffer }; renewed: { cert: Buffer; key: Buffer } };

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'submission-reload-'));
    dirs.push(dir);
    return dir;
  }

  async function start(dir: string): Promise<{ port587: number; port465: number; source: TlsContextSource }> {
    const source = watchTlsPair({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem'), debounceMs: 30, pollMs: 200 });
    sources.push(source);
    const listeners = createSubmissionListeners({
      db: t.db,
      hostname: 'mail.d3cloud.io',
      maxSize: 1024 * 1024,
      maxRecipients: 3,
      pepper: 'pepper',
      storage: () => {
        throw new Error('storage must not be reached');
      },
      tls: source,
    });
    open.push(listeners);
    listeners.submission.listen(0, '127.0.0.1');
    await once(listeners.submission, 'listening');
    const s465 = listeners.submissions;
    if (s465 === null) throw new Error('465 listener missing');
    s465.listen(0, '127.0.0.1');
    await once(s465, 'listening');
    return {
      port587: (listeners.submission.address() as AddressInfo).port,
      port465: (s465.address() as AddressInfo).port,
      source,
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1113_sub');
    const fixtures = tempDir();
    pairs = { old: makePair(fixtures, 'old.mail.test'), renewed: makePair(fixtures, 'new.mail.test') };
  }, 120_000);

  afterAll(async () => {
    for (const s of sources) s.close();
    for (const l of open) await l.close();
    // Transcripts are written as sessions end; let the last ones land before the drop.
    await new Promise((r) => setTimeout(r, 300));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await t.drop();
  });

  it('new 587 and 465 handshakes present the replaced certificate while open sessions continue', async () => {
    const dir = tempDir();
    install(dir, pairs.old);
    const { port587, port465, source } = await start(dir);

    const a465 = await implicit(port465);
    const a587 = await starttls(port587);
    expect([a465.cn, a587.cn]).toEqual(['old.mail.test', 'old.mail.test']);

    install(dir, pairs.renewed);
    await waitFor(() => source.pair()?.cert.equals(pairs.renewed.cert) === true, 'the renewed pair loads');

    const b465 = await implicit(port465);
    const b587 = await starttls(port587);
    expect([b465.cn, b587.cn]).toEqual(['new.mail.test', 'new.mail.test']);

    // Sessions opened before the swap keep their negotiated TLS and keep working.
    for (const s of [a465, a587]) {
      expect(s.tls.getPeerCertificate().subject.CN).toBe('old.mail.test');
      s.tls.write('NOOP\r\n');
      expect(await s.lines.until(FINAL(250))).toMatch(/^250 /m);
    }
    for (const s of [a465, a587, b465, b587]) await quit(s);
  });

  it('keeps serving the old certificate when the replacement does not load', async () => {
    const dir = tempDir();
    install(dir, pairs.old);
    const { port465 } = await start(dir);
    writeFileSync(join(dir, 'cert.pem.tmp'), pairs.renewed.cert);
    renameSync(join(dir, 'cert.pem.tmp'), join(dir, 'cert.pem'));
    await new Promise((r) => setTimeout(r, 500));
    const s = await implicit(port465);
    expect(s.cn).toBe('old.mail.test');
    await quit(s);
  });

  it('before a certificate is issued: 465 refuses, 587 has no STARTTLS; after, both serve it without a restart', async () => {
    const dir = tempDir();
    const { port587, port465, source } = await start(dir);
    expect(source.context()).toBeNull();
    await expect(implicit(port465)).rejects.toThrow();
    const plain = await ehlo(port587);
    expect(plain.ehlo).not.toMatch(/STARTTLS/);
    await quit(plain);

    install(dir, pairs.renewed);
    await waitFor(() => source.context() !== null, 'the issued pair loads');
    const s465 = await implicit(port465);
    const s587 = await starttls(port587);
    expect([s465.cn, s587.cn]).toEqual(['new.mail.test', 'new.mail.test']);
    await quit(s465);
    await quit(s587);
  });
});
