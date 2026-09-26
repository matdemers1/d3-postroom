// PST-T-4.9's exit demo, as a suite: a common password on first-run Setup names which rule failed,
// a signed-in user changes their password over Change password (ending other sessions), and
// Devices (the caller's own /api/auth/sessions) lists and revokes a session after step-up. Axe on
// both new screens. Labelled "Devices" in the nav, not "Sessions", so it never collides with the
// pre-existing admin Sessions link that shares this sidebar.
//
// Runs alongside auth.spec.ts against the same fresh stack: this file sorts before it, so the
// weak-password test on Setup gets first crack at the not-yet-set-up operator, then this file
// finishes setup over the API (ensureOperator) before auth.spec.ts's own setup test runs (which
// already skips once an earlier file has done it). Changing the operator's password here persists
// the new value into the shared operator file, so every spec after this one keeps working.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ensureOperator, freshCode, loadOperator, openNav, saveOperator, signInWithPassword, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const CSRF = { 'x-postroom-csrf': '1' };
// 26 characters, no digits-run trivia, and none of the CONTEXT_WORDS or common-password entries.
const STRONG_PASSWORD = 'a fresh strong passphrase 2026';
// 12 characters, meets the length policy, but is in the breached-password corpus.
const COMMON_PASSWORD = 'q1w2e3r4t5y6';

async function authState(request: APIRequestContext): Promise<{ setupRequired: boolean }> {
  const res = await request.get('/api/auth/state');
  expect(res.ok()).toBe(true);
  return (await res.json()) as { setupRequired: boolean };
}

function requireOperator(): Operator {
  const operator = loadOperator();
  if (operator === null) throw new Error('no operator recorded: run the suite against a fresh database');
  return operator;
}

/** Signs in over the API and returns the cookie-carrying request context, so a test can watch it end. */
async function signInOtherContext(playwright: { request: { newContext: (opts: object) => Promise<APIRequestContext> } }, baseURL: string | undefined, operator: Operator): Promise<APIRequestContext> {
  const other = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const first = await other.post('/api/auth/signin', { headers: CSRF, data: { login: operator.login, password: operator.password } });
  if (!first.ok()) throw new Error(`signin answered ${String(first.status())}`);
  const { challenge } = (await first.json()) as { challenge: string };
  const second = await other.post('/api/auth/signin/totp', { headers: CSRF, data: { challenge, code: await freshCode(operator) } });
  if (!second.ok()) throw new Error(`signin/totp answered ${String(second.status())}`);
  return other;
}

test('Setup with a common password names which rule failed', async ({ page, request }) => {
  const { setupRequired } = await authState(request);
  test.skip(!setupRequired, 'setup already ran against this stack (an earlier file or project did it)');

  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Set up Postroom' })).toBeVisible();

  const setupToken = process.env['E2E_SETUP_TOKEN'];
  if (setupToken !== undefined && setupToken !== '') await page.getByLabel('Setup token').fill(setupToken);
  await page.getByRole('textbox', { name: 'Display name' }).fill('E2E Operator');
  await page.getByRole('textbox', { name: 'Login' }).fill('operator');
  await page.getByLabel('Password', { exact: true }).fill(COMMON_PASSWORD);
  await page.getByLabel('Confirm password').fill(COMMON_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(/common breached passwords/)).toBeVisible();
  // Refused, so setup did not advance to TOTP enrolment.
  await expect(page.getByTestId('totp-secret')).toHaveCount(0);
  await expect(page).toHaveURL(/\/setup$/);
});

test('a signed-in user changes their password, ending other sessions', async ({ page, request, playwright, baseURL }) => {
  const operator = await ensureOperator(request);

  // A second session, so this test can watch it end when the password changes.
  const other = await signInOtherContext(playwright, baseURL, operator);
  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(true);

  await signInWithPassword(page, operator);
  await openNav(page);
  await page.getByRole('link', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Change password', level: 1 })).toBeVisible();

  await page.getByLabel('Current password', { exact: true }).fill(operator.password);
  await page.getByLabel('New password', { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel('Confirm new password', { exact: true }).fill(STRONG_PASSWORD);
  await expect(page.getByRole('checkbox', { name: 'Sign out every other session' })).toBeChecked();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByText(/^Password changed\. Signed out \d+ other session/)).toBeVisible();

  operator.password = STRONG_PASSWORD;
  saveOperator(operator);

  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(false);
  await other.dispose();

  // This session survived (only the OTHER session was ended); sign it out deliberately so the
  // changed password can be proven by signing back in with it.
  await openNav(page);
  await page.getByRole('button', { name: new RegExp(`^${operator.displayName}`) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);

  await page.getByRole('textbox', { name: 'Login' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
});

test('Devices lists sessions and revokes one after step-up', async ({ page, playwright, baseURL }) => {
  const operator = requireOperator();

  const other = await signInOtherContext(playwright, baseURL, operator);
  const own = (await other.get('/api/auth/sessions').then((r) => r.json())) as { sessions: { id: string; current: boolean }[] };
  const otherId = own.sessions.find((s) => s.current)?.id ?? '';
  expect(otherId).not.toBe('');

  await signInWithPassword(page, operator);
  await openNav(page);
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  await expect(page.getByText('This session')).toBeVisible();

  await page.locator(`button[data-session-id="${otherId}"]`).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: 'Verify and sign out' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Signed that session out.')).toBeVisible();

  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(false);
  await other.dispose();
});

test('Change password and Devices have no axe violations', async ({ page }) => {
  const operator = requireOperator();
  await signInWithPassword(page, operator);

  await page.goto('/account/password');
  await expect(page.getByRole('heading', { name: 'Change password', level: 1 })).toBeVisible();
  const passwordResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(passwordResults.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.goto('/account/sessions');
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  const sessionsResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(sessionsResults.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
