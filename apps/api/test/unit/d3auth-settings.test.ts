// PST-T-17.6 (PST-ADR-014): the pieces under the console's D3 Auth settings — issuer validation,
// precedence between the saved row and the env, sealing, and swapping the provider in-process.
import { kekFromBase64 } from '@postroom/crypto';
import type { AuthClient } from '@d3cloudio/auth-client';
import { describe, expect, it } from 'vitest';
import {
  KEK_NOT_LOADED,
  normalizeIssuer,
  openClientSecret,
  resolveD3Auth,
  sealClientSecret,
  SECRET_UNOPENABLE,
} from '../../src/auth/d3auth-settings.js';
import { OidcProvider, type OidcSettings } from '../../src/auth/oidc.js';

const kek = kekFromBase64(Buffer.alloc(32, 7).toString('base64'));
const otherKek = kekFromBase64(Buffer.alloc(32, 9).toString('base64'));
const REDIRECT = 'https://mail.d3cloud.io/api/auth/oidc/callback';
const env: OidcSettings = { issuer: 'https://env.example', clientId: 'env-client', clientSecret: 'env-secret', redirectUri: REDIRECT };

describe('normalizeIssuer', () => {
  it('keeps https, drops a trailing slash, and allows plain http only on loopback', () => {
    expect(normalizeIssuer('https://auth.d3cloud.io/')).toBe('https://auth.d3cloud.io');
    expect(normalizeIssuer(' https://auth.d3cloud.io/oidc// ')).toBe('https://auth.d3cloud.io/oidc');
    expect(normalizeIssuer('http://127.0.0.1:9400')).toBe('http://127.0.0.1:9400');
    expect(normalizeIssuer('http://localhost:9400/')).toBe('http://localhost:9400');
    for (const bad of ['http://auth.d3cloud.io', 'ftp://x.example', 'https://x.example/?a=1', 'https://x.example/#f', 'https://u:p@x.example', 'https://x.example//a', 'nope']) {
      expect(normalizeIssuer(bad), bad).toBeNull();
    }
  });
});

describe('resolveD3Auth precedence', () => {
  const saved = { enabled: true, issuer: 'https://row.example', clientId: 'row-client', sealedSecret: sealClientSecret(kek, 'row-secret'), updatedAt: 'now' };

  it('a saved row wins over the env, with its secret opened', () => {
    const r = resolveD3Auth(saved, kek, env, REDIRECT);
    expect(r.state).toEqual({ source: 'console', enabled: true, issuer: 'https://row.example', clientId: 'row-client', secretSet: true, error: null });
    expect(r.settings).toEqual({ issuer: 'https://row.example', clientId: 'row-client', clientSecret: 'row-secret', redirectUri: REDIRECT });
  });

  it('no row: the env, or nothing', () => {
    expect(resolveD3Auth(null, kek, env, REDIRECT)).toMatchObject({ state: { source: 'server_file', issuer: env.issuer, error: null }, settings: env });
    expect(resolveD3Auth(null, kek, null, REDIRECT)).toEqual({
      state: { source: 'none', enabled: false, issuer: null, clientId: null, secretSet: false, error: null },
      settings: null,
    });
  });

  it('turned off in the console wins over the env', () => {
    expect(resolveD3Auth({ enabled: false, updatedAt: 'now' }, kek, env, REDIRECT)).toMatchObject({ state: { source: 'console', enabled: false }, settings: null });
  });

  it('with no KEK the env applies and the reason is given; a secret sealed under another KEK does not open', () => {
    expect(resolveD3Auth(saved, null, env, REDIRECT)).toMatchObject({ state: { source: 'server_file', error: KEK_NOT_LOADED }, settings: env });
    expect(resolveD3Auth(saved, otherKek, env, REDIRECT)).toMatchObject({ state: { source: 'console', error: SECRET_UNOPENABLE }, settings: null });
  });

  it('seals with no plaintext, bound to its AAD', () => {
    const sealed = sealClientSecret(kek, 'a-client-secret');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('a-client-secret');
    expect(openClientSecret(kek, sealed)).toBe('a-client-secret');
    expect(() => openClientSecret(otherKek, sealed)).toThrow();
  });
});

describe('OidcProvider.replace', () => {
  const settings = (issuer: string): OidcSettings => ({ issuer, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT });
  const fakeClient = (issuer: string): AuthClient => ({ issuer }) as unknown as AuthClient;

  it('a discovery in flight for the old settings is discarded; the next get uses the new ones', async () => {
    let release: (c: AuthClient) => void = () => undefined;
    const calls: string[] = [];
    const provider = new OidcProvider(settings('https://old.example'), (options) => {
      calls.push(options.issuer);
      if (options.issuer === 'https://old.example') return new Promise<AuthClient>((resolve) => (release = resolve));
      return Promise.resolve(fakeClient(options.issuer));
    });
    const stale = provider.get(0);
    // Let it reach the factory: discovery for the old issuer is now in flight.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['https://old.example']);
    provider.replace(settings('https://new.example'));
    release(fakeClient('https://old.example'));
    expect(await stale).toBeNull();
    const fresh = (await provider.get(0)) as unknown as { issuer: string };
    expect(fresh.issuer).toBe('https://new.example');
    expect(calls).toEqual(['https://old.example', 'https://new.example']);
    provider.replace(null);
    expect(provider.configured).toBe(false);
    expect(await provider.get(0)).toBeNull();
  });

  it('readers wait for a load, and a replace made during it wins', async () => {
    const provider = new OidcProvider(null, (o) => Promise.resolve(fakeClient(o.issuer)));
    let finish: (s: OidcSettings | null) => void = () => undefined;
    provider.load(() => new Promise((resolve) => (finish = resolve)));
    const waiting = provider.get(0);
    finish(settings('https://loaded.example'));
    expect(((await waiting) as unknown as { issuer: string }).issuer).toBe('https://loaded.example');

    let late: (s: OidcSettings | null) => void = () => undefined;
    provider.load(() => new Promise((resolve) => (late = resolve)));
    provider.replace(settings('https://saved.example'));
    late(settings('https://boot.example'));
    await provider.ready();
    expect(provider.settings?.issuer).toBe('https://saved.example');
  });

  it('records why discovery failed, as lastError', async () => {
    const provider = new OidcProvider(settings('https://down.example'), () => Promise.reject(new Error('connect ECONNREFUSED')));
    expect(await provider.get(0)).toBeNull();
    expect(provider.lastError).toBe('connect ECONNREFUSED');
  });
});
