// PST-T-4.12, PST-REQ-094: the MTA-STS policy route, over the app.
import { request } from '../loopback.js';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createApp } from '../../src/app.js';
import { mtaStsPolicyId, renderMtaStsPolicy } from '../../src/mta-sts/policy.js';

interface FakeDomain {
  id: string;
  name: string;
  isPrimary: boolean;
}

function fakeDb(domains: readonly FakeDomain[]): Db {
  return {
    domain: {
      findFirst: ({ where }: { where: { name?: string; isPrimary?: boolean } }) => {
        const found =
          where.name !== undefined
            ? (domains.find((d) => d.name === where.name) ?? null)
            : (domains.find((d) => d.isPrimary) ?? null);
        return Promise.resolve(found === null ? null : { ...found, createdAt: new Date() });
      },
    },
  } as unknown as Db;
}

const config = { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'abc123' };

function makeApp(domains: readonly FakeDomain[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof createApp> {
  return createApp({ db: fakeDb(domains), env, config });
}

const PRIMARY = { id: 'dom-1', name: 'd3cloud.io', isPrimary: true };

describe('MTA-STS policy (RFC 8461, PST-REQ-094)', () => {
  it('serves the policy at mta-sts.<domain>/.well-known/mta-sts.txt as text/plain, no redirect', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['location']).toBeUndefined();
    expect(res.text).toBe('version: STSv1\nmode: testing\nmx: mx.d3cloud.io\nmax_age: 86400\n');
  });

  it('defaults to testing mode and 86400s max_age, and reports the mx as mx.<primary domain>', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(res.text).toContain('mode: testing');
    expect(res.text).toContain('mx: mx.d3cloud.io');
    expect(res.text).toContain('max_age: 86400');
  });

  it('honours MTA_STS_MODE and MTA_STS_MAX_AGE', async () => {
    const res = await request(makeApp([PRIMARY], { MTA_STS_MODE: 'enforce', MTA_STS_MAX_AGE: '604800' }))
      .get('/.well-known/mta-sts.txt')
      .set('Host', 'mta-sts.d3cloud.io');
    expect(res.status).toBe(200);
    expect(res.text).toBe('version: STSv1\nmode: enforce\nmx: mx.d3cloud.io\nmax_age: 604800\n');
  });

  it('accepts mode=none', async () => {
    const res = await request(makeApp([PRIMARY], { MTA_STS_MODE: 'none' })).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(res.text).toContain('mode: none');
  });

  it('a secondary domain still gets the primary domain as its mx default', async () => {
    const secondary = { id: 'dom-2', name: 'example.net', isPrimary: false };
    const res = await request(makeApp([PRIMARY, secondary])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.example.net');
    expect(res.status).toBe(200);
    expect(res.text).toContain('mx: mx.d3cloud.io');
  });

  it('answers 404 for a Host whose domain Postroom does not serve', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.example.com');
    expect(res.status).toBe(404);
  });

  it('answers 404 for any other Host at the same path', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'd3cloud.io');
    expect(res.status).toBe(404);
  });

  it('answers 404 for a bare "mta-sts." Host with no domain after it', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.');
    expect(res.status).toBe(404);
  });

  it('answers 503 rather than an invalid policy when MTA_STS_MODE is not recognised', async () => {
    const res = await request(makeApp([PRIMARY], { MTA_STS_MODE: 'strict' })).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(res.status).toBe(503);
  });

  it('the id RFC 8461 senders would see is derived from exactly this served text', async () => {
    const res = await request(makeApp([PRIMARY])).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    const expectedId = mtaStsPolicyId(renderMtaStsPolicy({ mode: 'testing', mxHost: 'mx.d3cloud.io', maxAge: 86_400 }));
    expect(mtaStsPolicyId(res.text)).toBe(expectedId);
  });
});
