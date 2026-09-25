// The gating test for PST-REQ-060: smtp-in runs as a real child process (src/main.ts under tsx) and
// is SIGKILLed the instant the client reads 250. Nothing may be lost: the spool row (state
// 'spooled'), its blob — decrypting to Received + Authentication-Results + the exact bytes sent —
// and the 'inbound' job that files it are all already committed. Killed during DATA instead, before
// any reply, nothing is committed and the client never sees 250.
//
// DNS: the child resolves through a loopback UDP responder that answers NXDOMAIN to everything, so
// SPF, DKIM, DMARC and ARC all come out none and the message is accepted without touching the
// network.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { exportKekBase64, generateKek } from '@postroom/crypto';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];
const appDir = fileURLToPath(new URL('../..', import.meta.url));

/** Answer every query with NXDOMAIN: header + the question echoed, no records. */
async function startNxdomainDns(): Promise<{ socket: UdpSocket; port: number }> {
  const socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    let i = 12;
    while (i < msg.length && msg[i] !== 0) i += (msg[i] ?? 0) + 1;
    const end = i + 1 + 4;
    if (end > msg.length) return;
    const resp = Buffer.from(msg.subarray(0, end));
    resp[2] = 0x80 | ((msg[2] ?? 0) & 0x01); // QR, keep RD
    resp[3] = 0x83; // RA, RCODE 3 (NXDOMAIN)
    resp.fill(0, 6, 12); // ANCOUNT, NSCOUNT, ARCOUNT
    socket.send(resp, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { socket, port: socket.address().port };
}

interface Child {
  proc: ChildProcess;
  port: number;
  output: string[];
}

describe.skipIf(baseUrl === undefined)('kill -9 after 250 loses nothing (PST-REQ-060)', () => {
  let t: TestDatabase;
  let blobRoot = '';
  let blobs: BlobStore;
  let dnsServer: { socket: UdpSocket; port: number };
  const kek = generateKek();
  const children: ChildProcess[] = [];

  async function startChild(): Promise<Child> {
    const proc = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/main.ts'], {
      cwd: appDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: t.url,
        BLOB_ROOT: blobRoot,
        POSTROOM_KEK: exportKekBase64(kek),
        SMTP_PORT: '0',
        LISTEN_HOST: '127.0.0.1',
        HEALTH_PORT: '0',
        MX_HOSTNAME: 'mx.d3cloud.io',
        DNS_RESOLVER: `127.0.0.1:${String(dnsServer.port)}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    const output: string[] = [];
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));
    const lines = createInterface({ input: proc.stdout });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`smtp-in did not start: ${output.join('')}`)); }, 60_000);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`smtp-in exited ${String(code)}: ${output.join('')}`));
      });
      lines.on('line', (line) => {
        output.push(line);
        try {
          const ev = JSON.parse(line) as { event?: string; port?: number };
          if (ev.event === 'listening' && typeof ev.port === 'number') {
            clearTimeout(timer);
            resolve(ev.port);
          }
        } catch (err) {
          output.push(`(unparsed: ${String(err)})`);
        }
      });
    });
    return { proc, port, output };
  }

  async function killed(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => { resolve(); }));
    proc.kill('SIGKILL');
    await exited;
  }

  async function openTransaction(port: number): Promise<TestClient> {
    const c = await TestClient.open(port);
    expect((await c.next()).code).toBe(220);
    expect((await c.cmd('EHLO client.example')).code).toBe(250);
    expect(codeOf(await c.cmd('MAIL FROM:<alice@sender.example>'))).toBe('250 2.1.0');
    expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
    expect((await c.cmd('DATA')).code).toBe(354);
    return c;
  }

  function body(subject: string): Buffer {
    // About 1 MB of base64 lines, so the kill lands on a message worth losing.
    const lines = [`From: alice@sender.example`, `To: matt@d3cloud.io`, `Subject: ${subject}`, `Message-ID: <${randomBytes(8).toString('hex')}@sender.example>`, ''];
    for (let i = 0; i < 13_000; i++) lines.push(randomBytes(57).toString('base64'));
    return Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1');
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t26');
    const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    await t.db.address.create({ data: { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId } });
    blobRoot = mkdtempSync(join(tmpdir(), 'smtp-in-kill-'));
    blobs = createBlobStore({ root: blobRoot, db: t.db, kek });
    dnsServer = await startNxdomainDns();
  }, 120_000);

  afterAll(async () => {
    for (const p of children) await killed(p);
    dnsServer.socket.close();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('SIGKILL the moment 250 is read, three times: row spooled, blob exact, job pending', async () => {
    for (let round = 1; round <= 3; round++) {
      const child = await startChild();
      const subject = `Kill round ${String(round)}`;
      const data = body(subject);
      const c = await openTransaction(child.port);
      await c.writeAsync(data);
      c.write('.\r\n');
      const r = await c.next();
      // The instant the client has its 250: no graceful anything.
      child.proc.kill('SIGKILL');
      expect(codeOf(r), child.output.join('\n')).toBe('250 2.0.0');
      await killed(child.proc);
      c.end();

      const id = /Queued as ([0-9a-f-]{36})/.exec(r.lines.join(' '))?.[1] ?? '';
      const row = await t.db.inboundMessage.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe('spooled');
      expect(row.disposition).toBe('accept');
      const stored = await blobs.getBuffer(row.blobSha256);
      expect(await blobs.verify(row.blobSha256)).toBe(true);
      const text = stored.toString('latin1');
      expect(text.startsWith('Received: from client.example ')).toBe(true);
      const arAt = text.indexOf('\r\nAuthentication-Results: mx.d3cloud.io; ');
      expect(arAt).toBeGreaterThan(0);
      const ar = text.slice(arAt + 2, text.indexOf('\r\nFrom: alice@sender.example') + 2).replace(/\r\n[\t ]/g, ' ');
      expect(ar).toMatch(/spf=\w+ .*; dkim=none; dmarc=\w+ .*; arc=none\r\n$/);
      // The message exactly as sent follows the two trace fields.
      expect(stored.subarray(stored.length - data.length).equals(data)).toBe(true);
      expect(stored.length - data.length).toBe(text.indexOf('From: alice@sender.example'));

      const job = await t.db.job.findUniqueOrThrow({ where: { idempotencyKey: `inbound:${id}` } });
      expect(job).toMatchObject({ queue: 'inbound', status: 'pending', payload: { inboundMessageId: id } });
    }
    expect(await t.db.inboundMessage.count({ where: { state: 'spooled' } })).toBe(3);

    // Restart: the daemon comes back over the same spool, and the three are still waiting to be filed.
    const again = await startChild();
    expect(await t.db.job.count({ where: { queue: 'inbound', status: 'pending' } })).toBe(3);
    await killed(again.proc);
  }, 180_000);

  it('SIGKILL during DATA, before any reply: nothing committed and no 250', async () => {
    const before = {
      inbound: await t.db.inboundMessage.count(),
      jobs: await t.db.job.count(),
      sessions: await t.db.inboundSession.count(),
    };
    const child = await startChild();
    const c = await openTransaction(child.port);
    const data = body('Killed mid-DATA');
    // Most of the body, never the terminating dot.
    await c.writeAsync(data.subarray(0, data.length - 1000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await killed(child.proc);
    await expect(c.next()).rejects.toThrow('connection closed before the next reply');
    expect({
      inbound: await t.db.inboundMessage.count(),
      jobs: await t.db.job.count(),
      sessions: await t.db.inboundSession.count(),
    }).toEqual(before);
  }, 120_000);
});
