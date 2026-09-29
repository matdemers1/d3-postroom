// PST-T-4.9's exit demo, as a suite: a common password on first-run Setup names which rule failed,
// a signed-in user changes their password from Settings › Account (ending other sessions), and
// Devices (the caller's own /api/auth/sessions) lists and revokes a session after step-up. Axe on
// both new screens. Since PST-T-14.3 both live in Settings (reached from the account menu): the
// caller's own web sessions are "Browser sessions", never "Sessions", so nothing collides with the
// Admin console's "Sign-in sessions".
//
// Runs alongside auth.spec.ts against the same fresh stack: this file sorts before it, so the
// weak-password test on Setup gets first crack at the not-yet-set-up operator, then this file
// finishes setup over the API (ensureOperator) before auth.spec.ts's own setup test runs (which
// already skips once an earlier file has done it). Changing the operator's password here persists
// the new value into the shared operator file, so every spec after this one keeps working.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ensureOperator, freshCode, isPhone, loadOperator, openNav, openPlace, saveOperator, signInWithPassword, type Operator } from './support.js';

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
  await page.getByRole('textbox', { name: 'Username' }).fill('operator');
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
  await openPlace(page, 'Settings');
  // On a phone Settings opens at its index screen (PST-T-14.8); Account is its first row.
  if (isPhone(page)) await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();

  // PST-T-15.6: the Password row's "Change…" opens the form in place, inside the Sign-in card.
  await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByLabel('Current password', { exact: true })).toBeFocused();
  await page.getByLabel('Current password', { exact: true }).fill(operator.password);
  await page.getByLabel('New password', { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel('Confirm new password', { exact: true }).fill(STRONG_PASSWORD);
  await expect(page.getByText(/^Long and varied · \d+ characters$/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Sign out other sessions' })).toBeChecked();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Update password' }).click();

  await expect(page.getByText(/^Password changed\. Signed out \d+ other session/)).toBeVisible();
  // The form folds away once it has done its job, and focus is back on the button that opened it.
  await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change password' })).toBeFocused();

  operator.password = STRONG_PASSWORD;
  saveOperator(operator);

  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(false);
  await other.dispose();

  // This session survived (only the OTHER session was ended); sign it out deliberately so the
  // changed password can be proven by signing back in with it.
  await openNav(page);
  await page.getByRole('button', { name: new RegExp(`^${operator.displayName}`) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  // PST-DA-040: signing out away from '/' remembers the page as ?next=.
  await expect(page).toHaveURL(/\/signin\?next=%2Fsettings%2Faccount$/);

  await page.getByRole('textbox', { name: 'Address or username' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Verify' }).click();
  // PST-DA-040: signing back in returns to the page the session expired away from.
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
});

test('Browser sessions lists sessions and revokes one after step-up', async ({ page, playwright, baseURL }) => {
  const operator = requireOperator();

  const other = await signInOtherContext(playwright, baseURL, operator);
  const own = (await other.get('/api/auth/sessions').then((r) => r.json())) as { sessions: { id: string; current: boolean }[] };
  const otherId = own.sessions.find((s) => s.current)?.id ?? '';
  expect(otherId).not.toBe('');

  await signInWithPassword(page, operator);
  await openPlace(page, 'Settings');
  await openNav(page);
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Security & devices' }).click();
  await expect(page.getByRole('heading', { name: 'Browser sessions', level: 1 })).toBeVisible();
  await expect(page.getByText('This session')).toBeVisible();

  await page.locator(`button[data-session-id="${otherId}"]`).click();
  // PST-DA-030: a plain confirm first (no auth code needed yet), then the step-up code prompt.
  const confirmDialog = page.getByRole('dialog', { name: 'Sign out this session?' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Sign out' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: 'Verify and sign out' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Signed that session out.')).toBeVisible();

  expect((await other.get('/api/auth/state').then((r) => r.json()) as { signedIn: boolean }).signedIn).toBe(false);
  await other.dispose();
});

test('Account and Browser sessions have no axe violations', async ({ page }) => {
  const operator = requireOperator();
  await signInWithPassword(page, operator);

  await page.goto('/settings/account');
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
  // Axe over the open change-password form too (strength meter, CodeInput, the footer).
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible();
  const passwordResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(passwordResults.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Browser sessions', level: 1 })).toBeVisible();
  const sessionsResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(sessionsResults.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
