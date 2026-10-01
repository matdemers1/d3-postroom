// PST-T-5.7: the aliases screen's calls hit the right method, path, headers and body — mirrors
// apps/api/src/aliases/index.ts's routes (PST-REQ-112).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from '../../src/api';
import { aliasActions, aliasFacts, aliasStatus } from '../../src/screens/aliases-format';

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

// PST-T-17.10 (PST-REQ-194): Addresses on the canvas — status is a dot and a word, a turned-off
// alias is never shown in red, and its two actions sit behind one ⋯ menu.
describe('an alias row', () => {
  it('is Live (neutral) until turned off, then Off (idle) — never a danger tone', () => {
    expect(aliasStatus({ killedAt: null })).toEqual({ label: 'Live', tone: 'neutral' });
    expect(aliasStatus({ killedAt: '2026-10-01T00:00:00.000Z' })).toEqual({ label: 'Off', tone: 'idle' });
  });

  it('says which site and how much mail, starting with the "For site ·" the e2e suite reads', () => {
    expect(aliasFacts({ site: 'shop.example', receivedCount: 3 })).toBe('For shop.example · 3 received');
  });

  it('offers Copy address, then Turn off or Turn on', () => {
    expect(aliasActions({ killedAt: null })).toEqual([
      { action: 'copy', label: 'Copy address' },
      { action: 'turn-off', label: 'Turn off' },
    ]);
    expect(aliasActions({ killedAt: '2026-10-01T00:00:00.000Z' }).map((a) => a.label)).toEqual(['Copy address', 'Turn on']);
  });
});

describe('the Addresses screen', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/screens/Aliases.tsx'), 'utf8');

  it('is titled as its nav entry, centred, with one Masked aliases card holding New alias', () => {
    expect(source).toContain('title="Addresses"');
    expect(source).toContain('<Page width="narrow" align="center">');
    expect(source).toMatch(/<Section\s+title="Masked aliases"\s+actions=/);
  });

  it('opens its form inside that card on the 164/360 grid, Cancel then Create at its foot', () => {
    expect(source).toContain('className="pr-setform pr-inline-form"');
    expect(source).toContain('<FormActions className="pr-setform__actions">');
    expect(source.indexOf('Cancel')).toBeLessThan(source.indexOf('Create alias'));
  });

  it('draws status as a StatusDot and times with RelativeTime; no badge, no red, a row-size empty state', () => {
    expect(source).toContain('<StatusDot size="sm" tone={status.tone}>');
    expect(source).toContain('<RelativeTime iso={a.lastUsedAt} />');
    expect(source).not.toMatch(/<Badge|danger-ghost|toLocaleString/);
    expect(source).toMatch(/<EmptyState kind="empty" heading="No masked aliases yet" headingLevel=\{3\} size="row">/);
    expect(source).toContain('label={`Actions for ${a.address}`}');
  });
});
