import { request } from '../loopback.js';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createApp } from '../../src/app.js';

function fakeDb(knownDomains: readonly string[]): Db {
  const domains = new Set(knownDomains);
  return {
    domain: {
      findFirst: ({ where }: { where: { name: string } }) =>
        Promise.resolve(domains.has(where.name) ? { id: 'dom-1', name: where.name, isPrimary: true, createdAt: new Date() } : null),
    },
  } as unknown as Db;
}

const config = { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'abc123' };

function makeApp(knownDomains: readonly string[] = ['d3cloud.io']): ReturnType<typeof createApp> {
  return createApp({ db: fakeDb(knownDomains), env: {}, config });
}

/** Minimal structural read of the fields the tests assert on — never a real XML parser. */
function textOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
  return match?.[1];
}

describe('thunderbird autoconfig', () => {
  it('serves the well-known document for a domain Postroom knows', async () => {
    const app = makeApp();
    const res = await request(app).get('/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40d3cloud.io');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(textOf(res.text, 'domain')).toBe('d3cloud.io');
    expect(textOf(res.text, 'displayName')).toBe('Postroom');
    expect(res.text).toContain('<incomingServer type="imap">');
    expect(textOf(res.text, 'hostname')).toBe('mx.d3cloud.io');
    expect(res.text).toContain('<port>993</port>');
    expect(res.text).toContain('<socketType>SSL</socketType>');
    expect(res.text).toContain('<username>%EMAILADDRESS%</username>');
    expect(res.text).toContain('<authentication>password-cleartext</authentication>');
    // Both a submit-on-465 and a STARTTLS-on-587 outgoing server are offered.
    expect(res.text).toContain('<port>465</port>');
    expect(res.text).toContain('<port>587</port>');
    expect(res.text).toContain('<socketType>STARTTLS</socketType>');
  });

  it('serves the autoconfig-subdomain path with the same document', async () => {
    const app = makeApp();
    const res = await request(app).get('/mail/config-v1.1.xml?emailaddress=user%40d3cloud.io');
    expect(res.status).toBe(200);
    expect(textOf(res.text, 'domain')).toBe('d3cloud.io');
  });

  it('resolves the domain from the Host header when no emailaddress is given', async () => {
    const app = makeApp();
    const res = await request(app).get('/mail/config-v1.1.xml').set('Host', 'autoconfig.d3cloud.io');
    expect(res.status).toBe(200);
    expect(textOf(res.text, 'domain')).toBe('d3cloud.io');
  });

  it('answers 404 for a domain Postroom does not serve', async () => {
    const app = makeApp();
    const res = await request(app).get('/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40example.com');
    expect(res.status).toBe(404);
  });

  it('answers 404 when no domain can be determined at all', async () => {
    const app = makeApp();
    const res = await request(app).get('/mail/config-v1.1.xml').set('Host', '127.0.0.1');
    expect(res.status).toBe(404);
  });

  it('carries the strict CSP headers set for every response', async () => {
    const app = makeApp();
    const res = await request(app).get('/mail/config-v1.1.xml?emailaddress=user%40d3cloud.io');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:/);
  });
});

const POX_BODY = (email: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${email}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;

describe('outlook/apple autodiscover', () => {
  it('answers a POX request with the account settings for a known domain', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/autodiscover/autodiscover.xml')
      .set('Content-Type', 'text/xml')
      .send(POX_BODY('user@d3cloud.io'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.text).toContain('<Type>IMAP</Type>');
    expect(res.text).toContain('<Server>mx.d3cloud.io</Server>');
    expect(res.text).toContain('<Port>993</Port>');
    expect(res.text).toContain('<SSL>on</SSL>');
    expect(res.text).toContain('<Type>SMTP</Type>');
    expect(res.text).toContain('<Port>465</Port>');
    expect((res.text.match(/<LoginName>user@d3cloud\.io<\/LoginName>/g) ?? []).length).toBe(2);
  });

  it('answers 404 for a domain Postroom does not serve', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/autodiscover/autodiscover.xml')
      .set('Content-Type', 'text/xml')
      .send(POX_BODY('user@example.com'));
    expect(res.status).toBe(404);
  });

  it('answers 400 for a body over the size cap', async () => {
    const app = makeApp();
    const huge = `<EMailAddress>${'a'.repeat(20_000)}@d3cloud.io</EMailAddress>`;
    const res = await request(app).post('/autodiscover/autodiscover.xml').set('Content-Type', 'text/xml').send(huge);
    expect(res.status).toBe(400);
  });

  it('answers 400 for a body carrying a DOCTYPE', async () => {
    const app = makeApp();
    const body = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${POX_BODY('user@d3cloud.io')}`;
    const res = await request(app).post('/autodiscover/autodiscover.xml').set('Content-Type', 'text/xml').send(body);
    expect(res.status).toBe(400);
  });

  it('answers 400 for a body carrying an entity declaration without a DOCTYPE wrapper', async () => {
    const app = makeApp();
    const body = `<!ENTITY xxe "boom">${POX_BODY('user@d3cloud.io')}`;
    const res = await request(app).post('/autodiscover/autodiscover.xml').set('Content-Type', 'text/xml').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects an injection attempt inside EMailAddress rather than reflecting it', async () => {
    const app = makeApp();
    const body = POX_BODY('"><script>alert(1)</script>@d3cloud.io');
    const res = await request(app).post('/autodiscover/autodiscover.xml').set('Content-Type', 'text/xml').send(body);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>');
  });

  it('XML-escapes a valid but unusual address rather than reflecting it raw', async () => {
    const app = makeApp();
    const body = POX_BODY(`us'er@d3cloud.io`);
    const res = await request(app).post('/autodiscover/autodiscover.xml').set('Content-Type', 'text/xml').send(body);
    expect(res.status).toBe(200);
    expect(res.text).toContain('us&apos;er@d3cloud.io');
    expect(res.text).not.toContain(`us'er@d3cloud.io`);
  });

  it('answers the same document on a GET probe when the address is already known', async () => {
    const app = makeApp();
    const res = await request(app).get('/autodiscover/autodiscover.xml?emailaddress=user%40d3cloud.io');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<LoginName>user@d3cloud.io</LoginName>');
  });

  it('answers 404 on a bare GET probe with no address and no known domain', async () => {
    const app = makeApp();
    const res = await request(app).get('/autodiscover/autodiscover.xml');
    expect(res.status).toBe(404);
  });

  it('carries the strict CSP headers on the autodiscover response too', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/autodiscover/autodiscover.xml')
      .set('Content-Type', 'text/xml')
      .send(POX_BODY('user@d3cloud.io'));
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
  });
});
