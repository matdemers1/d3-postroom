// PST-T-4.17 / PST-REQ-016 over real loopback sockets with real TLS and a real database: from the edge
// peer (loopback stands in for 10.77.0.1 here) submission requires a PROXY v2 header on 587 and on
// 465 — read before the handshake, including when the header and the ClientHello arrive in one
// write — and the header's source is the address the throttle, the audit rows, the logs and the
// transcript see. From anyone else a PROXY header closes the connection, and a direct connection is
// served exactly as before.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { encodeProxyV2 } from '@postroom/proxy-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners, type SubmissionOptions } from '../../src/server.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;

function v2(source: string, port = 587): Buffer {
  return encodeProxyV2({
    command: 'PROXY',
    family: 'TCP4',
    source: { address: source, port: 40_000 },
    destination: { address: '10.77.0.2', port },
  });
}
const V1 = (source: string): Buffer => Buffer.from(`PROXY TCP4 ${source} 10.77.0.2 40000 587\r\n`);

async function listenOn(server: Server | null): Promise<number> {
  if (server === null) throw new Error('listener missing');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(baseUrl === undefined)('submission behind the edge: PROXY v2 on 587 and 465 (PST-T-4.17)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let edge: SubmissionListeners;
  let direct: SubmissionListeners;
  const ports = { edge587: 0, edge465: 0, direct587: 0, direct465: 0 };
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let account: { address: string; appPassword: string };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t417');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    dir = await mkdtemp(join(tmpdir(), 'pst-t417-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');

    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const acct = await db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword('web password', PEPPER) } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: acct.id } });
    const created = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'Thunderbird', scopes: ['smtp'] }, { pepper: PEPPER });
    account = { address: `${login}@d3cloud.io`, appPassword: created.password };

    const base: SubmissionOptions = {
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 10,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
      log: (event, fields = {}) => logs.push({ event, fields }),
    };
    // Loopback is the edge peer for these listeners...
    edge = createSubmissionListeners({ ...base, edgePeers: ['127.0.0.1'], proxyTimeoutMs: 300 });
    ports.edge587 = await listenOn(edge.submission);
    ports.edge465 = await listenOn(edge.submissions);
    // ...and not for these (the production default, 10.77.0.1).
    direct = createSubmissionListeners({ ...base, edgePeers: ['10.77.0.1'] });
    ports.direct587 = await listenOn(direct.submission);
    ports.direct465 = await listenOn(direct.submissions);
  }, 120_000);

  afterAll(async () => {
    await edge.close();
    await direct.close();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const authPlain = (c: SmtpTestClient, user: string, password: string) => c.send(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`);

  async function failuresFrom(ip: string): Promise<number> {
    return db.auditEvent.count({ where: { action: 'auth.failure', ip } });
  }

  async function transcriptFrom(ip: string): Promise<boolean> {
    return (await db.smtpTranscript.count({ where: { daemon: 'submission', clientIp: ip } })) > 0;
  }

  // --- via the edge peer ----------------------------------------------------------------------

  it('587 via the edge: header, then EHLO → STARTTLS → AUTH; throttle, audit, logs and transcript see the source', async () => {
    const src = '198.51.100.41';
    const c = await SmtpTestClient.plain(ports.edge587, v2(src));
    expect((await c.next()).code).toBe(220);
    const ehlo = await c.send('EHLO client.test');
    expect(ehlo.lines).toContain('STARTTLS');
    expect((await c.startTls()).code).toBe(220);
    expect(c.encrypted).toBe(true);
    expect((await c.send('EHLO client.test')).lines).toContain('AUTH PLAIN LOGIN');
    expect((await authPlain(c, account.address, 'not the password')).code).toBe(535);
    expect((await authPlain(c, account.address, account.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${account.address}>`)).code).toBe(250);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();

    expect(await failuresFrom(src)).toBe(1);
    expect(logs.some((l) => l.event === 'auth' && l.fields['ip'] === src && l.fields['ok'] === true)).toBe(true);
    expect(logs.some((l) => l.event === 'connection' && l.fields['clientIp'] === src && l.fields['via'] === 'proxy')).toBe(true);
    expect(await eventually(() => transcriptFrom(src))).toBe(true);
  });

  it('465 via the edge: the header in its own write, then the TLS handshake, then AUTH as the source', async () => {
    const src = '198.51.100.42';
    const c = await SmtpTestClient.implicitTls(ports.edge465, v2(src, 465));
    expect(c.encrypted).toBe(true);
    expect((await c.next()).code).toBe(220);
    const ehlo = await c.send('EHLO client.test');
    expect(ehlo.lines).toContain('AUTH PLAIN LOGIN');
    expect(ehlo.lines).not.toContain('STARTTLS');
    expect((await authPlain(c, account.address, account.appPassword)).code).toBe(235);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();
    expect(logs.some((l) => l.event === 'auth' && l.fields['ip'] === src && l.fields['ok'] === true)).toBe(true);
    expect(await eventually(() => transcriptFrom(src))).toBe(true);
  });

  it('465 via the edge: the header and the ClientHello in ONE write — the bytes past the header reach TLS', async () => {
    const src = '198.51.100.43';
    const c = await SmtpTestClient.implicitTls(ports.edge465, v2(src, 465), true);
    expect(c.encrypted).toBe(true);
    expect((await c.next()).code).toBe(220);
    expect((await c.send('EHLO client.test')).lines).toContain('AUTH PLAIN LOGIN');
    expect((await authPlain(c, account.address, 'wrong')).code).toBe(535);
    c.close();
    expect(await failuresFrom(src)).toBe(1);
    expect(await failuresFrom('127.0.0.1')).toBe(0);
  });

  const REFUSED: readonly (readonly [string, Buffer | null])[] = [
    ['no header within the timeout', null],
    ['SMTP before the header', Buffer.concat([Buffer.from('EHLO x\r\n'), v2('198.51.100.44')])],
    ['a v1 text header', V1('198.51.100.44')],
    ['a LOCAL header', encodeProxyV2({ command: 'LOCAL', family: 'UNSPEC' })],
    ['garbage', Buffer.from('\x16\x03\x01garbage that is not a PROXY header at all\r\n', 'latin1')],
  ];

  for (const [what, bytes] of REFUSED) {
    for (const port of ['edge587', 'edge465'] as const) {
      it(`${port === 'edge587' ? '587' : '465'} via the edge: ${what} → closed without a greeting`, async () => {
        const c = await SmtpTestClient.plain(ports[port], bytes ?? undefined);
        expect(await c.closedWithin(3_000)).toBe(true);
        expect(c.pending).toEqual([]);
      });
    }
  }

  it('a refusal from the edge is logged as proxy-refused', () => {
    expect(logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('timed out'))).toBe(true);
    expect(logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('LOCAL'))).toBe(true);
  });

  // --- not the edge ---------------------------------------------------------------------------

  it('587 from a peer that is not the edge: a v2 or v1 header closes the connection; the address is never used', async () => {
    const src = '203.0.113.45';
    for (const header of [v2(src), V1(src)]) {
      const c = await SmtpTestClient.plain(ports.direct587, Buffer.concat([header, Buffer.from('EHLO spoof.example\r\n')]));
      expect(await c.closedWithin(3_000)).toBe(true);
      // At most the connect-time greeting; the header and the EHLO behind it were never commands.
      expect(c.pending.every((r) => r.code === 220)).toBe(true);
    }
    expect(logs.some((l) => l.event === 'proxy-refused' && String(l.fields['reason']).includes('not the edge'))).toBe(true);
    expect(logs.some((l) => JSON.stringify(l.fields).includes(src) && l.event !== 'proxy-refused')).toBe(false);
    expect(await transcriptFrom(src)).toBe(false);
  });

  it('465 from a peer that is not the edge: a PROXY header in place of a ClientHello fails the handshake and closes', async () => {
    const c = await SmtpTestClient.plain(ports.direct465, Buffer.concat([v2('203.0.113.46', 465), Buffer.from('EHLO x\r\n')]));
    expect(await c.closedWithin(3_000)).toBe(true);
    expect(c.pending).toEqual([]);
  });

  it('direct connections are unchanged: 587 STARTTLS and 465 implicit TLS, with the TCP peer as the client', async () => {
    const before = await failuresFrom('127.0.0.1');
    const a = await SmtpTestClient.plain(ports.direct587);
    expect((await a.next()).code).toBe(220);
    expect((await a.send('EHLO client.test')).lines).toContain('STARTTLS');
    expect((await a.startTls()).code).toBe(220);
    await a.send('EHLO client.test');
    expect((await authPlain(a, account.address, 'wrong')).code).toBe(535);
    expect((await authPlain(a, account.address, account.appPassword)).code).toBe(235);
    a.close();

    const b = await SmtpTestClient.implicitTls(ports.direct465);
    expect((await b.next()).code).toBe(220);
    await b.send('EHLO client.test');
    expect((await authPlain(b, account.address, account.appPassword)).code).toBe(235);
    b.close();
    expect(await failuresFrom('127.0.0.1')).toBe(before + 1);
  });

  it('a direct 587 session whose first line merely resembles a command is still served', async () => {
    const c = await SmtpTestClient.plain(ports.direct587, Buffer.from('EHLO early.example\r\n'));
    expect((await c.next()).code).toBe(220);
    expect((await c.next()).code).toBe(250);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();
  });
});
