// PST-T-17.7 (PST-REQ-201, PST-REQ-202, PST-REQ-204): Admin › Sign in with D3 Auth, and the
// Settings › Account row. The rules live in src/admin/sign-in/model.ts and are tested directly; the
// screen's states are rendered to a string with react-dom/server over a stand-in @d3cloud/ui (its
// real build imports CSS, which plain Node cannot load), like sessions.test.ts. The API client is
// the real one, over a stubbed fetch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown> & { children?: ReactNode };
const DOM_PROPS = ['name', 'value', 'type', 'required', 'autoComplete', 'inputMode', 'role', 'className', 'id', 'form'];
const dom = (props: Props): Record<string, unknown> => {
  const out: Record<string, unknown> = { readOnly: true };
  for (const key of DOM_PROPS) if (props[key] !== undefined) out[key] = props[key];
  for (const [key, v] of Object.entries(props)) if (key.startsWith('data-') || key.startsWith('aria-')) out[key] = v;
  return out;
};

vi.mock('@d3cloud/ui', () => {
  const h = createElement;
  return {
    Page: (p: Props) => h('main', null, p.children),
    PageHeader: (p: Props) => h('header', null, h('h1', null, p['title'] as string), h('div', { 'data-slot': 'description' }, p['description'] as ReactNode)),
    Section: (p: Props) => h('section', null, h('h2', null, p['title'] as ReactNode), h('p', null, p['description'] as ReactNode), p.children),
    FormField: (p: Props) =>
      h(
        'div',
        { 'data-field': p['label'], 'data-width': p['width'], 'data-optional': p['optional'] === true ? 'yes' : 'no' },
        h('label', null, p['label'] as string),
        p.children,
        p['help'] === undefined ? null : h('p', { 'data-help': '' }, p['help'] as ReactNode),
        p['error'] === undefined ? null : h('p', { 'data-error': '' }, p['error'] as ReactNode),
      ),
    Input: (p: Props) => h('input', { ...dom(p), 'data-appearance': p['appearance'] }),
    PasswordInput: (p: Props) => h('input', { ...dom(p), type: 'password' }),
    Button: (p: Props) => h('button', { ...dom(p), 'data-variant': p['variant'] ?? 'secondary' }, p.children),
    IconButton: (p: Props) => h('button', { 'aria-label': p['label'] }),
    FormActions: (p: Props) => h('div', { 'data-actions': '' }, h('span', { 'data-leading': '' }, p['leading'] as ReactNode), p.children),
    StatusDot: (p: Props) => h('span', { 'data-tone': p['tone'] ?? 'neutral' }, p.children),
    Alert: (p: Props) => h('div', { 'data-alert': p['tone'] }, p['title'] as ReactNode, p.children),
    Modal: (p: Props) => (p['open'] === true ? h('div', { role: 'dialog' }, p['title'] as string, p['description'] as ReactNode, p.children, p['footer'] as ReactNode) : null),
    ModalClose: (p: Props) => p.children,
    SettingsRow: (p: Props) =>
      h('div', { 'data-row': p['data-d3auth-row'] }, h('h3', null, p['title'] as ReactNode), h('p', null, p['description'] as ReactNode), p['control'] as ReactNode),
    Skeleton: () => h('div', { 'data-skeleton': '' }),
    Stack: (p: Props) => h('div', null, p.children),
    EmptyState: (p: Props) => h('div', null, p['heading'] as string),
    Link: (p: Props) => h('a', null, p.children),
    useToast: () => ({ show: () => '', dismiss: () => undefined }),
  };
});

import { ApiError, d3authApi, OIDC_LINK_PATH, type D3AuthConfig, type LinkedIdentity } from '../../src/api';
import {
  accountLinkNoticeFrom,
  accountRowDescription,
  fieldErrors,
  formFrom,
  LINK_ERROR_COPY,
  LINK_STEP_UP_WHY,
  manifestText,
  REGISTER_STEPS,
  saveInput,
  SECRET_NEW_HELP,
  SECRET_SAVED_HELP,
  secretNeeded,
  signinNoticeFrom,
  statusLine,
  TURN_OFF_COPY,
  UNLINK_COPY,
} from '../../src/admin/sign-in/model';
import { AdminD3Auth, ConnectCard, type ConnectCardProps, D3AuthStatusLine, RegisterCard, SCREEN_TITLE, TestResult } from '../../src/admin/sign-in/AdminD3Auth';
import { D3AuthRowView } from '../../src/admin/sign-in/AccountD3AuthRow';
import { ROUTES, navEntries, routeForPath } from '../../src/routes';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const MANIFEST = { name: 'Postroom', redirect_uris: ['https://mail.d3cloud.io/api/auth/oidc/callback'], backchannel_logout_uri: 'https://mail.d3cloud.io/api/auth/oidc/backchannel-logout' };

const base: D3AuthConfig = {
  source: 'none',
  enabled: false,
  issuer: null,
  clientId: null,
  secretSet: false,
  status: 'not_configured',
  lastError: null,
  redirectUri: 'https://mail.d3cloud.io/api/auth/oidc/callback',
  backchannelLogoutUri: 'https://mail.d3cloud.io/api/auth/oidc/backchannel-logout',
  postLogoutRedirectUri: 'https://mail.d3cloud.io/signin',
  manifest: MANIFEST,
};
const available: D3AuthConfig = { ...base, source: 'console', enabled: true, issuer: 'https://auth.d3cloud.io', clientId: 'postroom', secretSet: true, status: 'available' };
const unavailable: D3AuthConfig = { ...base, source: 'server_file', enabled: true, issuer: 'https://auth.d3cloud.io', clientId: 'postroom', secretSet: true, status: 'unavailable', lastError: 'connect ECONNREFUSED' };

const noop = (): void => undefined;
const card = (over: Partial<ConnectCardProps> = {}): string =>
  renderToStaticMarkup(
    createElement(ConnectCard, {
      config: available,
      form: formFrom(available),
      errors: {},
      saveError: null,
      testResult: null,
      testing: false,
      saving: false,
      onChange: noop,
      onTest: noop,
      onSave: noop,
      onCancel: noop,
      onTurnOff: noop,
      ...over,
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the route', () => {
  it('is an admin-only Admin console entry at /admin/sign-in, found by the palette words', () => {
    const route = routeForPath('/admin/sign-in');
    expect(route).toMatchObject({ id: 'adminSignIn', place: 'admin', navGroup: 'Sign in with D3 Auth', adminOnly: true, title: SCREEN_TITLE });
    expect(route?.keywords).toContain('oidc');
    expect(route?.keywords).toContain('single sign-on');
    expect(navEntries('admin', true).map((e) => e.label)).toContain('Sign in with D3 Auth');
    expect(navEntries('admin', false).map((e) => e.label)).not.toContain('Sign in with D3 Auth');
    expect(ROUTES.filter((r) => r.path === '/admin/sign-in')).toHaveLength(1);
  });

  it('has a screen in App.tsx and an icon of its own in the shell (so the phone index shows it too)', () => {
    expect(read('App.tsx')).toMatch(/adminSignIn: <AdminD3Auth \/>/);
    expect(read('screens/Shell.tsx')).toMatch(/'Sign in with D3 Auth': ShieldKeyIcon/);
    // The phone's place index lists navEntries() — the route table — with the shell's icons.
    expect(read('mobile/PlaceIndex.tsx')).toMatch(/navEntries\(place, isAdmin\)/);
  });
});

describe('the status line (header)', () => {
  it('not configured: an idle dot, no source', () => {
    expect(statusLine(base)).toEqual({ tone: 'idle', label: 'Not configured', detail: null, source: null });
    const html = renderToStaticMarkup(createElement(D3AuthStatusLine, { config: base }));
    expect(html).toContain('data-tone="idle"');
    expect(html).toContain('Not configured');
  });

  it('available from the console: neutral (D-016), with the live source', () => {
    const html = renderToStaticMarkup(createElement(D3AuthStatusLine, { config: available }));
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain('Available');
    expect(html).toContain('set here in the console');
  });

  it('unavailable from the server file: needs you, with the last error and the source', () => {
    const html = renderToStaticMarkup(createElement(D3AuthStatusLine, { config: unavailable }));
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('Unavailable');
    expect(html).toContain('connect ECONNREFUSED');
    expect(html).toContain('from the server’s env file');
  });
});

describe('Connect to D3 Auth', () => {
  it('shows Issuer, Client ID and a write-only Client secret, sized to their values, never full-bleed', () => {
    const html = card();
    expect(html).toContain('<h2>Connect to D3 Auth</h2>');
    expect(html).toMatch(/data-field="Issuer" data-width="lg"/);
    expect(html).toMatch(/data-field="Client ID" data-width="md"/);
    expect(html).toMatch(/data-field="Client secret" data-width="md"/);
    expect(html).toContain('value="https://auth.d3cloud.io"');
    expect(html).toContain('value="postroom"');
    expect(html).toContain('data-appearance="filled"');
    // The secret is never echoed: the field is empty and says a saved one is kept.
    expect(html).toMatch(/<input[^>]*type="password" name="clientSecret" value=""\/>/);
    expect(html).toContain(SECRET_SAVED_HELP);
    expect(html).toContain('data-optional="yes"');
  });

  it('with no secret saved, the secret is required and says where it comes from', () => {
    const html = card({ config: base, form: formFrom(base) });
    expect(html).toContain(SECRET_NEW_HELP);
    expect(html).not.toContain(SECRET_SAVED_HELP);
    expect(html).toContain('data-optional="no"');
  });

  it('has Test connection, then Cancel / Save with Save last and primary', () => {
    const html = card();
    expect(html).toMatch(/data-variant="secondary"[^>]*>Test connection<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button><button[^>]*type="submit"[^>]*data-variant="primary"[^>]*>Save<\/button>/);
  });

  it('offers Turn off (danger-ghost, as the leading action) only while it is on', () => {
    expect(card()).toMatch(/data-variant="danger-ghost"[^>]*>Turn off<\/button>/);
    expect(card({ config: base, form: formFrom(base) })).not.toContain('Turn off');
  });

  it('shows the test result inline: the endpoint when reached, the error when not', () => {
    const ok = card({ testResult: { ok: true, issuer: 'https://auth.d3cloud.io', authorizationEndpoint: 'https://auth.d3cloud.io/authorize' } });
    expect(ok).toContain('Reached D3 Auth');
    expect(ok).toContain('https://auth.d3cloud.io/authorize');
    const bad = renderToStaticMarkup(createElement(TestResult, { result: { ok: false, issuer: 'https://x.test', error: 'getaddrinfo ENOTFOUND x.test' } }));
    expect(bad).toContain('data-tone="danger"');
    expect(bad).toContain('Could not reach D3 Auth');
    expect(bad).toContain('getaddrinfo ENOTFOUND x.test');
  });

  it('puts field errors on their fields, and a refusal that names none in an Alert', () => {
    const html = card({ errors: { issuer: 'Enter D3 Auth’s address' } });
    expect(html).toMatch(/data-field="Issuer"[\s\S]*data-error="">Enter D3 Auth’s address/);
    const alert = card({ saveError: 'Something went wrong' });
    expect(alert).toContain('data-alert="danger"');
    expect(alert).toContain('Could not save');
  });
});

describe('Register Postroom in D3 Auth', () => {
  const html = renderToStaticMarkup(createElement(RegisterCard, { config: available, onCopy: noop }));

  it('lists the four steps in order', () => {
    expect(REGISTER_STEPS.map((s) => s.title)).toEqual(['Register Postroom in D3 Auth', 'Grant yourself access', 'Paste the secret here', 'Link your account']);
    expect(html).toMatch(/<ol[^>]*>(<li>[\s\S]*?<\/li>){4}<\/ol>/);
  });

  it('shows the server’s three addresses, each with its own Copy', () => {
    for (const [label, value] of [
      ['Redirect URI', available.redirectUri],
      ['Back-channel logout URI', available.backchannelLogoutUri],
      ['Post-logout redirect URI', available.postLogoutRedirectUri],
    ] as const) {
      expect(html).toContain(`<dt>${label}</dt>`);
      expect(html).toContain(value);
      expect(html).toContain(`aria-label="Copy ${label.toLowerCase()}"`);
    }
  });

  it('shows the manifest as pretty JSON in a code block, with Copy', () => {
    expect(manifestText(MANIFEST)).toBe(JSON.stringify(MANIFEST, null, 2));
    expect(manifestText(MANIFEST).split('\n').length).toBeGreaterThan(3);
    expect(html).toMatch(/<pre[^>]*><code>\{\n {2}&quot;name&quot;: &quot;Postroom&quot;/);
    expect(html).toContain('aria-label="Copy manifest"');
  });
});

describe('the screen', () => {
  it('starts on a named loading state under its title and description', () => {
    const html = renderToStaticMarkup(createElement(AdminD3Auth));
    expect(html).toContain(`<h1>${SCREEN_TITLE}</h1>`);
    expect(html).toContain('Let people sign in to Postroom with their D3 Auth account.');
    expect(html).toContain('aria-label="Loading the D3 Auth settings"');
  });

  it('confirms Turn off, and every write goes through step-up', () => {
    const source = read('admin/sign-in/AdminD3Auth.tsx');
    expect(source).toContain('destructive');
    expect(source).toContain('TURN_OFF_COPY');
    expect(source).toMatch(/withStepUp\(\(\) => d3authApi\.save\(/);
    expect(source).toMatch(/withStepUp\(\(\) => d3authApi\.turnOff\(\)\)/);
    expect(read('admin/sign-in/step-up.tsx')).toContain("caught.code === 'step_up_required'");
    expect(TURN_OFF_COPY).toMatch(/password/);
  });
});

describe('the form rules', () => {
  it('starts from the server’s values with the secret empty', () => {
    expect(formFrom(available)).toEqual({ issuer: 'https://auth.d3cloud.io', clientId: 'postroom', clientSecret: '' });
    expect(formFrom(null)).toEqual({ issuer: '', clientId: '', clientSecret: '' });
  });

  it('sends the secret only when one was typed, so Save keeps a saved one', () => {
    expect(saveInput({ issuer: ' https://auth.d3cloud.io ', clientId: ' postroom ', clientSecret: '' })).toEqual({ issuer: 'https://auth.d3cloud.io', clientId: 'postroom' });
    expect(saveInput({ issuer: 'https://a.test', clientId: 'p', clientSecret: ' s3cret ' })).toEqual({ issuer: 'https://a.test', clientId: 'p', clientSecret: 's3cret' });
  });

  it('reads the field a 400 names, in any of the shapes the API uses', () => {
    expect(Object.keys(fieldErrors(new ApiError(400, 'invalid_request', { error: 'invalid_request', fields: [{ path: 'issuer', message: 'Invalid url' }] })))).toEqual(['issuer']);
    expect(Object.keys(fieldErrors(new ApiError(400, 'invalid_request', { fields: { clientId: 'required' } })))).toEqual(['clientId']);
    expect(Object.keys(fieldErrors(new ApiError(400, 'invalid_issuer', { error: 'invalid_issuer' })))).toEqual(['issuer']);
    expect(Object.keys(fieldErrors(new ApiError(400, 'invalid_request', { field: 'client_secret' })))).toEqual(['clientSecret']);
    expect(fieldErrors(new ApiError(403, 'step_up_required', null))).toEqual({});
    expect(fieldErrors(new Error('offline'))).toEqual({});
  });
});

describe('the API client', () => {
  const calls: { method: string; url: string; body: unknown; csrf: string | null }[] = [];
  const stub = (status: number, body: unknown): void => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(init.body as string), csrf: headers['x-postroom-csrf'] ?? null });
        return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
      }),
    );
  };

  it('reads, saves, tests and turns off at /api/admin/auth/d3auth', async () => {
    stub(200, available);
    await d3authApi.config();
    await d3authApi.save({ issuer: 'https://a.test', clientId: 'p' });
    await d3authApi.test('https://a.test');
    await d3authApi.test();
    await d3authApi.turnOff();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/admin/auth/d3auth',
      'PUT /api/admin/auth/d3auth',
      'POST /api/admin/auth/d3auth/test',
      'POST /api/admin/auth/d3auth/test',
      'DELETE /api/admin/auth/d3auth',
    ]);
    expect(calls[1]?.body).toEqual({ issuer: 'https://a.test', clientId: 'p' });
    expect(calls[2]?.body).toEqual({ issuer: 'https://a.test' });
    expect(calls[3]?.body).toEqual({});
    expect(calls.slice(1).every((c) => c.csrf === '1')).toBe(true);
  });

  it('lists and unlinks identities at /api/account/identities', async () => {
    stub(200, { ok: true, endedSessions: 1, signedOut: false });
    await expect(d3authApi.unlink('id/1')).resolves.toEqual({ ok: true, endedSessions: 1, signedOut: false });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: '/api/account/identities/id%2F1' });
    stub(200, []);
    await d3authApi.identities();
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/account/identities' });
  });

  it('a step-up refusal is an ApiError the screen recognises', async () => {
    stub(403, { error: 'step_up_required' });
    const caught: unknown = await d3authApi.save({ issuer: 'https://a.test', clientId: 'p' }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('step_up_required');
  });
});

describe('Settings › Account › Sign in with D3 Auth', () => {
  const linked: LinkedIdentity = { id: 'i1', issuer: 'https://auth.d3cloud.io', email: 'matthew@d3cloud.io', linkedAt: '2026-09-30T10:00:00Z', lastUsedAt: null };

  it('linked: the D3 Auth email and a ghost Unlink', () => {
    const html = renderToStaticMarkup(createElement(D3AuthRowView, { identity: linked, onLink: noop, onUnlink: noop }));
    expect(html).toContain('<h3>Sign in with D3 Auth</h3>');
    expect(html).toContain('Linked to matthew@d3cloud.io');
    expect(html).toMatch(/data-variant="ghost"[^>]*>Unlink<\/button>/);
    expect(html).not.toContain('Link…');
  });

  it('linked with no email: says so without one', () => {
    expect(accountRowDescription({ ...linked, email: null })).toBe('Linked to your D3 Auth account');
  });

  it('not linked: Link…, secondary', () => {
    const html = renderToStaticMarkup(createElement(D3AuthRowView, { identity: null, onLink: noop, onUnlink: noop }));
    expect(html).toContain('Use your D3 Auth account to sign in here');
    expect(html).toMatch(/data-variant="secondary"[^>]*>Link…<\/button>/);
  });

  it('Link… is a real navigation to the server’s link start; Unlink confirms, then steps up', () => {
    expect(OIDC_LINK_PATH).toBe('/api/auth/oidc/start?link=1');
    const source = read('admin/sign-in/AccountD3AuthRow.tsx');
    expect(source).toContain('window.location.assign(OIDC_LINK_PATH)');
    expect(source).toContain('UNLINK_COPY');
    expect(source).toMatch(/withStepUp\(\(\) => d3authApi\.unlink/);
    expect(UNLINK_COPY).toBe('Postroom will no longer accept D3 Auth for this account. Your password keeps working.');
  });

  it('is hidden until /api/auth/state says D3 Auth is available', () => {
    const source = read('admin/sign-in/AccountD3AuthRow.tsx');
    expect(source).toContain('state.oidcAvailable');
    expect(source).toMatch(/if \(!available \|\| identities === null\) \{\n\s+return \(\n\s+<>\n\s+\{refusal\}\n\s+\{prompt\}/);
  });

  // PST-T-17.16 (PST-ADR-015): a link the server would not make comes back here.
  it('a refused link comes back as a code, shown as its copy; an unknown code or none is nothing', () => {
    expect(accountLinkNoticeFrom('?link_error=linked_elsewhere')).toEqual({
      kind: 'error',
      message: 'This D3 Auth account is already linked to another Postroom account. Unlink it there first.',
    });
    expect(LINK_ERROR_COPY['linked_elsewhere']).toBe('This D3 Auth account is already linked to another Postroom account. Unlink it there first.');
    // Words in the URL are never shown: a crafted link cannot put its own text on the screen.
    expect(accountLinkNoticeFrom('?link_error=Call+us+now')).toBeNull();
    expect(accountLinkNoticeFrom('?link_error=toString')).toBeNull();
    expect(accountLinkNoticeFrom('')).toBeNull();
  });

  it('a link from a session older than five minutes asks for a code, then starts the link again', () => {
    expect(accountLinkNoticeFrom('?link_step_up=1')).toEqual({ kind: 'step_up' });
    expect(LINK_STEP_UP_WHY).toBe('Linking D3 Auth adds a way to sign in to this account');
    const source = read('admin/sign-in/AccountD3AuthRow.tsx');
    expect(source).toContain('useStepUp(LINK_STEP_UP_WHY)');
    expect(source).toMatch(/void confirmToLink\(\(\) => \{\n\s+window\.location\.assign\(OIDC_LINK_PATH\);/);
    // Read once, then cleared from the URL.
    expect(source).toContain("window.history.replaceState(null, '', window.location.pathname);");
    // The prompt opens without waiting for a 403: the server has already said it is needed.
    expect(read('admin/sign-in/step-up.tsx')).toMatch(/return askFirst\(action\);/);
  });

  it('a refusal shows in a danger alert above the row, available or not', () => {
    const source = read('admin/sign-in/AccountD3AuthRow.tsx');
    expect(source).toContain('<Alert tone="danger" title="D3 Auth was not linked" dynamic>');
    expect(source.match(/\{refusal\}/g)).toHaveLength(2);
  });

  it('sits in the Sign-in card after Two-factor', () => {
    const account = read('screens/ChangePassword.tsx');
    const twoFactor = account.indexOf('title="Two-factor authentication"');
    const row = account.indexOf('<AccountD3AuthRow />');
    const preferences = account.indexOf('<Section title="Preferences">');
    expect(twoFactor).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(twoFactor);
    expect(row).toBeLessThan(preferences);
  });
});

describe('secretNeeded (PST-T-17.6: a saved secret never follows a new issuer or client)', () => {
  const saved = { secretSet: true, issuer: 'https://auth.d3cloud.io', clientId: 'postroom' };
  const form = (issuer: string, clientId: string) => ({ issuer, clientId, clientSecret: '' });
  it('asks for a new secret when none is saved', () => {
    expect(secretNeeded({ ...saved, secretSet: false }, form('https://auth.d3cloud.io', 'postroom'))).toBe('new');
  });
  it('keeps the saved one for the same issuer and client, ignoring a trailing slash and case', () => {
    expect(secretNeeded(saved, form('https://Auth.d3cloud.io/', 'postroom'))).toBeNull();
  });
  it('asks again when the issuer or the client ID changes', () => {
    expect(secretNeeded(saved, form('https://evil.example', 'postroom'))).toBe('again');
    expect(secretNeeded(saved, form('https://auth.d3cloud.io', 'other'))).toBe('again');
  });
});

describe('Sign-in, back from D3 Auth (PST-T-17.16, PST-ADR-015)', () => {
  const NOT_LINKED = 'No Postroom account is linked to this D3 Auth account yet. Sign in with your password once, and D3 Auth will be linked to it.';

  it('an unlinked identity: the reason, and the sign-in goes on to link', () => {
    const search = `?${new URLSearchParams({ signin_error: NOT_LINKED, link_after_signin: '1' }).toString()}`;
    expect(signinNoticeFrom(search)).toEqual({ message: NOT_LINKED, linkAfter: true });
  });

  it('any other refusal: the reason only', () => {
    expect(signinNoticeFrom('?signin_error=D3+Auth+did+not+answer.')).toEqual({ message: 'D3 Auth did not answer.', linkAfter: false });
    expect(signinNoticeFrom('')).toBeNull();
  });

  it('the screen keeps the link notice through both steps, and links after the second', () => {
    const source = read('screens/SignIn.tsx');
    expect(source).toContain('const notice = signinNoticeFrom(window.location.search);');
    expect(source).toContain('if (notice.linkAfter) setLinkNotice(notice.message);');
    expect(source).toContain('<Alert tone="info" title="Sign in to link D3 Auth" dynamic>');
    // Only setError is cleared by a submit; the link notice stays.
    expect(source).not.toContain('setLinkNotice(null)');
    expect(source).toContain("window.location.assign('/api/auth/oidc/start?link=1');");
  });
});
