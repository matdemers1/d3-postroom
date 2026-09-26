// PST-T-2.9: the DNSBL client, boot-time trust (PST-REQ-063) and the end-of-DATA 554 (PST-REQ-058).
//
// Boot-time: smtp-in is spawned exactly as production runs it (src/main.ts under tsx, the same
// entrypoint kill.test.ts uses) with DNS_RESOLVER pointed at a public resolver — the daemon must
// fail to boot, before it ever binds :25.
//
// Rejection: a fake DNS server answers the Spamhaus ZEN query for one IP as SBL-listed (127.0.0.2,
// Spamhaus's own reserved always-listed test address) and NXDOMAIN for everything else. The client
// IP is injected the same way PROXY v2 tests do it elsewhere in this suite: a PROXY v2 header from
// the trusted edge peer carrying the source address, since macOS only has 127.0.0.1 bound by default.
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportKekBase64, generateKek } from '@postroom/crypto';
import { seed } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { DNS_CLASS_IN, RRType, decodeMessage, encodeName, type DnsMessage } from '@postroom/dns';
import { dnsblQueryName } from '@postroom/dnsbl';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { codeOf, TestClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];
const appDir = fileURLToPath(new URL('../..', import.meta.url));
const ZONE = 'zen.spamhaus.org';

function aResponse(query: DnsMessage, address: string): Buffer {
  const question = query.questions[0];
  if (!question) throw new Error('no question in query');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(0x8180, 2); // QR=1, RD=1, RA=1, RCODE=NOERROR
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(1, 6); // ANCOUNT
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qName = Buffer.from(encodeName(question.name));
  const qTail = Buffer.alloc(4);
  qTail.writeUInt16BE(question.type, 0);
  qTail.writeUInt16BE(DNS_CLASS_IN, 2);
  const rrName = Buffer.from(encodeName(question.name));
  const rrHead = Buffer.alloc(10);
  rrHead.writeUInt16BE(RRType.A, 0);
  rrHead.writeUInt16BE(DNS_CLASS_IN, 2);
  rrHead.writeUInt32BE(60, 4); // ttl
  rrHead.writeUInt16BE(4, 8); // rdlength
  const rdata = Buffer.from(address.split('.').map(Number));
  return Buffer.concat([header, qName, qTail, rrName, rrHead, rdata]);
}

function nxdomainResponse(query: DnsMessage): Buffer {
  const question = query.questions[0];
  if (!question) throw new Error('no question in query');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(0x8183, 2); // QR=1, RD=1, RA=1, RCODE=NXDOMAIN
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qName = Buffer.from(encodeName(question.name));
  const qTail = Buffer.alloc(4);
  qTail.writeUInt16BE(question.type, 0);
  qTail.writeUInt16BE(DNS_CLASS_IN, 2);
  return Buffer.concat([header, qName, qTail]);
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/** Answers the Spamhaus ZEN query for `listedIp` as SBL-listed (127.0.0.2) and NXDOMAIN for every
 * other query (rDNS PTR/forward-confirm, SPF, DKIM, DMARC — none of which matter to this test). */
async function startFakeDns(listedIp: string): Promise<{ socket: UdpSocket; port: number }> {
  const listedName = normalise(dnsblQueryName(listedIp, ZONE));
  const socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const decoded = decodeMessage(msg);
    if (!decoded.ok) return;
    const question = decoded.message.questions[0];
    if (!question) return;
    const isListedDnsblQuery = question.type === RRType.A && normalise(question.name) === listedName;
    const response = isListedDnsblQuery ? aResponse(decoded.message, '127.0.0.2') : nxdomainResponse(decoded.message);
    socket.send(response, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => {
    socket.bind(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (typeof address !== 'object') throw new Error('failed to bind fake DNS server');
  return { socket, port: address.port };
}

interface Child {
  proc: ChildProcess;
  port: number;
  output: string[];
}

describe.skipIf(baseUrl === undefined)('DNSBL (PST-T-2.9)', () => {
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  async function spawnMain(env: Record<string, string>): Promise<Child> {
    const proc = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/main.ts'], {
      cwd: appDir,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    const output: string[] = [];
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));
    const lines = createInterface({ input: proc.stdout });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`smtp-in did not start: ${output.join('')}`)); }, 30_000);
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

  /** Waits for the process to exit on its own (a boot failure), collecting stdout+stderr. */
  async function spawnExpectingBootFailure(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
    const proc = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/main.ts'], {
      cwd: appDir,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    const output: string[] = [];
    proc.stdout.on('data', (d: Buffer) => output.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`expected a boot failure, got none: ${output.join('')}`)); }, 30_000);
      proc.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, output: output.join('') };
  }

  describe('boot-time resolver trust (PST-REQ-063)', () => {
    it('a config pointing at a public resolver (1.1.1.1) fails to boot, naming DNS_RESOLVER', async () => {
      const { code, output } = await spawnExpectingBootFailure({
        DATABASE_URL: baseUrl ?? '',
        BLOB_ROOT: mkdtempSync(join(tmpdir(), 'smtp-in-dnsbl-boot-')),
        POSTROOM_KEK: exportKekBase64(generateKek()),
        SMTP_PORT: '0',
        LISTEN_HOST: '127.0.0.1',
        HEALTH_PORT: '0',
        MX_HOSTNAME: 'mx.d3cloud.io',
        DNS_RESOLVER: '1.1.1.1:53',
      });
      expect(code).not.toBe(0);
      expect(output).toMatch(/DNSBL requires our own validating resolver/);
      expect(output).toMatch(/DNS_RESOLVER/);
    });

    it('a config pointing at our own resolver (127.0.0.1) boots normally', async () => {
      const dns = await startFakeDns('203.0.113.9');
      try {
        const child = await spawnMain({
          DATABASE_URL: baseUrl ?? '',
          BLOB_ROOT: mkdtempSync(join(tmpdir(), 'smtp-in-dnsbl-boot-ok-')),
          POSTROOM_KEK: exportKekBase64(generateKek()),
          SMTP_PORT: '0',
          LISTEN_HOST: '127.0.0.1',
          HEALTH_PORT: '0',
          MX_HOSTNAME: 'mx.d3cloud.io',
          DNS_RESOLVER: `127.0.0.1:${String(dns.port)}`,
        });
        expect(child.port).toBeGreaterThan(0);
      } finally {
        dns.socket.close();
      }
    });
  });

  describe('end-of-DATA rejection (PST-REQ-058)', () => {
    let t: TestDatabase;
    let blobRoot = '';
    let dns: { socket: UdpSocket; port: number };
    let child: Child;
    const kek = generateKek();
    const LISTED_IP = '127.0.0.2'; // Spamhaus's own reserved, always-listed SBL test address.
    // Also a loopback address (private, so greylisting never applies here) but not the listed one —
    // isolates the DNSBL verdict from PST-REQ-062's separate greylist policy.
    const UNLISTED_IP = '127.0.0.3';

    beforeAll(async () => {
      t = await createTestDatabase(baseUrl ?? '', 'pst_t29');
      const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
      await t.db.address.create({ data: { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId } });
      blobRoot = mkdtempSync(join(tmpdir(), 'smtp-in-dnsbl-'));
      dns = await startFakeDns(LISTED_IP);
      child = await spawnMain({
        DATABASE_URL: t.url,
        BLOB_ROOT: blobRoot,
        POSTROOM_KEK: exportKekBase64(kek),
        SMTP_PORT: '0',
        LISTEN_HOST: '127.0.0.1',
        HEALTH_PORT: '0',
        MX_HOSTNAME: 'mx.d3cloud.io',
        DNS_RESOLVER: `127.0.0.1:${String(dns.port)}`,
        EDGE_PEER_ADDRESS: '127.0.0.1',
        PROXY_TIMEOUT_MS: '2000',
      });
    }, 120_000);

    afterAll(async () => {
      dns.socket.close();
      await t.drop();
      rmSync(blobRoot, { recursive: true, force: true });
    });

    function proxyHeader(source: string): Buffer {
      return encodeProxyV2({
        command: 'PROXY',
        family: 'TCP4',
        source: { address: source, port: 40_000 },
        destination: { address: '127.0.0.1', port: 25 },
      });
    }

    async function transaction(source: string): Promise<TestClient> {
      const c = await TestClient.open(child.port, proxyHeader(source));
      expect((await c.next()).code).toBe(220);
      expect((await c.cmd('EHLO sender.example')).code).toBe(250);
      expect(codeOf(await c.cmd('MAIL FROM:<bob@sender.example>'))).toBe('250 2.1.0');
      expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
      const r = await c.cmd('DATA');
      expect(r.code).toBe(354);
      return c;
    }

    it('an SBL-listed client IP is 554 5.7.1 at DATA, naming the list', async () => {
      const c = await transaction(LISTED_IP);
      c.write('Subject: hi\r\n\r\nhello\r\n.\r\n');
      const r = await c.next();
      expect(codeOf(r)).toBe('554 5.7.1');
      expect(r.lines.join(' ')).toMatch(/SBL/);
      await c.quit();
    });

    it('an unlisted client IP is accepted', async () => {
      const c = await transaction(UNLISTED_IP);
      c.write('Subject: hi\r\n\r\nhello\r\n.\r\n');
      const r = await c.next();
      expect(codeOf(r)).toBe('250 2.0.0');
      await c.quit();
    });
  });
});
