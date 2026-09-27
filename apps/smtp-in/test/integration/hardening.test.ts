// PST-T-11.12: smtp-in hardening, through the real daemon (src/main.ts under tsx, spawned exactly as
// production runs it) against a real database and a fake DNS server.
//
//   PST-REQ-184  header From at one of our domains without an aligned SPF or DKIM pass → 550 5.7.1
//                at end of DATA, the reason stored on the InboundMessage row; aligned mail is
//                accepted (our domain publishes p=none here, as d3cloud.io does).
//   PST-REQ-058  a DNSBL-listed client is 554 at MAIL FROM, not after DATA.
//   PST-REQ-185  more than SMTP_IN_CONN_PER_MIN connections a minute from one /24 → 421 4.7.0 at
//                connect; more than SMTP_IN_UNKNOWN_RCPT_PER_10MIN unknown recipients → 421 and a
//                disconnect, and the /24 is refused at connect; both reset after the window. The
//                limits are the defaults (30 and 20); only the windows are shortened, so the test
//                need not wait ten minutes.
//
// Client addresses arrive in PROXY v2 headers from the trusted edge peer (loopback here), which is
// also how the limits are proven to count the real client's address rather than the edge's: every
// connection in this file comes from 127.0.0.1.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dnsRecordFor, signMessage } from '@postroom/auth-checks';
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
const WINDOW_MS = 6_000;

// Loopback addresses are private: never greylisted and exempt from the rate limits, so the
// PST-REQ-184 and DNSBL cases are isolated from both.
const LISTED_IP = '127.0.0.2'; // Spamhaus's own always-listed SBL test address.
const OUR_RELAY_IP = '127.0.0.4'; // in d3cloud.io's SPF record
const STRANGER_IP = '127.0.0.6';

function normalise(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function response(query: DnsMessage, rcode: number, answers: { type: number; rdata: Buffer }[]): Buffer {
  const question = query.questions[0];
  if (!question) throw new Error('no question in query');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2); // QR=1, RD=1, RA=1
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const qName = Buffer.from(encodeName(question.name));
  const qTail = Buffer.alloc(4);
  qTail.writeUInt16BE(question.type, 0);
  qTail.writeUInt16BE(DNS_CLASS_IN, 2);
  const rrs = answers.map((a) => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(a.type, 0);
    head.writeUInt16BE(DNS_CLASS_IN, 2);
    head.writeUInt32BE(60, 4);
    head.writeUInt16BE(a.rdata.length, 8);
    return Buffer.concat([Buffer.from(encodeName(question.name)), head, a.rdata]);
  });
  return Buffer.concat([header, qName, qTail, ...rrs]);
}

/** TXT rdata: the text as <=255-octet character-strings. */
function txtRdata(text: string): Buffer {
  const bytes = Buffer.from(text, 'latin1');
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat(parts);
}

/** A records (DNSBL listings) and TXT records by name; NXDOMAIN for everything else. */
async function startFakeDns(a: Record<string, string>, txt: Record<string, string>): Promise<{ socket: UdpSocket; port: number }> {
  const socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const decoded = decodeMessage(msg);
    if (!decoded.ok) return;
    const q = decoded.message.questions[0];
    if (!q) return;
    const name = normalise(q.name);
    const aHit = q.type === RRType.A ? a[name] : undefined;
    const txtHit = q.type === RRType.TXT ? txt[name] : undefined;
    const out =
      aHit !== undefined
        ? response(decoded.message, 0, [{ type: RRType.A, rdata: Buffer.from(aHit.split('.').map(Number)) }])
        : txtHit !== undefined
          ? response(decoded.message, 0, [{ type: RRType.TXT, rdata: txtRdata(txtHit) }])
          : response(decoded.message, 3, []);
    socket.send(out, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => {
    socket.bind(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (typeof address !== 'object') throw new Error('failed to bind fake DNS server');
  return { socket, port: address.port };
}

function proxyHeader(source: string): Buffer {
  return encodeProxyV2({
    command: 'PROXY',
    family: 'TCP4',
    source: { address: source, port: 40_000 },
    destination: { address: '127.0.0.1', port: 25 },
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe.skipIf(baseUrl === undefined)('smtp-in hardening (PST-T-11.12)', () => {
  let t: TestDatabase;
  let blobRoot = '';
  let dns: { socket: UdpSocket; port: number };
  let proc: ChildProcess;
  let port = 0;
  let dkimKey: KeyObject;
  const output: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1112');
    const { domainId, operatorId } = await seed(t.db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    await t.db.address.create({ data: { localPart: 'matt', domainId, kind: 'primary', accountId: operatorId } });
    blobRoot = mkdtempSync(join(tmpdir(), 'smtp-in-hardening-'));
    dkimKey = generateKeyPairSync('ed25519').privateKey;
    dns = await startFakeDns(
      { [normalise(dnsblQueryName(LISTED_IP, ZONE))]: '127.0.0.2' },
      {
        // Our own domain publishes p=none — exactly why DMARC alone let forgeries in.
        '_dmarc.d3cloud.io': 'v=DMARC1; p=none',
        'd3cloud.io': `v=spf1 ip4:${OUR_RELAY_IP} -all`,
        'test._domainkey.d3cloud.io': dnsRecordFor('ed25519-sha256', dkimKey),
      },
    );
    proc = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/main.ts'], {
      cwd: appDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: t.url,
        BLOB_ROOT: blobRoot,
        POSTROOM_KEK: exportKekBase64(generateKek()),
        SMTP_PORT: '0',
        LISTEN_HOST: '127.0.0.1',
        HEALTH_PORT: '0',
        MX_HOSTNAME: 'mx.d3cloud.io',
        DNS_RESOLVER: `127.0.0.1:${String(dns.port)}`,
        EDGE_PEER_ADDRESS: '127.0.0.1',
        PROXY_TIMEOUT_MS: '2000',
        // The limits stay at their defaults (30 / 20); only the windows shrink.
        SMTP_IN_CONN_WINDOW_MS: String(WINDOW_MS),
        SMTP_IN_UNKNOWN_RCPT_WINDOW_MS: String(WINDOW_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr?.on('data', (d: Buffer) => output.push(d.toString()));
    const lines = createInterface({ input: proc.stdout ?? process.stdin });
    port = await new Promise<number>((resolve, reject) => {
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
  }, 120_000);

  afterAll(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => { resolve(); }));
      proc.kill('SIGKILL');
      await exited;
    }
    dns.socket.close();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  async function open(source: string): Promise<{ c: TestClient; greeting: string }> {
    const c = await TestClient.open(port, proxyHeader(source));
    return { c, greeting: codeOf(await c.next()) };
  }

  describe('own-domain From without an aligned pass (PST-REQ-184)', () => {
    function message(subject: string): string {
      return (
        'From: The Boss <boss@d3cloud.io>\r\n' +
        'To: matt@d3cloud.io\r\n' +
        `Subject: ${subject}\r\n` +
        'Date: Sun, 27 Sep 2026 12:00:00 +0000\r\n' +
        `Message-ID: <${subject.replace(/\W/g, '')}@example>\r\n` +
        '\r\n' +
        'please wire the money\r\n'
      );
    }

    async function send(source: string, mailFrom: string, data: string): Promise<{ code: string; text: string }> {
      const { c, greeting } = await open(source);
      expect(greeting).toBe('220');
      expect((await c.cmd('EHLO sender.example')).code).toBe(250);
      expect(codeOf(await c.cmd(`MAIL FROM:<${mailFrom}>`))).toBe('250 2.1.0');
      expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('250 2.1.5');
      expect((await c.cmd('DATA')).code).toBe(354);
      c.write(`${data}.\r\n`);
      const r = await c.next();
      await c.quit();
      return { code: codeOf(r), text: r.lines.join(' ') };
    }

    it('a stranger forging From: boss@d3cloud.io is 550 5.7.1 at end of DATA, with the reason stored', async () => {
      const r = await send(STRANGER_IP, 'attacker@evil.example', message('forged'));
      expect(r.code).toBe('550 5.7.1');
      expect(r.text).toMatch(/d3cloud\.io/);
      const row = await t.db.inboundMessage.findFirst({ where: { envelopeFrom: 'attacker@evil.example' }, orderBy: { receivedAt: 'desc' } });
      expect(row?.state).toBe('rejected');
      expect(row?.disposition).toBe('reject');
      expect(row?.dispositionReason).toMatch(/header From d3cloud\.io is one of our domains but has neither an aligned SPF pass nor an aligned DKIM pass/);
      expect(row?.smtpReply).toMatch(/^550 5\.7\.1 /);
      const verdicts = row?.verdicts as { decision?: { rule?: string }; dmarc?: { disposition?: string } } | undefined;
      expect(verdicts?.decision?.rule).toBe('own-domain-unauthenticated');
      // DMARC on its own would have let it in: our record is p=none.
      expect(verdicts?.dmarc?.disposition).toBe('none');
    });

    it('using our domain as the envelope sender from an address our SPF does not list is still 550', async () => {
      const r = await send(STRANGER_IP, 'boss@d3cloud.io', message('forged-envelope'));
      expect(r.code).toBe('550 5.7.1');
    });

    it('our own mail back through an external relay — DKIM d=d3cloud.io passes — is accepted', async () => {
      const raw = message('signed');
      const sigs = await signMessage(Buffer.from(raw, 'latin1'), { domain: 'd3cloud.io', keys: [{ selector: 'test', algorithm: 'ed25519-sha256', privateKey: dkimKey }] });
      const r = await send(STRANGER_IP, 'bounces@relay.example', sigs.join('') + raw);
      expect(r.code).toBe('250 2.0.0');
      const row = await t.db.inboundMessage.findFirst({ where: { envelopeFrom: 'bounces@relay.example' } });
      expect(row?.state).toBe('spooled');
      expect(row?.dispositionReason).toMatch(/DKIM pass for d=d3cloud\.io, relaxedly aligned/);
    });

    it('an aligned SPF pass (a host our SPF record lists) is accepted', async () => {
      const r = await send(OUR_RELAY_IP, 'bounce@d3cloud.io', message('spf-aligned'));
      expect(r.code).toBe('250 2.0.0');
    });

    it('a foreign From domain is untouched by the rule', async () => {
      const r = await send(STRANGER_IP, 'someone@elsewhere.example', message('foreign').replace('boss@d3cloud.io', 'someone@elsewhere.example'));
      expect(r.code).toBe('250 2.0.0');
    });
  });

  describe('DNSBL at MAIL FROM (PST-REQ-058)', () => {
    it('a listed client is 554 5.7.1 at MAIL FROM, naming the list, and no message is stored', async () => {
      const before = await t.db.inboundMessage.count();
      const { c, greeting } = await open(LISTED_IP);
      expect(greeting).toBe('220');
      expect((await c.cmd('EHLO sender.example')).code).toBe(250);
      // Sent straight after EHLO: the lookup that began at connect is awaited, not raced.
      const r = await c.cmd('MAIL FROM:<bob@sender.example>');
      expect(codeOf(r)).toBe('554 5.7.1');
      expect(r.lines.join(' ')).toMatch(/SBL/);
      // No transaction was opened.
      expect(codeOf(await c.cmd('RCPT TO:<matt@d3cloud.io>'))).toBe('503 5.5.1');
      await c.quit();
      expect(await t.db.inboundMessage.count()).toBe(before);
    });
  });

  describe('per-/24 rate limits (PST-REQ-185)', () => {
    it('the 31st connection in a minute from one /24 is 421 4.7.0 at connect; another /24 is not; it resets after the window', async () => {
      const started = Date.now();
      // Thirty different hosts in the block, all at once: one /24, one counter.
      const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => open(`198.51.100.${String(i + 1)}`)));
      expect(burst.map((b) => b.greeting)).toEqual(Array<string>(30).fill('220'));
      await Promise.all(burst.map((b) => b.c.quit()));
      const over = await open('198.51.100.200');
      expect(over.greeting).toBe('421 4.7.0');
      expect(await over.c.closed()).toBe(true);
      const elsewhere = await open('198.51.101.1');
      expect(elsewhere.greeting).toBe('220');
      await elsewhere.c.quit();
      // The whole burst had to land inside one window for the assertion above to mean anything.
      expect(Date.now() - started).toBeLessThan(WINDOW_MS);

      await sleep(WINDOW_MS + 250);
      const after = await open('198.51.100.200');
      expect(after.greeting).toBe('220');
      await after.c.quit();
    }, 30_000);

    it('the 21st unknown recipient from one /24 is 421 and a disconnect; the /24 is refused at connect until the window passes', async () => {
      const started = Date.now();
      const { c, greeting } = await open('203.0.113.10');
      expect(greeting).toBe('220');
      expect((await c.cmd('EHLO harvester.example')).code).toBe(250);
      expect(codeOf(await c.cmd('MAIL FROM:<h@harvester.example>'))).toBe('250 2.1.0');
      for (let i = 1; i <= 20; i++) {
        expect(codeOf(await c.cmd(`RCPT TO:<guess${String(i)}@d3cloud.io>`)), `guess ${String(i)}`).toBe('550 5.1.1');
      }
      const r = await c.cmd('RCPT TO:<guess21@d3cloud.io>');
      expect(codeOf(r)).toBe('421 4.7.0');
      expect(r.lines.join(' ')).toMatch(/unknown recipients/i);
      expect(await c.closed()).toBe(true);

      const again = await open('203.0.113.99');
      expect(again.greeting).toBe('421 4.7.0');
      expect(await again.c.closed()).toBe(true);
      expect(Date.now() - started).toBeLessThan(WINDOW_MS);

      await sleep(WINDOW_MS + 250);
      const after = await open('203.0.113.99');
      expect(after.greeting).toBe('220');
      expect((await after.c.cmd('EHLO harvester.example')).code).toBe(250);
      expect(codeOf(await after.c.cmd('MAIL FROM:<h@harvester.example>'))).toBe('250 2.1.0');
      expect(codeOf(await after.c.cmd('RCPT TO:<guess22@d3cloud.io>'))).toBe('550 5.1.1');
      await after.c.quit();
    }, 30_000);

    it('pipelined RCPTs past the limit get exactly one 421 and nothing after it', async () => {
      await sleep(WINDOW_MS + 250); // let the previous test's window lapse
      const { c, greeting } = await open('192.0.2.10');
      expect(greeting).toBe('220');
      expect((await c.cmd('EHLO harvester.example')).code).toBe(250);
      expect(codeOf(await c.cmd('MAIL FROM:<h@harvester.example>'))).toBe('250 2.1.0');
      c.write(Array.from({ length: 25 }, (_, i) => `RCPT TO:<p${String(i)}@d3cloud.io>\r\n`).join(''));
      const codes: string[] = [];
      for (;;) {
        try {
          codes.push(codeOf(await c.next()));
        } catch {
          break;
        }
      }
      expect(codes.slice(0, 20)).toEqual(Array<string>(20).fill('550 5.1.1'));
      expect(codes.slice(20)).toEqual(['421 4.7.0']);
    }, 30_000);
  });
});
