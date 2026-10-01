// PST-T-0.8's exit demo, as a suite: first-run setup with TOTP enrolment, sign-out, password + TOTP
// sign-in, the admin Sessions page with a step-up revoke, /setup gone afterwards, and axe on /signin.
// Needs a stack on a FRESH database (see the task notes for the env it needs).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { freshCode, loadOperator, openNav, openPlace, OPERATOR_DEFAULTS, saveOperator, signInWithPassword, type Operator } from './support.js';

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

// PST-T-16.6: the key is a QR drawn in the browser and a grouped key with Copy (PST-REQ-196); 'Start
// over' and an expired enrolment both return to the first step keeping what was typed but the
// passwords (PST-DA-038); and Finish setup lands on the setup wizard, not the empty Inbox (PST-DA-036).
test('first run: setup enrols TOTP from a QR, recovers from an expired enrolment, then lands on the setup wizard', async ({ page, context, request }) => {
  const { setupRequired } = await authState(request);
  test.skip(!setupRequired, 'setup already ran against this stack (an earlier project did it)');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Any Content-Security-Policy complaint at all fails the test: the QR must need no new source.
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content.Security.Policy/i.test(message.text())) cspViolations.push(message.text());
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Postroom' })).toBeVisible();

  // A stack started with SETUP_TOKEN needs it here; one without accepts setup from a private address.
  const setupToken = process.env['E2E_SETUP_TOKEN'];
  if (setupToken !== undefined && setupToken !== '') await page.getByLabel('Setup token').fill(setupToken);
  await page.getByRole('textbox', { name: 'Display name' }).fill(OPERATOR_DEFAULTS.displayName);
  await page.getByRole('textbox', { name: 'Username' }).fill(OPERATOR_DEFAULTS.login);

  const password = page.getByLabel('Password', { exact: true });
  const confirm = page.getByLabel('Confirm password');
  const secretOf = async (): Promise<string> => (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  /** The first step again, with everything but the passwords still filled in. */
  const expectFirstStepKept = async () => {
    await expect(page.getByRole('form', { name: 'Operator account' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(OPERATOR_DEFAULTS.displayName);
    await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue(OPERATOR_DEFAULTS.login);
    if (setupToken !== undefined && setupToken !== '') await expect(page.getByLabel('Setup token')).toHaveValue(setupToken);
    await expect(password).toHaveValue('');
    await expect(confirm).toHaveValue('');
  };
  const continueWithPasswords = async () => {
    await password.fill(OPERATOR_DEFAULTS.password);
    await confirm.fill(OPERATOR_DEFAULTS.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(qr).toBeVisible();
  };

  // The enrolment step: from the click to a drawn QR, the only request is setup/begin itself.
  const requests: string[] = [];
  const onRequest = (r: { url: () => string }) => {
    requests.push(new URL(r.url()).pathname);
  };
  page.on('request', onRequest);
  await continueWithPasswords();
  const firstSecret = await secretOf();
  page.off('request', onRequest);
  expect(requests).toEqual(['/api/auth/setup/begin']);
  expect(await qr.evaluate((el: { tagName: string }) => el.tagName.toLowerCase())).toBe('svg');
  await expect(page.getByRole('form', { name: 'Enrol an authenticator' }).locator('img')).toHaveCount(0);

  // The key, in eight four-character groups, that still reads (and copies) as one secret.
  expect(firstSecret).toMatch(/^[A-Z2-7]{32}$/);
  const groups = await page.getByTestId('totp-secret').locator('span').allTextContents();
  expect(groups).toHaveLength(8);
  expect(groups.every((g) => /^[A-Z2-7]{4}$/.test(g))).toBe(true);
  expect(groups.join('')).toBe(firstSecret);
  await page.getByRole('button', { name: 'Copy setup key' }).click();
  await expect(page.getByRole('button', { name: 'Copied setup key' })).toBeVisible();
  // (No DOM lib in this project's tsconfig: the page's navigator is typed by hand.)
  type Clipboard = { navigator: { clipboard: { readText: () => Promise<string> } } };
  expect(await page.evaluate(() => (globalThis as unknown as Clipboard).navigator.clipboard.readText())).toBe(firstSecret);
  await expect(page.getByTestId('totp-uri')).toHaveAttribute('href', /^otpauth:\/\/totp\/Postroom:operator\?/);

  // 'Start over': back to the first step, and Continue issues a new key.
  await page.getByRole('button', { name: 'Start over' }).click();
  await expectFirstStepKept();
  await continueWithPasswords();
  const secondSecret = await secretOf();
  expect(secondSecret).not.toBe(firstSecret);

  // An enrolment the server has forgotten (setup_expired, faked here — the real one takes 15
  // minutes) returns to the first step with the reason, rather than a dead enrolment step.
  await page.route('**/api/auth/setup/complete', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'setup_expired' }) }), { times: 1 });
  await page.getByRole('textbox', { name: 'Authentication code' }).fill('000000');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('That took too long — press Continue to get a new key')).toBeVisible();
  await expectFirstStepKept();
  await page.unroute('**/api/auth/setup/complete');

  await continueWithPasswords();
  const secret = await secretOf();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(secret).not.toBe(secondSecret);

  const operator: Operator = { ...OPERATOR_DEFAULTS, secret, lastStep: 0 };
  saveOperator(operator);
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // PST-T-16.7: ten recovery codes, shown once, behind "I have saved these".
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have saved these' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // The operator is admin, so the next thing is the setup wizard — not an empty Inbox.
  await expect(page).toHaveURL(/\/admin\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up mail', level: 1 })).toBeVisible();
  expect(cspViolations).toEqual([]);
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

test('sign out, then sign in with password + TOTP and reach the admin Sign-in sessions page', async ({ page, context }) => {
  const operator = requireOperator();
  await signInWithPassword(page, operator);

  const cookie = (await context.cookies()).find((c) => c.name === 'postroom_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');

  // PST-T-14.3: the Admin console is a place of its own, behind the account menu.
  await openPlace(page, 'Admin console');
  await openNav(page);
  await page.getByRole('navigation', { name: 'Admin console' }).getByRole('link', { name: 'Sign-in sessions' }).click();
  await expect(page.getByRole('heading', { name: /^Sign-in sessions/, level: 1 })).toBeVisible();
  await expect(page.getByText('This browser')).toBeVisible();

  // Sign out from the account menu, and the shell is gone.
  await openNav(page);
  await page.getByRole('button', { name: new RegExp(`^${operator.displayName}`) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  // PST-DA-040: signed out away from '/', the page it left is remembered as ?next=.
  await expect(page).toHaveURL(/\/signin\?next=%2Fadmin%2Fsessions$/);
  await page.goto('/admin/sessions');
  await expect(page).toHaveURL(/\/signin\?next=%2Fadmin%2Fsessions$/);
});

test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
  const operator = requireOperator();
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Address or username' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('That address and password don’t match.')).toBeVisible();
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
  await page.goto('/admin/sessions');
  await page.locator(`button[data-session-id="${otherId}"]`).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: 'Verify and sign out' }).click();
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
  // The fake issuer's user carries roles ['admin'], so the Admin console is offered (PST-REQ-007).
  await openNav(page);
  await page.locator('button.d3-acct').click();
  await expect(page.getByRole('menuitem', { name: /^Admin console/ })).toBeVisible();
  await page.keyboard.press('Escape');
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
