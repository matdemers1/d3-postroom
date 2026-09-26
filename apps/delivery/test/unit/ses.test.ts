// The SES fallback (PST-T-1.11, PST-REQ-045) against a loopback smarthost that requires STARTTLS
// and AUTH: what reaches SES is the stored blob byte for byte (so Postroom's DKIM signature still
// verifies), credentials never travel before a verified TLS session and never reach a log, and
// replies classify exactly as they do for direct delivery.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { generateDkimKeys, signMessage, verifyLocal } from '@postroom/auth-checks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeResolver, startFakeMx, type FakeMx, type FakeMxScript, type FakeMxTls } from '../../src/client/fake-mx.js';
import { transportsFromEnv } from '../../src/transports/index.js';
import { createSesTransport, parseSesDomains, sesClaims, sesConfigFromEnv, type SesTransportOptions } from '../../src/transports/ses.js';
import type { DeliveryRequest, Transport } from '../../src/transports/types.js';
import { routeByClaims } from '../../src/worker.js';

const HOST = 'email-smtp.fake.test';
const USER = 'AKIAFAKESMTPUSER';
const PASSWORD = 'BFakeSesSmtpPassword/With+Base64=Chars';
const DNS = { a: { [HOST]: ['127.0.0.1'] } };

let certDir: string | undefined;
let tlsConfig: FakeMxTls | undefined;
let ca: Buffer | undefined;
try {
  certDir = mkdtempSync(path.join(tmpdir(), 'pst-t111-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
  ], { stdio: 'ignore' });
  ca = readFileSync(path.join(certDir, 'cert.pem'));
  tlsConfig = { key: readFileSync(path.join(certDir, 'key.pem')), cert: ca };
} catch (error) {
  console.warn(`openssl unavailable, skipping the SES smarthost tests: ${error instanceof Error ? error.message : String(error)}`);
}

// A signed message as submission stores it: a dot-led line (stuffed on the wire), 8-bit text, and
// simple/simple canonicalization, so any byte changed in transit breaks the signature.
const keys = generateDkimKeys();
const UNSIGNED = Buffer.from(
  'From: Me <me@d3cloud.io>\r\nTo: you@example.test\r\nSubject: via SES\r\nMessage-ID: <1@d3cloud.io>\r\n\r\n' +
    '.a dot-led line\r\n..two dots\r\ncafé ☃\r\n\r\ntrailing  spaces  \r\n',
  'utf8',
);
let SIGNED: Buffer = UNSIGNED;

beforeAll(async () => {
  const headers = await signMessage(UNSIGNED, {
    domain: 'd3cloud.io',
    keys: [
      { selector: 'ed', algorithm: 'ed25519-sha256', privateKey: keys.ed25519.privateKey },
      { selector: 'rsa', algorithm: 'rsa-sha256', privateKey: keys.rsa.privateKey },
    ],
    canonicalization: 'simple/simple',
    now: new Date('2026-09-26T12:00:00Z'),
  });
  SIGNED = Buffer.concat([Buffer.from(headers.join(''), 'latin1'), UNSIGNED]);
});

function request(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    envelopeFrom: 'me@d3cloud.io',
    domain: 'example.test',
    recipients: [{ id: 'r1', address: 'you@example.test', notify: null }],
    // Several chunks, split mid-line, as the blob store streams them.
    message: () => Promise.resolve(Readable.from([SIGNED.subarray(0, 7), SIGNED.subarray(7, 300), SIGNED.subarray(300)])),
    size: SIGNED.length,
    dsnRet: null,
    dsnEnvid: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const opened: FakeMx[] = [];
/** `withTls: null` = a smarthost that offers no STARTTLS at all. */
async function smarthost(script: FakeMxScript = {}, withTls: FakeMxTls | null = tlsConfig ?? null): Promise<FakeMx> {
  const m = await startFakeMx({ capabilities: () => ['8BITMIME', 'SIZE 10485760'], auth: { user: USER, password: PASSWORD }, ...script }, withTls ?? undefined);
  opened.push(m);
  return m;
}

interface Logged { event: string; fields: Record<string, unknown> | undefined }

function ses(m: FakeMx, extra: Partial<SesTransportOptions> = {}, logged: Logged[] = []): Transport {
  return createSesTransport({
    host: HOST,
    port: m.port,
    user: USER,
    password: PASSWORD,
    resolver: fakeResolver(DNS),
    tlsOptions: ca === undefined ? {} : { ca },
    log: (event, fields) => { logged.push({ event, fields }); },
    ...extra,
  });
}

afterAll(async () => {
  for (const m of opened) await m.close();
  if (certDir !== undefined) rmSync(certDir, { recursive: true, force: true });
});

describe('DELIVERY_SES_DOMAINS and configuration', () => {
  it('parses a comma list, lowercases it and drops trailing dots; * claims every domain', () => {
    expect(parseSesDomains(' Gmail.com, example.test. ,,googlemail.com ')).toEqual(['gmail.com', 'example.test', 'googlemail.com']);
    expect(parseSesDomains(undefined)).toEqual([]);
    expect(sesClaims(['example.test'], 'EXAMPLE.test')).toBe(true);
    expect(sesClaims(['example.test'], 'sub.example.test')).toBe(false);
    expect(sesClaims(['example.test'], 'other.test')).toBe(false);
    expect(sesClaims(['*'], 'anything.test')).toBe(true);
    expect(sesClaims([], 'anything.test')).toBe(false);
  });

  it('SES_REGION gives the regional endpoint; *_FILE reads a secret; missing names are reported, not values', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pst-t111-env-'));
    try {
      writeFileSync(path.join(dir, 'pw'), `${PASSWORD}\n`);
      const ok = sesConfigFromEnv({ SES_REGION: 'us-east-1', SES_SMTP_USER: USER, SES_SMTP_PASSWORD_FILE: path.join(dir, 'pw'), DELIVERY_SES_DOMAINS: '*' });
      expect(ok).toEqual({ config: { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, user: USER, password: PASSWORD, domains: ['*'] } });
      const missing = sesConfigFromEnv({ SES_SMTP_HOST: HOST, SES_SMTP_PASSWORD: PASSWORD, DELIVERY_SES_DOMAINS: 'gmail.com' });
      expect(missing).toEqual({ config: null, missing: ['SES_SMTP_USER'], domains: ['gmail.com'] });
      expect(() => sesConfigFromEnv({ SES_SMTP_PORT: 'x' })).toThrow(/SES_SMTP_PORT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without credentials SES is not selectable: logged once, no ses transport, and its domains route direct', () => {
    const logged: Logged[] = [];
    const log = (event: string, fields?: Record<string, unknown>): void => { logged.push({ event, fields }); };
    const transports = transportsFromEnv({ DELIVERY_SES_DOMAINS: 'gmail.com', SES_REGION: 'us-east-1' }, log);
    expect(Object.keys(transports)).toEqual(['direct']);
    expect(logged.map((l) => l.event)).toEqual(['ses-disabled']);
    expect(logged[0]?.fields).toMatchObject({ domains: ['gmail.com'], missing: ['SES_SMTP_USER', 'SES_SMTP_PASSWORD'] });
    const route = routeByClaims(transports);
    expect(route('gmail.com', 'direct')).toBe('direct');
    // Even a recipient enqueued as 'ses' goes direct rather than waiting on a transport that does not exist.
    expect(route('gmail.com', 'ses')).toBe('direct');
  });

  it('with credentials the ses transport claims its domains; the start-up log never carries the secret', () => {
    const logged: Logged[] = [];
    const log = (event: string, fields?: Record<string, unknown>): void => { logged.push({ event, fields }); };
    const transports = transportsFromEnv({ DELIVERY_SES_DOMAINS: 'example.test', SES_REGION: 'eu-west-1', SES_SMTP_USER: USER, SES_SMTP_PASSWORD: PASSWORD }, log);
    expect(Object.keys(transports).sort()).toEqual(['direct', 'ses']);
    expect(transports['ses']?.name).toBe('ses');
    const route = routeByClaims(transports);
    expect(route('example.test', 'direct')).toBe('ses');
    expect(route('other.test', 'direct')).toBe('direct');
    expect(route('other.test', 'ses')).toBe('ses');
    expect(logged.map((l) => l.event)).toEqual(['ses-enabled']);
    expect(logged[0]?.fields).toMatchObject({ host: 'email-smtp.eu-west-1.amazonaws.com', port: 587 });
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(USER);

    const all = routeByClaims(transportsFromEnv({ DELIVERY_SES_DOMAINS: '*', SES_SMTP_HOST: HOST, SES_SMTP_USER: USER, SES_SMTP_PASSWORD: PASSWORD }, log));
    expect(all('gmail.com', 'direct')).toBe('ses');
    expect(all('anything.test', 'direct')).toBe('ses');
  });
});

describe.skipIf(tlsConfig === undefined)('SES smarthost session', () => {
  it('relays the stored bytes unchanged over verified TLS after AUTH PLAIN, and the DKIM signatures still verify', async () => {
    const m = await smarthost({ auth: { user: USER, password: PASSWORD, mechanisms: ['LOGIN', 'PLAIN'] } });
    const logged: Logged[] = [];
    const result = await ses(m, {}, logged).deliver(request());
    expect(result.results).toEqual({ r1: { kind: 'delivered', code: 250, enhanced: '2.0.0', text: 'queued as FAKE' } });
    expect(result.details).toMatchObject({ mxHost: HOST, mxIp: '127.0.0.1', localIp: '127.0.0.1' });
    expect(result.details.tlsVersion).toMatch(/^TLSv1\.[23]$/);
    expect(result.details.tlsPeer).toContain('verified=true');

    const session = m.sessions[0];
    await session?.closed;
    expect(session?.secure).toBe(true);
    expect(session?.authInPlaintext).toBe(false);
    expect(session?.authUser).toBe(USER);
    const commands = session?.transcript.filter((l) => l.startsWith('C: ')).map((l) => l.split(' ').slice(0, 3).join(' '));
    expect(commands?.slice(0, 5)).toEqual(['C: EHLO mx.d3cloud.io', 'C: STARTTLS', 'C: EHLO mx.d3cloud.io', 'C: AUTH PLAIN', `C: MAIL FROM:<me@d3cloud.io>`]);

    const received = session?.bodyBuffer() ?? Buffer.alloc(0);
    expect(received.equals(SIGNED)).toBe(true);
    const verdicts = await verifyLocal(received, { ed: keys.ed25519.publicKey, rsa: keys.rsa.publicKey });
    expect(verdicts.map((v) => v.result)).toEqual(['pass', 'pass']);

    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(Buffer.from(`\0${USER}\0${PASSWORD}`).toString('base64'));
  });

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const m = await smarthost({ auth: { user: USER, password: PASSWORD, mechanisms: ['LOGIN'] } });
    const result = await ses(m).deliver(request());
    expect(result.results['r1']?.kind).toBe('delivered');
    expect(m.sessions[0]?.authUser).toBe(USER);
  });

  it('refuses to authenticate without TLS, even when the server advertises AUTH in plaintext', async () => {
    const m = await smarthost({ auth: { user: USER, password: PASSWORD, advertiseInPlaintext: true } }, null);
    const result = await ses(m).deliver(request());
    expect(result.results['r1']).toMatchObject({ kind: 'error' });
    expect(result.results['r1']?.kind === 'error' ? result.results['r1'].error : '').toMatch(/refusing to authenticate in plaintext/);
    const session = m.sessions[0];
    await session?.closed;
    expect(session?.transcript.some((l) => l.startsWith('C: AUTH'))).toBe(false);
    expect(session?.authInPlaintext).toBe(false);
    expect(session?.mailFrom).toBeNull();
  });

  it('refuses to authenticate when the certificate does not verify (no CA, or the wrong name)', async () => {
    const m = await smarthost();
    const untrusted = await ses(m, { tlsOptions: {} }).deliver(request());
    expect(untrusted.results['r1']).toMatchObject({ kind: 'error' });
    const wrongName = await createSesTransport({
      host: 'email-smtp.other.test', port: m.port, user: USER, password: PASSWORD,
      resolver: fakeResolver({ a: { 'email-smtp.other.test': ['127.0.0.1'] } }), tlsOptions: { ca: ca ?? '' }, log: () => undefined,
    }).deliver(request());
    expect(wrongName.results['r1']).toMatchObject({ kind: 'error' });
    await Promise.all(m.sessions.map((s) => s.closed));
    for (const s of m.sessions) {
      expect(s.transcript.some((l) => l.startsWith('C: AUTH'))).toBe(false);
      expect(s.authUser).toBeNull();
    }
  });

  it('a refused credential defers (error), never bounces; the reply is logged without the secret', async () => {
    const m = await smarthost();
    const logged: Logged[] = [];
    const result = await ses(m, { password: 'wrong' }, logged).deliver(request());
    expect(result.results['r1']).toMatchObject({ kind: 'error' });
    expect(result.results['r1']?.kind === 'error' ? result.results['r1'].error : '').toContain('AUTH: 535');
    expect(logged.some((l) => l.event === 'smarthost-auth-refused')).toBe(true);
    expect(JSON.stringify(logged)).not.toContain('wrong');
    const tempAuth = await smarthost({ auth: { user: USER, password: PASSWORD, reply: '454 4.7.0 Temporary authentication failure' } });
    const temp = await ses(tempAuth).deliver(request());
    expect(temp.results['r1']).toMatchObject({ kind: 'temporary', code: 454 });
  });

  it('classifies replies exactly as direct delivery does: 4xx temporary, 5xx permanent, per recipient', async () => {
    const m = await smarthost({ rcpt: (to) => (to.startsWith('gone') ? '550 5.1.1 no such user' : to.startsWith('later') ? '451 4.3.0 try later' : '250 2.1.5 ok') });
    const result = await ses(m).deliver(request({
      recipients: [
        { id: 'ok', address: 'you@example.test', notify: null },
        { id: 'gone', address: 'gone@example.test', notify: null },
        { id: 'later', address: 'later@example.test', notify: null },
      ],
    }));
    expect(result.results['ok']).toMatchObject({ kind: 'delivered', code: 250 });
    expect(result.results['gone']).toMatchObject({ kind: 'permanent', code: 550, enhanced: '5.1.1' });
    expect(result.results['later']).toMatchObject({ kind: 'temporary', code: 451, enhanced: '4.3.0' });

    const rejected = await smarthost({ final: () => '554 5.7.1 Message rejected: Email address is not verified' });
    expect((await ses(rejected).deliver(request())).results['r1']).toMatchObject({ kind: 'permanent', code: 554 });
    const throttled = await smarthost({ final: () => '454 4.7.0 Throttling failure: Maximum sending rate exceeded' });
    expect((await ses(throttled).deliver(request())).results['r1']).toMatchObject({ kind: 'temporary', code: 454 });
  });
});
