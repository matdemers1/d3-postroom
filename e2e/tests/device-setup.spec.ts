// PST-T-16.16 (PST-DA-039; PST-REQ-139, PST-REQ-153): Connect a device. The page offers iPhone, Mac,
// Thunderbird and Other; Other is the server settings by hand — IMAP host:993, SMTP host:465 and 587,
// and the username — each with a Copy that puts exactly that value on the clipboard; the app-password
// reveal shows the same block; and the iPhone's QR is a one-time URL that answers 410 on second use.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, freshCode, loadOperator, signInCookies, tag, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });
// One block at every width; mobile.spec.ts checks the page fits a phone.
test.skip(({ isMobile }) => isMobile, 'the settings block is the same at every width');

interface Endpoint {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
}

interface MailSettings {
  address: string | null;
  username: string | null;
  imap: Endpoint;
  smtp: Endpoint[];
}

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let settings: MailSettings;

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  const res = await api.get('/api/mobileconfig/settings');
  expect(res.ok()).toBe(true);
  settings = (await res.json()) as MailSettings;
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

function requireOperator(): Operator {
  const operator = loadOperator();
  if (operator === null) throw new Error('no operator recorded');
  return operator;
}

// (No DOM lib in this project's tsconfig: the page's navigator is typed by hand.)
type Clipboard = { navigator: { clipboard: { readText: () => Promise<string> } } };
const clipboard = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Clipboard).navigator.clipboard.readText());

/** Every Copy in the settings block, by its accessible name, with the value it must copy. */
function expectedCopies(): [string, string][] {
  const smtpHost = settings.smtp[0]?.host ?? '';
  const copies: [string, string][] = [
    ['IMAP server', settings.imap.host],
    ['IMAP port', String(settings.imap.port)],
    ['SMTP server', smtpHost],
    ...settings.smtp.map((s): [string, string] => [`SMTP port ${String(s.port)}`, String(s.port)]),
  ];
  if (settings.username !== null) copies.push(['username', settings.username]);
  return copies;
}

/** The block shows each value and each Copy puts exactly that value on the clipboard. */
async function checkSettingsBlock(page: Page): Promise<void> {
  const block = page.getByTestId('server-settings');
  await expect(block).toBeVisible();
  for (const [label, value] of expectedCopies()) {
    await expect(block.getByText(value, { exact: true }).first()).toBeVisible();
    await block.getByRole('button', { name: `Copy ${label}`, exact: true }).click();
    await expect(block.getByRole('button', { name: `Copied ${label}`, exact: true })).toBeVisible();
    expect(await clipboard(page), label).toBe(value);
  }
}

test('the settings are IMAP 993, SMTP 465 and 587, and the address as username', () => {
  expect(settings.imap.port).toBe(993);
  expect(settings.smtp.map((s) => s.port)).toEqual([465, 587]);
  expect(settings.username).toBe(settings.address);
});

test('Connect a device offers four clients; Other is the settings block with a Copy on each', async ({ page }) => {
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Device' }).getByRole('tab');
  await expect(tabs).toHaveText(['iPhone', 'Mac', 'Thunderbird', 'Other']);

  await page.getByRole('tab', { name: 'Thunderbird' }).click();
  await expect(page.getByText('Thunderbird finds the servers by itself.')).toBeVisible();

  await page.getByRole('tab', { name: 'Other' }).click();
  await checkSettingsBlock(page);
});

test('the app-password reveal shows the same settings block', async ({ page }) => {
  await page.goto('/settings/security/devices');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  const label = `e2e device ${tag()}`;
  // PST-T-16.23: the create form opens on demand, from the page header.
  await page.getByRole('button', { name: 'New app password' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(label);
  await page.getByRole('button', { name: 'Create password' }).click();
  await expect(page.getByRole('heading', { name: `Password for ${label}` })).toBeVisible();
  await expect(page.getByText('Waiting for the app to sign in.')).toBeVisible();
  await checkSettingsBlock(page);
});

test('the iPhone QR is a one-time URL: the first open is the profile, the second is 410', async ({ page, playwright }, testInfo) => {
  const operator = requireOperator();
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Show QR code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: 'Verify' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('device-qr')).toBeVisible();
  await expect(page.getByText('Waiting for your iPhone to open the code.')).toBeVisible();
  const href = (await page.getByTestId('open-on-device').getAttribute('href')) ?? '';
  expect(href).toMatch(/\/api\/mobileconfig\/once\/[A-Za-z0-9_-]{98}$/);

  // The phone: no cookie, no CSRF header.
  const baseURL = testInfo.project.use.baseURL;
  const phone = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const path = new URL(href).pathname;
  const first = await phone.get(path);
  expect(first.status()).toBe(200);
  expect(first.headers()['content-type']).toContain('application/x-apple-aspen-config');
  const second = await phone.get(path);
  expect(second.status()).toBe(410);
  await phone.dispose();

  await expect(page.getByText('Profile downloaded. Install it in Settings, then open Mail.')).toBeVisible({ timeout: 15_000 });
});
