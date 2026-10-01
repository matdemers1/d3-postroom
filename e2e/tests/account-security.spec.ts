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
//
// PST-T-16.7 (PST-REQ-197): a recovery code signs in once in place of the TOTP code and is refused
// the second time, and Security & devices makes a new set behind step-up that retires the old one.
//
// PST-T-16.26 (PST-REQ-200): a recovery-code sign-in lands on 'Set up a new authenticator'; until it
// is done, step-up-gated actions answer 403 totp_reenrol_required. Re-enrolling replaces the
// operator's TOTP secret — saved into the shared operator file, so every spec after this one signs
// in with the new authenticator — and issues a new set of codes, which can then be regenerated
// behind a step-up made with the new authenticator.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { ensureOperator, freshCode, isPhone, loadOperator, openNav, openPlace, saveOperator, signInWithPassword, tag, type Operator } from './support.js';

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
  // PST-DA-040: signing out away from '/' remembers the page as ?next=. On a phone the account menu
  // lives on the place index (PST-T-17.8), so that is the page it left.
  await expect(page).toHaveURL(/\/signin\?next=%2Fsettings(%2Faccount)?$/);

  await page.getByRole('textbox', { name: 'Address or username' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Verify' }).click();
  // PST-DA-040: signing back in returns to the page the session expired away from — on a phone the
  // Settings index, where its account menu lives (PST-T-17.8).
  if (isPhone(page)) {
    await expect(page).toHaveURL(/\/settings$/);
  } else {
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
  }
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
  // PST-T-16.3: the section opens on device setup; Browser sessions is its second page.
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  await page.goto('/settings/security/sessions');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  await expect(page.getByText('This browser')).toBeVisible();

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

/** A fresh set of recovery codes over the API: sign in, step up, regenerate. */
async function regenerateOverApi(playwright: { request: { newContext: (opts: object) => Promise<APIRequestContext> } }, baseURL: string | undefined, operator: Operator): Promise<string[]> {
  const ctx = await signInOtherContext(playwright, baseURL, operator);
  try {
    const stepUp = await ctx.post('/api/auth/step-up', { headers: CSRF, data: { code: await freshCode(operator) } });
    if (!stepUp.ok()) throw new Error(`step-up answered ${String(stepUp.status())}`);
    const regen = await ctx.post('/api/auth/recovery-codes', { headers: CSRF });
    if (!regen.ok()) throw new Error(`recovery-codes answered ${String(regen.status())}`);
    return ((await regen.json()) as { recoveryCodes: string[] }).recoveryCodes;
  } finally {
    await ctx.dispose();
  }
}

/** Password, then a recovery code in place of the TOTP code, over the API: the status it answers. */
async function recoverySignInStatus(request: APIRequestContext, operator: Operator, code: string): Promise<number> {
  const first = await request.post('/api/auth/signin', { headers: CSRF, data: { login: operator.login, password: operator.password } });
  if (!first.ok()) throw new Error(`signin answered ${String(first.status())}`);
  const { challenge } = (await first.json()) as { challenge: string };
  return (await request.post('/api/auth/signin/totp', { headers: CSRF, data: { challenge, code } })).status();
}

test('signs in with a recovery code once, re-enrols a new authenticator, and steps up with it; the second use of the code is refused', async ({ page, playwright, baseURL }) => {
  const operator = requireOperator();
  const codes = await regenerateOverApi(playwright, baseURL, operator);
  expect(codes).toHaveLength(10);
  const code = codes[0] ?? '';
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);

  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Address or username' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Authentication code' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await expect(page.getByRole('textbox', { name: 'Authentication code' })).toHaveCount(0);
  // Typed the way a person copies it off paper: lower case, a space for the dash.
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code.toLowerCase().replace('-', ' '));
  await page.getByRole('button', { name: 'Verify' }).click();

  // PST-REQ-200: the code stood in for a lost authenticator, so replacing it comes first.
  await expect(page.getByRole('heading', { name: 'Set up a new authenticator' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  // Until it is replaced, anything behind step-up is refused — step-up itself included.
  const gated = await page.request.post('/api/auth/recovery-codes', { headers: CSRF });
  expect(gated.status()).toBe(403);
  expect(await gated.json()).toEqual({ error: 'totp_reenrol_required' });
  const stepUpFirst = await page.request.post('/api/auth/step-up', { headers: CSRF, data: { code: await freshCode(operator) } });
  expect(stepUpFirst.status()).toBe(403);
  expect(((await page.request.get('/api/auth/recovery-codes').then((r) => r.json())) as { remaining: number }).remaining).toBe(9);

  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(secret).not.toBe(operator.secret);
  const oldSecret = operator.secret;
  // The authenticator is the new one from here on, for this spec and every one after it.
  operator.secret = secret;
  saveOperator(operator);
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Set up authenticator' }).click();

  // A fresh set of ten codes, shown once, behind "I have saved these".
  const reissued = page.getByRole('list', { name: 'Recovery codes' });
  await expect(reissued.getByRole('listitem')).toHaveCount(10);
  const reissuedCodes = (await reissued.getByRole('listitem').allTextContents()).map((t) => t.trim());
  for (const c of reissuedCodes) expect(codes).not.toContain(c);
  const carryOn = page.getByRole('button', { name: 'Continue to Postroom' });
  await expect(carryOn).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have saved these' }).click();
  await carryOn.click();
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();

  const status = (await page.request.get('/api/auth/recovery-codes').then((r) => r.json())) as { total: number; remaining: number };
  expect(status).toMatchObject({ total: 10, remaining: 10 });
  const state = (await page.request.get('/api/auth/state').then((r) => r.json())) as { reenrolRequired?: boolean };
  expect(state.reenrolRequired).toBe(false);

  // Regenerate behind step-up, made with the new authenticator.
  await page.goto('/settings/account');
  const section = page.getByRole('region', { name: 'Recovery codes' });
  await expect(section.getByTestId('recovery-status')).toHaveText(/^10 of 10 left/);
  await section.getByRole('button', { name: 'Make new codes' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make new recovery codes?' });
  await confirm.getByRole('button', { name: 'Make new codes' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await stepUp.getByRole('button', { name: 'Verify and make new codes' }).click();
  await expect(stepUp).toBeHidden();
  const regenerated = section.getByRole('list', { name: 'Recovery codes' });
  await expect(regenerated.getByRole('listitem')).toHaveCount(10);
  for (const c of (await regenerated.getByRole('listitem').allTextContents()).map((t) => t.trim())) expect(reissuedCodes).not.toContain(c);
  await section.getByRole('checkbox', { name: 'I have saved these' }).click();
  await section.getByRole('button', { name: 'Done' }).click();
  await expect(regenerated).toHaveCount(0);

  // The old authenticator is dead: a code from it no longer signs in.
  const viaOld = await page.request.post('/api/auth/signin', { headers: CSRF, data: { login: operator.login, password: operator.password } });
  const { challenge } = (await viaOld.json()) as { challenge: string };
  const oldCode = new TOTP({ secret: Secret.fromBase32(oldSecret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
  expect((await page.request.post('/api/auth/signin/totp', { headers: CSRF, data: { challenge, code: oldCode } })).status()).toBe(401);

  // The same recovery code again, in a browser with no session: refused, and the reason is on screen.
  const fresh = await page.context().browser()?.newContext(baseURL === undefined ? {} : { baseURL });
  if (fresh === undefined) throw new Error('no browser to open a second context in');
  const again = await fresh.newPage();
  await again.goto('/signin');
  await again.getByRole('textbox', { name: 'Address or username' }).fill(operator.login);
  await again.getByLabel('Password', { exact: true }).fill(operator.password);
  await again.getByRole('button', { name: 'Sign in', exact: true }).click();
  await again.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await again.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await again.getByRole('button', { name: 'Verify' }).click();
  await expect(again.getByText('That recovery code didn’t match, or it’s already been used.')).toBeVisible();
  await expect(again.getByRole('heading', { name: 'Mail', level: 1 })).toHaveCount(0);
  await fresh.close();
});

test('Account makes a new set of recovery codes behind step-up, retiring the old set', async ({ page, request, playwright, baseURL }) => {
  const operator = requireOperator();
  const old = await regenerateOverApi(playwright, baseURL, operator);

  await signInWithPassword(page, operator);
  await page.goto('/settings/account');
  const section = page.getByRole('region', { name: 'Recovery codes' });
  await expect(section).toBeVisible();
  await expect(section.getByTestId('recovery-status')).toHaveText(/^10 of 10 left/);

  await section.getByRole('button', { name: 'Make new codes' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make new recovery codes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Make new codes' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await stepUp.getByRole('button', { name: 'Verify and make new codes' }).click();
  await expect(stepUp).toBeHidden();

  const list = section.getByRole('list', { name: 'Recovery codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  const shown = (await list.getByRole('listitem').allTextContents()).map((t) => t.trim());
  for (const code of shown) expect(old).not.toContain(code);
  await expect(section.getByRole('button', { name: 'Copy all' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Download .txt' })).toBeVisible();

  // Done waits for the checkbox.
  const done = section.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await section.getByRole('checkbox', { name: 'I have saved these' }).click();
  await expect(done).toBeEnabled();
  await done.click();
  await expect(list).toHaveCount(0);
  await expect(section.getByTestId('recovery-status')).toHaveText(/^10 of 10 left/);

  // The old set is gone; the new one works.
  expect(await recoverySignInStatus(request, operator, old[1] ?? '')).toBe(401);
  expect(await recoverySignInStatus(request, operator, shown[0] ?? '')).toBe(200);
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

  await page.goto('/settings/security/sessions');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  const sessionsResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(sessionsResults.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

// PST-T-16.23 (PST-DA-054): App passwords, Addresses and Templates open on their list; the create
// form is not in the DOM until the header "New …" button is pressed, Cancel removes it, and a create
// closes it with the new item in the list.
test('App passwords, Addresses and Templates list first and open their create form on demand', async ({ page }) => {
  const operator = requireOperator();
  await signInWithPassword(page, operator);
  const t = tag();

  const firstSection = (name: RegExp) => expect(page.locator('section.d3-sec').first()).toHaveAccessibleName(name);

  // App passwords (Devices).
  await page.goto('/settings/security/devices');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  await firstSection(/^App passwords/);
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'New app password' }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New app password' }).click();
  const label = `e2e device ${t}`;
  await page.getByRole('textbox', { name: 'Name' }).fill(label);
  await page.getByRole('button', { name: 'Create password' }).click();
  await expect(page.getByRole('heading', { name: `Password for ${label}` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Revoke ${label}` })).toBeVisible();

  // Addresses (masked aliases).
  await page.goto('/settings/addresses');
  await expect(page.getByRole('heading', { name: 'Addresses', level: 1 })).toBeVisible();
  await firstSection(/^Masked aliases/);
  await expect(page.getByRole('textbox', { name: 'Site' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New alias' }).click();
  await expect(page.getByRole('textbox', { name: 'Site' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Site' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New alias' }).click();
  const site = `shop-${t}.example`;
  await page.getByRole('textbox', { name: 'Site' }).fill(site);
  await page.getByRole('button', { name: 'Create alias' }).click();
  await expect(page.getByRole('textbox', { name: 'Site' })).toHaveCount(0);
  await expect(page.getByText(`For ${site} ·`)).toBeVisible();

  // Templates.
  await page.goto('/settings/templates');
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
  await firstSection(/^Saved replies/);
  await expect(page.getByRole('textbox', { name: 'Shortcut' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New template' }).click();
  await expect(page.getByRole('textbox', { name: 'Shortcut' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Shortcut' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New template' }).click();
  const name = `Thank you ${t}`;
  await page.getByRole('textbox', { name: 'Shortcut' }).fill(`ty${t}`);
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Body' }).fill('Thanks for reaching out.');
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByRole('button', { name: `Edit ${name}` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Shortcut' })).toHaveCount(0);
});
