// PST-T-0.8's exit demo, as a suite: first-run setup with TOTP enrolment, sign-out, password + TOTP
// sign-in, the admin Sessions page with a step-up revoke, /setup gone afterwards, and axe on /signin.
// Needs a stack on a FRESH database (see the task notes for the env it needs).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { freshCode, loadOperator, openNav, OPERATOR_DEFAULTS, saveOperator, signInWithPassword, type Operator } from './support.js';

// Serial, and patient: a TOTP step is burnt on use, so a test may wait for the next 30-second step.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const CSRF = { 'x-postroom-csrf': '1' };

async function authState(request: APIRequestContext): Promise<{ setupRequired: boolean; oidcConfigured: boolean }> {
  const res = await request.get('/api/auth/state');
  expect(res.ok()).toBe(true);
  return (await res.json()) as { setupRequired: boolean; oidcConfigured: boolean };
}

function requireOperator(): Operator {
  const operator = loadOperator();
  if (operator === null) throw new Error('no operator recorded: run the suite against a fresh database');
  return operator;
}

test('first run: setup enrols TOTP, then lands in the shell', async ({ page, request }) => {
  const { setupRequired } = await authState(request);
  test.skip(!setupRequired, 'setup already ran against this stack (an earlier project did it)');

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Postroom' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Display name' }).fill(OPERATOR_DEFAULTS.displayName);
  await page.getByRole('textbox', { name: 'Login' }).fill(OPERATOR_DEFAULTS.login);
  await page.getByLabel('Password', { exact: true }).fill(OPERATOR_DEFAULTS.password);
  await page.getByLabel('Confirm password').fill(OPERATOR_DEFAULTS.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await expect(page.getByTestId('totp-uri')).toHaveAttribute('href', /^otpauth:\/\/totp\/Postroom:operator\?/);

  const operator: Operator = { ...OPERATOR_DEFAULTS, secret, lastStep: 0 };
  saveOperator(operator);
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('/setup redirects to /signin once an operator exists', async ({ page, request }) => {
  expect((await authState(request)).setupRequired).toBe(false);

  const res = await request.get('/setup', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()['location']).toBe('/signin');

  await page.goto('/setup');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Postroom' })).toBeVisible();

  const again = await request.post('/api/auth/setup/begin', {
    headers: CSRF,
    data: { displayName: 'x', login: 'intruder', password: 'long enough password' },
  });
  expect(again.status()).toBe(409);
});

test('sign out, then sign in with password + TOTP and reach the admin Sessions page', async ({ page, context }) => {
  const operator = requireOperator();
  await signInWithPassword(page, operator);

  const cookie = (await context.cookies()).find((c) => c.name === 'postroom_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');

  await openNav(page);
  await page.getByRole('link', { name: 'Sessions' }).click();
  await expect(page.getByRole('heading', { name: /^Sessions/, level: 1 })).toBeVisible();
  await expect(page.getByText('This session')).toBeVisible();

  // Sign out from the account menu, and the shell is gone.
  await openNav(page);
  await page.getByRole('button', { name: new RegExp(`^${operator.displayName}`) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto('/admin/sessions');
  await expect(page).toHaveURL(/\/signin$/);
});

test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
  const operator = requireOperator();
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Login' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Those details did not match.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Authentication code' })).toBeHidden();
});

test('revoking another session asks for a fresh TOTP (step-up)', async ({ page, playwright, baseURL }) => {
  const operator = requireOperator();

  // A second session to revoke, signed in over the API from a separate cookie jar.
  const other = await playwright.request.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  const first = await other.post('/api/auth/signin', { headers: CSRF, data: { login: operator.login, password: operator.password } });
  expect(first.ok()).toBe(true);
  const { challenge } = (await first.json()) as { challenge: string };
  const second = await other.post('/api/auth/signin/totp', { headers: CSRF, data: { challenge, code: await freshCode(operator) } });
  expect(second.ok()).toBe(true);
  const own = (await other.get('/api/auth/sessions').then((r) => r.json())) as { sessions: { id: string; current: boolean }[] };
  const otherId = own.sessions.find((s) => s.current)?.id ?? '';
  expect(otherId).not.toBe('');

  await signInWithPassword(page, operator);
  await openNav(page);
  await page.getByRole('link', { name: 'Sessions' }).click();
  await page.locator(`button[data-session-id="${otherId}"]`).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: 'Verify and revoke' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Signed out .+'s session\.$/)).toBeVisible();

  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(false);
  await other.dispose();
});

test('/signin has no axe violations', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in to Postroom' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('Sign in with D3 Auth reaches the shell (needs FAKE_ISSUER_URL)', async ({ page, request }) => {
  test.skip(process.env['FAKE_ISSUER_URL'] === undefined, 'no fake issuer configured for this stack');
  expect((await authState(request)).oidcConfigured).toBe(true);

  await page.goto('/signin');
  await page.getByRole('link', { name: 'Sign in with D3 Auth' }).click();
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
  // The fake issuer's user carries roles ['admin'], so the Admin section appears (PST-REQ-007).
  await openNav(page);
  await expect(page.getByRole('link', { name: 'Sessions' })).toBeVisible();
  const state = (await page.request.get('/api/auth/state').then((r) => r.json())) as { method: string };
  expect(state.method).toBe('oidc');
});

test('with D3 Auth unreachable the button is disabled and the password path still works', async ({ page, request }) => {
  const res = await request.get('/api/auth/state');
  const { oidcConfigured, oidcAvailable } = (await res.json()) as { oidcConfigured: boolean; oidcAvailable: boolean };
  test.skip(!oidcConfigured || oidcAvailable, 'this stack is not pointed at an unreachable issuer');

  await page.goto('/signin');
  await expect(page.getByRole('button', { name: 'Sign in with D3 Auth' })).toBeDisabled();
  await expect(page.getByText('D3 Auth is unreachable right now. Your password still works.')).toBeVisible();
  await signInWithPassword(page, requireOperator());
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
});
