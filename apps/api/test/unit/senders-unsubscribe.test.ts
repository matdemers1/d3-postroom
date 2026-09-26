// PST-T-5.6, PST-REQ-110: the pure RFC 8058 parsing and the DMARC-pass gate, unit tested without a
// database or network — the integration test (unsubscribe-and-profile.test.ts) exercises the real
// HTTP POST and the sender record it writes.
import { describe, expect, it } from 'vitest';
import { dmarcPassed, parseUnsubscribeOffer, postOneClick } from '../../src/senders/unsubscribe.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

describe('parseUnsubscribeOffer (RFC 8058)', () => {
  it('is unavailable with no List-Unsubscribe header', () => {
    expect(parseUnsubscribeOffer({ listUnsubscribe: null, listUnsubscribePost: null })).toMatchObject({ available: false });
  });

  it('is unavailable without an https URL', () => {
    const offer = parseUnsubscribeOffer({ listUnsubscribe: '<mailto:unsub@example.org>', listUnsubscribePost: 'List-Unsubscribe=One-Click' });
    expect(offer).toMatchObject({ available: false, httpsUrl: null, mailto: 'mailto:unsub@example.org' });
  });

  it('is unavailable without List-Unsubscribe-Post: List-Unsubscribe=One-Click', () => {
    const offer = parseUnsubscribeOffer({ listUnsubscribe: '<https://example.org/unsub>', listUnsubscribePost: null });
    expect(offer).toMatchObject({ available: false, httpsUrl: 'https://example.org/unsub' });
  });

  it('is available when both headers are right, and carries a mailto: alongside the https URL', () => {
    const offer = parseUnsubscribeOffer({
      listUnsubscribe: '<mailto:unsub@example.org>, <https://example.org/unsub?id=1>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
    expect(offer).toMatchObject({ available: true, httpsUrl: 'https://example.org/unsub?id=1', mailto: 'mailto:unsub@example.org' });
  });

  it('accepts a loopback http: URL only when allowInsecure is set (e2e escape)', () => {
    const headers = { listUnsubscribe: '<http://127.0.0.1:1234/unsub>', listUnsubscribePost: 'List-Unsubscribe=One-Click' };
    expect(parseUnsubscribeOffer(headers, false)).toMatchObject({ available: false });
    expect(parseUnsubscribeOffer(headers, true)).toMatchObject({ available: true, httpsUrl: 'http://127.0.0.1:1234/unsub' });
  });
});

describe('dmarcPassed', () => {
  it('is true only for a stored dmarc.result of pass', () => {
    expect(dmarcPassed({ dmarc: { result: 'pass' } })).toBe(true);
    expect(dmarcPassed({ dmarc: { result: 'fail' } })).toBe(false);
    expect(dmarcPassed({})).toBe(false);
    expect(dmarcPassed(null)).toBe(false);
    expect(dmarcPassed(undefined)).toBe(false);
  });
});

describe('postOneClick', () => {
  it('refuses a non-https URL when the policy does not allow it', async () => {
    const result = await postOneClick('http://127.0.0.1:1/unsub', { allowPrivate: false });
    expect(result).toMatchObject({ ok: false, reason: 'scheme_refused' });
  });

  it('POSTs the RFC 8058 body to a loopback listener under the test policy, and reports failure for a non-2xx', async () => {
    const hits: { body: string; contentType: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] });
        if (req.url === '/fail') res.writeHead(500).end('nope');
        else res.writeHead(204).end();
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await postOneClick(`http://127.0.0.1:${String(port)}/unsub`, { allowPrivate: true });
      expect(ok).toMatchObject({ ok: true, status: 204 });
      expect(hits[0]).toMatchObject({ body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' });

      const failed = await postOneClick(`http://127.0.0.1:${String(port)}/fail`, { allowPrivate: true });
      expect(failed).toMatchObject({ ok: false, reason: 'upstream_error' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });

  it('refuses a private address when the policy does not allow it (SSRF)', async () => {
    const result = await postOneClick('https://127.0.0.1:1/unsub', { allowPrivate: false });
    expect(result.ok).toBe(false);
  });
});
