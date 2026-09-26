// The direct MX client against a scriptable loopback MX: what the remote sees (source address,
// transcript, unstuffed body) and what the attempt records (localIp, TLS version and cipher).
//
// PST-T-1.6 doneWhen, as far as it can be shown before the Lightsail edge exists: the test MX logs
// the client's source address and every attempt records its localIp. On the host the same code runs
// inside the WireGuard sidecar's netns, localIp is the tunnel address and the remote logs the edge IP.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connector } from '../../src/client/connection.js';
import { fakeResolver, startFakeMx, type FakeMx, type FakeMxScript, type FakeMxTls } from '../../src/client/fake-mx.js';
import { createDirectTransport, type DirectTransportOptions } from '../../src/client/transport.js';
import type { DeliveryRecipient, DeliveryRequest } from '../../src/transports/types.js';

const BODY = 'From: me@d3cloud.io\r\nTo: you@mx.test\r\nSubject: hi\r\n\r\nhello\r\n';

let certDir: string | undefined;
let tlsConfig: FakeMxTls | undefined;
try {
  certDir = mkdtempSync(path.join(tmpdir(), 'pst-t16-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=mx.fake.test',
  ], { stdio: 'ignore' });
  tlsConfig = { key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) };
} catch (error) {
  console.warn(`openssl unavailable, skipping the STARTTLS tests: ${error instanceof Error ? error.message : String(error)}`);
}

const DNS = { mx: { 'mx.test': [{ preference: 10, exchange: 'mx.fake.test' }] }, a: { 'mx.fake.test': ['127.0.0.1'] } };
const noLog = (): void => undefined;

function request(overrides: Partial<DeliveryRequest> = {}, body: () => Readable = () => Readable.from([Buffer.from(BODY)])): DeliveryRequest {
  return {
    envelopeFrom: 'me@d3cloud.io',
    domain: 'mx.test',
    recipients: [{ id: 'r1', address: 'you@mx.test', notify: null }],
    message: () => Promise.resolve(body()),
    size: BODY.length,
    dsnRet: null,
    dsnEnvid: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const opened: FakeMx[] = [];
async function mx(script: FakeMxScript = {}, withTls?: FakeMxTls): Promise<FakeMx> {
  const m = await startFakeMx(script, withTls);
  opened.push(m);
  return m;
}

function transportFor(m: FakeMx, extra: Partial<DirectTransportOptions> = {}): ReturnType<typeof createDirectTransport> {
  return createDirectTransport({ resolver: fakeResolver(DNS), port: m.port, log: noLog, ...extra });
}

afterAll(async () => {
  for (const m of opened) await m.close();
  if (certDir !== undefined) rmSync(certDir, { recursive: true, force: true });
});

describe('direct MX client: plaintext', () => {
  it('the test MX logs the client source address; the attempt records localIp, mxHost and mxIp', async () => {
    const m = await mx();
    const result = await transportFor(m).deliver(request());
    expect(result.results).toEqual({ r1: { kind: 'delivered', code: 250, enhanced: '2.0.0', text: 'queued as FAKE' } });
    const session = m.sessions[0];
    await session?.closed;
    expect(session?.remoteAddress).toBe('127.0.0.1');
    expect(result.details).toEqual({ mxHost: 'mx.fake.test', mxIp: '127.0.0.1', localIp: '127.0.0.1' });
    expect(session?.transcript.filter((l) => l.startsWith('C: '))).toEqual([
      'C: EHLO mx.d3cloud.io',
      'C: MAIL FROM:<me@d3cloud.io> BODY=8BITMIME',
      'C: RCPT TO:<you@mx.test>',
      'C: DATA',
      'C: .',
      'C: QUIT',
    ]);
    expect(session?.body).toBe(BODY);
  });

  it('falls back to HELO when EHLO is not understood', async () => {
    const m = await mx({ ehloReply: '502 5.5.1 EHLO not implemented' });
    const result = await transportFor(m).deliver(request());
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(m.sessions[0]?.transcript).toContain('C: HELO mx.d3cloud.io');
    expect(m.sessions[0]?.mailFrom).toBe('MAIL FROM:<me@d3cloud.io>');
  });

  it('a 421 greeting moves on to the next MX', async () => {
    const busy = await mx({ greeting: ['421 4.3.2 too busy'] });
    const good = await mx();
    const ports: Record<string, number> = { '192.0.2.1': busy.port, '192.0.2.2': good.port };
    const connect: Connector = (o) => new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: ports[o.host] ?? 1 }, () => { resolve(s); });
      s.once('error', reject);
    });
    const result = await createDirectTransport({
      resolver: fakeResolver({ mx: { 'two.test': [{ preference: 1, exchange: 'a.two.test' }, { preference: 2, exchange: 'b.two.test' }] }, a: { 'a.two.test': ['192.0.2.1'], 'b.two.test': ['192.0.2.2'] } }),
      connect,
      log: noLog,
    }).deliver(request({ domain: 'two.test', recipients: [{ id: 'r1', address: 'you@two.test', notify: null }] }));
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(result.details.mxHost).toBe('b.two.test');
    expect(busy.sessions[0]?.transcript.some((l) => l.startsWith('C: MAIL'))).toBe(false);
  });

  it('mixed RCPT replies give each recipient its own outcome; NOTIFY is passed on when DSN is advertised', async () => {
    const m = await mx({
      capabilities: () => ['DSN', '8BITMIME'],
      rcpt: (to) => (to.startsWith('ok') ? '250 2.1.5 ok' : to.startsWith('gone') ? '550 5.1.1 no such user' : '451 4.2.0 try later'),
    });
    const recipients: DeliveryRecipient[] = [
      { id: 'ok', address: 'ok@mx.test', notify: 'SUCCESS,FAILURE' },
      { id: 'gone', address: 'gone@mx.test', notify: null },
      { id: 'later', address: 'later@mx.test', notify: null },
    ];
    const result = await transportFor(m).deliver(request({ recipients, dsnRet: 'HDRS', dsnEnvid: 'env 1' }));
    expect(result.results).toEqual({
      ok: { kind: 'delivered', code: 250, enhanced: '2.0.0', text: 'queued as FAKE' },
      gone: { kind: 'permanent', code: 550, enhanced: '5.1.1', text: 'no such user' },
      later: { kind: 'temporary', code: 451, enhanced: '4.2.0', text: 'try later' },
    });
    const t = m.sessions[0]?.transcript ?? [];
    expect(t).toContain('C: MAIL FROM:<me@d3cloud.io> BODY=8BITMIME RET=HDRS ENVID=env+201');
    expect(t).toContain('C: RCPT TO:<ok@mx.test> NOTIFY=SUCCESS,FAILURE');
    expect(m.sessions[0]?.rcptTo).toEqual(['ok@mx.test']);
  });

  it('a final 451 to DATA is temporary for every accepted recipient; rejected ones keep their own reply', async () => {
    const m = await mx({ rcpt: (to) => (to.startsWith('gone') ? '550 5.1.1 no' : '250 ok'), final: () => '451 4.3.0 queue full' });
    const result = await transportFor(m).deliver(request({
      recipients: [{ id: 'a', address: 'a@mx.test', notify: null }, { id: 'b', address: 'b@mx.test', notify: null }, { id: 'gone', address: 'gone@mx.test', notify: null }],
    }));
    expect(result.results['a']).toEqual({ kind: 'temporary', code: 451, enhanced: '4.3.0', text: 'queue full' });
    expect(result.results['b']).toEqual(result.results['a']);
    expect(result.results['gone']).toMatchObject({ kind: 'permanent', code: 550 });
  });

  it('no accepted recipient: no DATA is sent', async () => {
    const m = await mx({ rcpt: () => '550 5.1.1 no' });
    const result = await transportFor(m).deliver(request());
    expect(result.results['r1']).toMatchObject({ kind: 'permanent', code: 550 });
    expect(m.sessions[0]?.transcript).not.toContain('C: DATA');
  });

  it('a slow MX trips the command timeout: an error (retried later), promptly', async () => {
    const m = await mx({ delayMs: { mail: 5_000 } });
    const started = Date.now();
    const result = await transportFor(m, { timeouts: { mail: 150 } }).deliver(request());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.results['r1']).toMatchObject({ kind: 'error' });
    expect(result.results['r1']?.kind === 'error' && result.results['r1'].error).toMatch(/mail: no reply within 150 ms/);
    expect(result.details.localIp).toBe('127.0.0.1');
  });

  it('an abort mid-DATA gives up at once, without sending the terminator', async () => {
    const m = await mx({ throttleMs: 5 });
    const controller = new AbortController();
    const chunk = Buffer.from(`${'y'.repeat(1022)}\r\n`.repeat(16));
    // An endless, slow body: the attempt can only end by being aborted.
    const endless = (): Readable => new Readable({
      read() { setTimeout(() => { this.push(chunk); }, 2); },
    });
    const pending = transportFor(m).deliver(request({ signal: controller.signal }, endless));
    for (let i = 0; i < 200 && (m.sessions[0]?.bodyBytes ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(m.sessions[0]?.bodyBytes).toBeGreaterThan(0);
    const abortedAt = Date.now();
    controller.abort(new Error('attempt timed out after 240000 ms'));
    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(result.results['r1']).toMatchObject({ kind: 'error' });
    expect(result.results['r1']?.kind === 'error' && result.results['r1'].error).toMatch(/attempt timed out/);
    await m.sessions[0]?.closed;
    expect(m.sessions[0]?.dataComplete).toBe(false);
  });

  it('dot-stuffing: lines starting with a dot arrive intact after the MX unstuffs them', async () => {
    const m = await mx();
    const body = 'Subject: dots\r\n\r\n.hidden\r\n..two\r\n.\r\nend\r\n';
    // Split so a leading dot lands at the start of a chunk.
    const result = await transportFor(m).deliver(request({ size: body.length }, () => Readable.from([Buffer.from(body.slice(0, 18)), Buffer.from(body.slice(18))])));
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(m.sessions[0]?.body).toBe(body);
  });

  it('streams a 20 MB message with backpressure: never far ahead of what the MX has read', async () => {
    const m = await mx({ throttleMs: 1, keepBodyBytes: 0 });
    const chunk = Buffer.from(`${'z'.repeat(998)}\r\n`.repeat(64)); // 64,000 bytes, allocated once
    const total = chunk.length * 328; // 20,992,000 bytes
    let generated = 0;
    let maxLead = 0;
    const big = (): Readable => new Readable({
      read() {
        if (generated >= total) { this.push(null); return; }
        maxLead = Math.max(maxLead, generated - (m.sessions[0]?.bodyBytes ?? 0));
        generated += chunk.length;
        this.push(chunk);
      },
    });
    const result = await transportFor(m).deliver(request({ size: total }, big));
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(m.sessions[0]?.bodyBytes).toBe(total);
    // A client that ignored backpressure would read the whole 20 MB before the MX saw any of it.
    expect(maxLead).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);
});

describe.skipIf(tlsConfig === undefined)('direct MX client: STARTTLS (PST-REQ-035)', () => {
  let tlsOpts: FakeMxTls;
  beforeAll(() => { if (tlsConfig !== undefined) tlsOpts = tlsConfig; });

  it('upgrades when offered and records TLS version, cipher and peer; pre-TLS capabilities are discarded', async () => {
    // Before TLS the MX offers DSN; after it, SIZE and 8BITMIME only. The MAIL line must follow the latter.
    const m = await mx({ capabilities: (secure) => (secure ? ['SIZE 100000000', '8BITMIME'] : ['DSN']) }, tlsOpts);
    const result = await transportFor(m).deliver(request({ dsnRet: 'FULL', dsnEnvid: 'abc' }));
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(result.details.tlsVersion).toBe('TLSv1.3');
    expect(result.details.tlsCipher).toMatch(/^TLS_/);
    expect(result.details.tlsPeer).toMatch(/CN=mx\.fake\.test/);
    expect(result.details.tlsPeer).toMatch(/verified=false; reason=/);
    expect(result.details.localIp).toBe('127.0.0.1');
    const session = m.sessions[0];
    expect(session?.secure).toBe(true);
    expect(session?.tlsProtocol).toBe('TLSv1.3');
    expect(session?.remoteAddress).toBe('127.0.0.1');
    const commands = session?.transcript.filter((l) => l.startsWith('C: ')) ?? [];
    expect(commands.slice(0, 4)).toEqual([
      'C: EHLO mx.d3cloud.io',
      'C: STARTTLS',
      'C: EHLO mx.d3cloud.io',
      `C: MAIL FROM:<me@d3cloud.io> SIZE=${BODY.length} BODY=8BITMIME`,
    ]);
    expect(session?.body).toBe(BODY);
  });

  it('records TLSv1.2 when that is the best the MX offers', async () => {
    const m = await mx({}, { ...tlsOpts, maxVersion: 'TLSv1.2' });
    const result = await transportFor(m).deliver(request());
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(result.details.tlsVersion).toBe('TLSv1.2');
    expect(result.details.tlsCipher).toMatch(/ECDHE/);
  });

  it('verifies against a trusted CA when one is given, and says so', async () => {
    const m = await mx({}, tlsOpts);
    const result = await transportFor(m, { tlsOptions: { ca: tlsOpts.cert } }).deliver(request());
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(result.details.tlsPeer).toMatch(/verified=true$/);
  });
});
