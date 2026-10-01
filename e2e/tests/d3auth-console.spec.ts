// PST-T-17.7 (PST-REQ-201, PST-REQ-202, PST-REQ-204): Sign in with D3 Auth, set up from the Admin
// console. The screen shows the server's own addresses and manifest and is axe clean in both themes
// (and at 390 px, as the mobile project); Test connection says why it cannot reach an issuer; and,
// against e2e/fake-issuer started here, a save turns the status to Available, Settings › Account
// offers Link…, the link round-trips through the issuer, Unlink confirms and steps up, and Turn off
// confirms and steps up.
//
// Where the issuer lives: the api fetches its discovery document and its token endpoint, so the api
// must reach it — and the relying party allows plain http only for a loopback issuer, while the fake
// names itself by the address it listens on. So the round-trip runs against a locally started api
// (127.0.0.1). Against the compose stack (CI) the api is in a container, where 127.0.0.1 is not the
// runner and host.docker.internal is neither loopback nor https: there the round-trip is skipped and
// the error path stands in for it. E2E_FAKE_ISSUER=1 forces the round-trip; =0 skips it.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { startFakeIssuer, type FakeIssuer } from '../fake-issuer/server.mjs';
import { ensureOperator, freshCode, signInCookies, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const CSRF = { 'x-postroom-csrf': '1' };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const THEMES = ['light', 'dark'] as const;
const FORCE = process.env['E2E_FAKE_ISSUER'];
const ISSUER_REACHABLE = FORCE === undefined ? process.env['CI'] === undefined : FORCE === '1';
const USER = { sub: 'e2e-d3auth-console', email: 'd3auth.console@example.com', name: 'E2E D3 Auth', roles: ['admin'] };

let api: APIRequestContext;
let operator: Operator;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let issuer: FakeIssuer | null = null;

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  if (ISSUER_REACHABLE) issuer = await startFakeIssuer({ port: 0, clientId: 'postroom-console', clientSecret: 'console-e2e-secret', user: USER });
});

test.afterAll(async () => {
  // Leave the stack as the compose file made it: no console settings (the env file's closed port).
  const res = await api.get('/api/admin/auth/d3auth');
  if (res.ok() && ((await res.json()) as { source: string }).source === 'console') {
    const off = await api.delete('/api/admin/auth/d3auth', { headers: CSRF });
    if (off.status() === 403) {
      await api.post('/api/auth/step-up', { headers: CSRF, data: { code: await freshCode(operator) } });
      await api.delete('/api/admin/auth/d3auth', { headers: CSRF });
    }
  }
  await issuer?.close();
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

async function axeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const found = results.violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
  expect.soft(found, `${label}: axe violations`).toEqual([]);
}

/** Answers "Confirm it is you" when the server asks for it; a fresh session may not be asked. */
async function stepUpIfAsked(page: Page, done: ReturnType<Page['locator']>): Promise<void> {
  const prompt = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(done.or(prompt).first()).toBeVisible();
  if (await prompt.isVisible()) {
    await prompt.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
    await prompt.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(done).toBeVisible();
}

/** The write-only secret: a PasswordInput, whose label may carry "Optional" once one is saved. */
const secretField = (page: Page) => page.locator('input[name="clientSecret"]');

/** The PageHeader: its description slot holds the status line. */
const header = (page: Page) => page.locator('.d3-ph').first();

test('shows the server’s addresses and manifest, each with Copy, axe clean in both themes', async ({ page }) => {
  await page.goto('/admin/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in with D3 Auth', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect to D3 Auth' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Register Postroom in D3 Auth' })).toBeVisible();

  const config = (await (await api.get('/api/admin/auth/d3auth')).json()) as {
    redirectUri: string;
    backchannelLogoutUri: string;
    postLogoutRedirectUri: string;
  };
  for (const [label, value] of [
    ['Redirect URI', config.redirectUri],
    ['Back-channel logout URI', config.backchannelLogoutUri],
    ['Post-logout redirect URI', config.postLogoutRedirectUri],
  ] as const) {
    await expect(page.getByText(value, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Copy ${label.toLowerCase()}` })).toBeVisible();
  }
  await expect(page.getByLabel('D3 Auth manifest')).toContainText(config.redirectUri);
  await expect(page.getByRole('button', { name: 'Copy manifest' })).toBeVisible();
  await expect(page.locator('ol li')).toHaveCount(4);
  await expect(page.getByLabel('Issuer')).toBeVisible();
  await expect(page.getByLabel('Client ID')).toBeVisible();
  await expect(secretField(page)).toBeVisible();

  // Nothing at 390 px scrolls sideways because of a long URI or the manifest.
  const widths = await page.locator('html').evaluate((el) => {
    const box = el as unknown as { scrollWidth: number; clientWidth: number };
    return { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
  });
  expect(widths.scrollWidth, 'the screen scrolls sideways').toBeLessThanOrEqual(widths.clientWidth);

  for (const theme of THEMES) {
    await page.evaluate((t) => {
      localStorage.setItem('postroom-theme', t);
    }, theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'Register Postroom in D3 Auth' })).toBeVisible();
    await axeClean(page, `Sign in with D3 Auth [${theme}]`);
  }
});

test('Test connection says why it cannot reach an issuer, and saves nothing', async ({ page }) => {
  const before: unknown = await (await api.get('/api/admin/auth/d3auth')).json();
  await page.goto('/admin/sign-in');
  await page.getByLabel('Issuer').fill('http://127.0.0.1:1');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not reach D3 Auth' })).toBeVisible();
  await axeClean(page, 'Test connection failed');
  expect(await (await api.get('/api/admin/auth/d3auth')).json()).toEqual(before);
});

test('configured against the fake issuer: Available, then link, unlink and turn off', async ({ page, context }) => {
  test.skip(issuer === null, 'the api cannot reach a fake issuer on this runner (see the header): the error path above stands in');
  const fake = issuer as FakeIssuer;

  // Linking needs a sign-in from the last five minutes: start from a fresh one.
  cookies = await signInCookies(api, operator);
  await context.clearCookies();
  await context.addCookies(cookies);

  await page.goto('/admin/sign-in');
  await page.getByLabel('Issuer').fill(fake.url);
  await page.getByLabel('Client ID').fill(fake.clientId);
  await secretField(page).fill(fake.clientSecret);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reached D3 Auth' })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await stepUpIfAsked(page, page.getByText('Saved. Sign in with D3 Auth is available.'));
  await expect(header(page)).toContainText('Available');
  await expect(header(page)).toContainText('set here in the console');
  // The secret is write-only: the field comes back empty and says one is saved.
  await expect(secretField(page)).toHaveValue('');
  await expect(page.getByText('Saved — enter a new one to replace it.')).toBeVisible();
  await axeClean(page, 'Sign in with D3 Auth, available');

  // Settings › Account: not linked yet, so Link…
  await page.goto('/settings/account');
  const row = page.locator('[data-d3auth-row]');
  await expect(row).toHaveAttribute('data-d3auth-row', 'unlinked');
  await expect(row).toContainText('Use your D3 Auth account to sign in here');
  await axeClean(page, 'Account, D3 Auth not linked');
  await row.getByRole('button', { name: 'Link D3 Auth' }).click();
  // Out to the issuer and back: the server lands on Mail.
  await page.waitForURL((url) => url.port !== new URL(fake.url).port && (url.pathname === '/' || url.pathname.startsWith('/mail')));
  expect(fake.stats.token).toBeGreaterThan(0);

  await page.goto('/settings/account');
  await expect(row).toHaveAttribute('data-d3auth-row', 'linked');
  await expect(row).toContainText(`Linked to ${USER.email}`);
  await axeClean(page, 'Account, D3 Auth linked');

  await row.getByRole('button', { name: 'Unlink D3 Auth' }).click();
  const confirm = page.getByRole('dialog', { name: 'Unlink D3 Auth' });
  await expect(confirm).toContainText('Postroom will no longer accept D3 Auth for this account. Your password keeps working.');
  await axeClean(page, 'Unlink confirm');
  await confirm.getByRole('button', { name: 'Unlink', exact: true }).click();
  await stepUpIfAsked(page, row.and(page.locator('[data-d3auth-row="unlinked"]')));
  await expect(row).toContainText('Use your D3 Auth account to sign in here');

  // Turn off, confirmed and stepped up.
  await page.goto('/admin/sign-in');
  await page.getByRole('button', { name: 'Turn off' }).click();
  const off = page.getByRole('dialog', { name: 'Turn off Sign in with D3 Auth' });
  await expect(off).toBeVisible();
  await off.getByRole('button', { name: 'Turn off' }).click();
  await stepUpIfAsked(page, page.getByText('Sign in with D3 Auth is off.'));
  await expect(header(page)).not.toContainText('set here in the console');
});

test('the account row is hidden while D3 Auth is not available', async ({ page }) => {
  const state = (await (await api.get('/api/auth/state')).json()) as { oidcAvailable: boolean };
  test.skip(state.oidcAvailable, 'D3 Auth is available on this stack');
  await page.goto('/settings/account');
  await expect(page.getByText('Two-factor authentication', { exact: true })).toBeVisible();
  await expect(page.locator('[data-d3auth-row]')).toHaveCount(0);
});
