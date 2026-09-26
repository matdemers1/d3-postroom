// PST-T-9.5 / PST-REQ-150: the Rules screen. A rule made in the builder is saved as Sieve, reads
// back into the same row, a compile error in the Sieve view is shown with its line number, and the
// screen is axe clean in both views.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const CSRF = { 'x-postroom-csrf': '1' };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  cookies = await signInCookies(api, await ensureOperator(api));
  // Start from no builder script, so the screen opens empty.
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  await api.post('/api/sieve/deactivate', { headers: { ...CSRF, cookie } });
  await api.delete(`/api/sieve/scripts/${encodeURIComponent('Postroom rules')}`, { headers: { ...CSRF, cookie } });
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test('a builder rule round-trips through Sieve, and a compile error names its line — axe clean', async ({ page }) => {
  await page.goto('/account/rules');
  await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('textbox', { name: 'Text' }).fill('billing@shop.example');
  await page.getByRole('textbox', { name: 'Folder' }).fill('Receipts');
  await page.getByRole('button', { name: 'Save and turn on' }).click();
  await expect(page.getByText('now runs on new mail')).toBeVisible();

  // Builder → Sieve.
  await page.getByRole('tab', { name: 'Edit as Sieve' }).click();
  const source = page.getByRole('textbox', { name: 'Sieve script' });
  await expect(source).toHaveValue(/if address :contains "from" "billing@shop\.example" \{\n {2}fileinto :create "Receipts";\n\}/);
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);

  // Sieve → builder: the same row.
  await page.getByRole('tab', { name: 'Rules' }).click();
  await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue('billing@shop.example');
  await expect(page.getByRole('textbox', { name: 'Folder' })).toHaveValue('Receipts');

  // A compile error in the Sieve view is shown by line.
  await page.getByRole('tab', { name: 'Edit as Sieve' }).click();
  await source.fill('require "fileinto";\n\nfileinto "Receipts"\nkeep;\n');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText(/Line 4, column 1/)).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);
});
