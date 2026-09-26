// The image proxy's fetcher and the capability tokens (PST-T-3.12, PST-REQ-082): private ranges are
// refused before and after a redirect, only raster images that are what they say are served, and a
// token or image signature that was not minted here never verifies.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchImage, imageType, isPrivateAddress, PROXY_USER_AGENT } from '../../src/usercontent/proxy.js';
import { deriveKey, mintToken, signImage, verifyImage, verifyToken } from '../../src/usercontent/token.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe', '::ffff:10.0.0.1', 'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  it.each(['1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('imageType', () => {
  it('serves only raster types whose bytes agree', () => {
    expect(imageType('image/png', PNG)).toBe('image/png');
    expect(imageType('image/jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType('image/png', Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(imageType('image/svg+xml', Buffer.from('<svg/>'))).toBeNull();
    expect(imageType('text/html', PNG)).toBeNull();
    expect(imageType(undefined, PNG)).toBeNull();
  });
});

describe('fetchImage', () => {
  const seen: http.IncomingHttpHeaders[] = [];
  let v4: http.Server;
  let v6: http.Server | null = null;
  let port = 0;
  let port6 = 0;

  beforeAll(async () => {
    v4 = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/pixel.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      else if (req.url === '/html') res.writeHead(200, { 'content-type': 'text/html' }).end('<script>alert(1)</script>');
      else if (req.url === '/lying') res.writeHead(200, { 'content-type': 'image/png' }).end('<svg onload=alert(1)>');
      else if (req.url === '/big') res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.concat([PNG, Buffer.alloc(2048)]));
      else if (req.url === '/to-v6') res.writeHead(302, { location: `http://[::1]:${String(port6)}/pixel.png` }).end();
      else if (req.url === '/to-self') res.writeHead(302, { location: '/pixel.png' }).end();
      else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end();
      else res.writeHead(404).end();
    });
    v4.listen(0, '127.0.0.1');
    await once(v4, 'listening');
    port = (v4.address() as AddressInfo).port;
    try {
      const s = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
      s.listen(0, '::1');
      await once(s, 'listening');
      v6 = s;
      port6 = (s.address() as AddressInfo).port;
    } catch {
      v6 = null;
    }
  });

  afterAll(async () => {
    v4.close();
    v6?.close();
    await once(v4, 'close');
  });

  const onlyV4Loopback = { allowPrivate: false, allowAddress: (a: string) => a === '127.0.0.1' };

  it('refuses loopback by default, before any request is made', async () => {
    const before = seen.length;
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/pixel.png`, { allowPrivate: false })).toMatchObject({ ok: false, status: 403 });
    expect(await fetchImage(`http://localhost:${String(port)}/pixel.png`, { allowPrivate: false })).toMatchObject({ ok: false, status: 403 });
    expect(await fetchImage('http://[::ffff:127.0.0.1]/x.png', { allowPrivate: false })).toMatchObject({ ok: false, status: 403 });
    expect(await fetchImage('http://2130706433/x.png', { allowPrivate: false })).toMatchObject({ ok: false, status: 403 });
    expect(await fetchImage('file:///etc/passwd', { allowPrivate: false })).toMatchObject({ ok: false, status: 403 });
    expect(seen.length).toBe(before);
  });

  it('fetches an allowed image with no cookie or referrer, as the proxy', async () => {
    const result = await fetchImage(`http://127.0.0.1:${String(port)}/pixel.png`, onlyV4Loopback);
    expect(result).toMatchObject({ ok: true, contentType: 'image/png' });
    const headers = seen.at(-1) ?? {};
    expect(headers['user-agent']).toBe(PROXY_USER_AGENT);
    expect(headers['cookie']).toBeUndefined();
    expect(headers['referer']).toBeUndefined();
  });

  it('checks every redirect hop again', async () => {
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/to-self`, onlyV4Loopback)).toMatchObject({ ok: true });
    if (v6 !== null) expect(await fetchImage(`http://127.0.0.1:${String(port)}/to-v6`, onlyV4Loopback)).toMatchObject({ ok: false, status: 403 });
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/loop`, onlyV4Loopback)).toMatchObject({ ok: false, status: 502 });
  });

  it('serves nothing that is not a raster image, or is too large', async () => {
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/html`, onlyV4Loopback)).toMatchObject({ ok: false, status: 415 });
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/lying`, onlyV4Loopback)).toMatchObject({ ok: false, status: 415 });
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/big`, { ...onlyV4Loopback, maxBytes: 1024 })).toMatchObject({ ok: false, status: 413 });
    expect(await fetchImage(`http://127.0.0.1:${String(port)}/nope`, onlyV4Loopback)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('capability tokens', () => {
  const key = deriveKey('a-session-secret');
  const cap = {
    messageId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    images: false,
    exp: 2_000_000_000,
  };

  it('round-trips and expires', () => {
    const token = mintToken(key, cap);
    expect(verifyToken(key, token, 1_000)).toEqual(cap);
    expect(verifyToken(key, token, cap.exp * 1000)).toBeNull();
  });

  it('refuses another key, a tampered payload and junk', () => {
    const token = mintToken(key, cap);
    expect(verifyToken(deriveKey('another-secret'), token, 1_000)).toBeNull();
    const [payload = '', sig = ''] = token.split('.');
    const images = Buffer.from(Buffer.from(payload, 'base64url').toString('utf8').replace('.0.', '.1.'), 'utf8').toString('base64url');
    expect(verifyToken(key, `${images}.${sig}`, 1_000)).toBeNull();
    for (const junk of ['', '.', 'a.b.c', `${payload}.`, `.${sig}`, 'x'.repeat(600)]) expect(verifyToken(key, junk, 1_000)).toBeNull();
  });

  it('signs an image URL to exactly one token and address', () => {
    const token = mintToken(key, cap);
    const sig = signImage(key, token, 'https://cdn.example/a.png');
    expect(verifyImage(key, token, 'https://cdn.example/a.png', sig)).toBe(true);
    expect(verifyImage(key, token, 'https://cdn.example/b.png', sig)).toBe(false);
    expect(verifyImage(key, mintToken(key, { ...cap, exp: cap.exp + 1 }), 'https://cdn.example/a.png', sig)).toBe(false);
  });
});
