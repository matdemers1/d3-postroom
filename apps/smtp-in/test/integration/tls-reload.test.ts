// PST-T-11.13 / PST-REQ-020: smtp-in serves a renewed certificate without a restart. The files a
// running server watches are replaced (by rename, as a certificate manager does); a new STARTTLS
// handshake presents the new certificate while a session opened before the swap carries on over the
// old one. Without a certificate STARTTLS is not offered, and it is once one is issued.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpfDns } from '@postroom/auth-checks';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { reply, watchTlsPair, type TlsContextSource } from '@postroom/smtp-proto';
import { MAX_MESSAGE_SIZE } from '../../src/config.js';
import { createSmtpInServer, type SmtpInServer } from '../../src/server.js';

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

const noDns: SpfDns = {
  txt: () => Promise.resolve({ records: [], void: true }),
  a: () => Promise.resolve({ records: [], void: true }),
  aaaa: () => Promise.resolve({ records: [], void: true }),
  mx: () => Promise.resolve({ records: [], void: true }),
  ptr: () => Promise.resolve({ records: [], void: true }),
};

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

/** EHLO, STARTTLS, EHLO again: an SMTP session over TLS and the certificate it was shown. */
async function starttls(port: number): Promise<{ tls: TLSSocket; lines: Lines; cn: string }> {
  const { socket, lines } = await ehlo(port);
  socket.write('STARTTLS\r\n');
  await lines.until(FINAL(220));
  lines.detach();
  const tls = await new Promise<TLSSocket>((resolve, reject) => {
    const t = tlsConnect({ socket, rejectUnauthorized: false, servername: 'mx.test' }, () => {
      resolve(t);
    });
    t.once('error', reject);
  });
  const secure = new Lines(tls);
  tls.write('EHLO client.test\r\n');
  await secure.until(FINAL(250));
  return { tls, lines: secure, cn: String(tls.getPeerCertificate().subject.CN) };
}

describe.skipIf(baseUrl === undefined || !OPENSSL)('smtp-in certificate reload (PST-T-11.13)', () => {
  let t: TestDatabase;
  let fixtures = '';
  const dirs: string[] = [];
  const servers: SmtpInServer[] = [];
  const sources: TlsContextSource[] = [];
  let pairs: { old: { cert: Buffer; key: Buffer }; renewed: { cert: Buffer; key: Buffer } };

  async function start(dir: string): Promise<{ port: number; source: TlsContextSource }> {
    const source = watchTlsPair({ certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem'), debounceMs: 30, pollMs: 200 });
    sources.push(source);
    const server = createSmtpInServer({
      db: t.db,
      hostname: 'mx.d3cloud.io',
      maxSize: MAX_MESSAGE_SIZE,
      edgePeers: ['10.77.0.1'],
      proxyTimeoutMs: 5_000,
      maxConnectionsPerIp: 50,
      maxRecipientsPerMessage: 100,
      maxRecipientsPerSession: 150,
      maxErrors: 10,
      idleTimeoutMs: 60_000,
      tls: source,
      spfDns: noDns,
      dkimDns: { txt: () => Promise.resolve([]) },
      reverseLookup: () => Promise.resolve(null),
      acceptMessage: () => Promise.resolve(reply(250, '2.0.0', 'captured')),
      log: () => undefined,
    });
    servers.push(server);
    return { port: (await server.listen(0, '127.0.0.1')).port, source };
  }

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'smtp-in-reload-'));
    dirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1113_smtpin');
    fixtures = tempDir();
    pairs = { old: makePair(fixtures, 'old.mx.test'), renewed: makePair(fixtures, 'new.mx.test') };
  }, 120_000);

  afterAll(async () => {
    for (const s of sources) s.close();
    await Promise.all(servers.map((s) => s.close()));
    // Transcripts are written as sessions end; let the last ones land before the drop.
    await new Promise((r) => setTimeout(r, 300));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await t.drop();
  });

  it('a new STARTTLS handshake presents the replaced certificate while an open session continues', async () => {
    const dir = tempDir();
    install(dir, pairs.old);
    const { port, source } = await start(dir);

    const before = await starttls(port);
    expect(before.cn).toBe('old.mx.test');

    install(dir, pairs.renewed);
    const deadline = Date.now() + 10_000;
    while (source.pair()?.cert.equals(pairs.renewed.cert) !== true) {
      if (Date.now() > deadline) throw new Error('the renewed pair was never loaded');
      await new Promise((r) => setTimeout(r, 25));
    }

    const after = await starttls(port);
    expect(after.cn).toBe('new.mx.test');

    // The session opened before the swap is untouched: same negotiated certificate, still talking.
    expect(before.tls.getPeerCertificate().subject.CN).toBe('old.mx.test');
    before.tls.write('NOOP\r\n');
    expect(await before.lines.until(FINAL(250))).toMatch(/^250 /m);
    before.tls.write('QUIT\r\n');
    await before.lines.until(FINAL(221));
    after.tls.write('QUIT\r\n');
    await after.lines.until(FINAL(221));
  });

  it('keeps serving the old certificate when the replacement does not load', async () => {
    const dir = tempDir();
    install(dir, pairs.old);
    const { port } = await start(dir);
    // A new certificate beside the old key: the half-finished renewal.
    writeFileSync(join(dir, 'cert.pem.tmp'), pairs.renewed.cert);
    renameSync(join(dir, 'cert.pem.tmp'), join(dir, 'cert.pem'));
    await new Promise((r) => setTimeout(r, 500));
    const s = await starttls(port);
    expect(s.cn).toBe('old.mx.test');
    s.tls.destroy();
  });

  it('offers no STARTTLS without a certificate, and does once one is issued, without a restart', async () => {
    const dir = tempDir();
    const { port, source } = await start(dir);
    expect(source.context()).toBeNull();
    const plain = await ehlo(port);
    expect(plain.ehlo).not.toMatch(/STARTTLS/);
    plain.socket.destroy();

    install(dir, pairs.renewed);
    const deadline = Date.now() + 10_000;
    while (source.context() === null) {
      if (Date.now() > deadline) throw new Error('the issued pair was never loaded');
      await new Promise((r) => setTimeout(r, 25));
    }
    const offered = await ehlo(port);
    expect(offered.ehlo).toMatch(/STARTTLS/);
    offered.socket.destroy();
    const s = await starttls(port);
    expect(s.cn).toBe('new.mx.test');
    s.tls.destroy();
  });
});
