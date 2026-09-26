// PST-T-5.7: the aliases screen's calls hit the right method, path, headers and body — mirrors
// apps/api/src/aliases/index.ts's routes (PST-REQ-112).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api';

function mockFetch(body: unknown, status = 200) {
  const spy = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('api.aliases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists aliases with a plain GET', async () => {
    const spy = mockFetch({ aliases: [] });
    await api.aliases();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/aliases');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-postroom-csrf']).toBeUndefined();
  });

  it('creates an alias with the CSRF header and the site in the body', async () => {
    const spy = mockFetch({ alias: { id: '1', address: 'shop.ab12@d3cloud.io', site: 'shop.example', createdAt: '', killedAt: null, lastUsedAt: null, receivedCount: 0 } }, 201);
    await api.createAlias({ site: 'shop.example' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/aliases');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-postroom-csrf']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ site: 'shop.example' });
  });

  it('kills and revives by id, with no body', async () => {
    const spy = mockFetch({ alias: { id: '1' } });
    await api.killAlias('abc def');
    expect((spy.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/aliases/abc%20def/kill');
    await api.reviveAlias('abc def');
    expect((spy.mock.calls[1] as [string, RequestInit])[0]).toBe('/api/aliases/abc%20def/revive');
  });
});
