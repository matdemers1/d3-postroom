// PST-T-9.5 / PST-REQ-150, PST-T-17.11: the Rules & sorting screen. A rule made in the builder is
// saved as Sieve, reads back into the same row, a compile error in the Sieve view is shown with its
// line number, and the screen is axe clean in both views. The two views are a radiogroup ("How to
// edit") in the editor card's head; the other ways to save sit behind the Save button's chevron.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
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

/** The editor's Rules / Edit as Sieve switch (a SegmentedControl: radios, not tabs). */
const view = (page: Page, name: 'Rules' | 'Edit as Sieve') => page.getByRole('radiogroup', { name: 'How to edit' }).getByRole('radio', { name, exact: true });

test('a builder rule round-trips through Sieve, and a compile error names its line — axe clean', async ({ page }) => {
  await page.goto('/settings/rules');
  await expect(page.getByRole('heading', { name: 'Rules & sorting', level: 1 })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('textbox', { name: 'Text' }).fill('billing@shop.example');
  // One destination picker: the real mailboxes, then the Sorted for you buckets (PST-T-16.9).
  await page.getByRole('combobox', { name: 'Destination' }).click();
  await page.getByRole('option', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Save and turn on' }).click();
  await expect(page.getByText('now runs on new mail')).toBeVisible();

  // Builder → Sieve.
  await view(page, 'Edit as Sieve').click();
  const source = page.getByRole('textbox', { name: 'Sieve script' });
  await expect(source).toHaveValue(/if address :contains "from" "billing@shop\.example" \{\n {2}fileinto :create "Archive";\n\}/);
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);

  // Sieve → builder: the same row.
  await view(page, 'Rules').click();
  await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue('billing@shop.example');
  // The trigger also draws its ▾ glyph, so match the chosen label, not the whole text.
  await expect(page.getByRole('combobox', { name: 'Destination' })).toHaveText(/^Archive/);
  // Remove follows the fields of its rule.
  const remove = page.getByRole('button', { name: 'Remove rule 1' });
  const destination = page.getByRole('combobox', { name: 'Destination' });
  expect((await remove.boundingBox())?.y ?? 0).toBeGreaterThan(((await destination.boundingBox())?.y ?? 0) + 1);

  // A compile error in the Sieve view is shown by line.
  await view(page, 'Edit as Sieve').click();
  await source.fill('require "fileinto";\n\nfileinto "Receipts"\nkeep;\n');
  await page.getByRole('button', { name: 'Check syntax' }).click();
  await expect(page.getByText(/Line 4, column 1/)).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);
});

test('one action row: Enter saves and turns on, the chevron saves without, and turns rules off', async ({ page }) => {
  await page.goto('/settings/rules');
  const editor = page.getByRole('region', { name: 'Your rules' });
  // The previous test left one rule, saved and running; it is the only script, so no Scripts card.
  await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue('billing@shop.example');
  await expect(editor.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scripts' })).toHaveCount(0);

  // Enter in a field submits the form's one primary action.
  await page.getByRole('textbox', { name: 'Text' }).fill('receipts@shop.example');
  await page.getByRole('textbox', { name: 'Text' }).press('Enter');
  await expect(page.getByText('now runs on new mail')).toBeVisible();

  // Turn rules off, from the Save menu while the open script runs.
  await page.getByRole('button', { name: 'More ways to save' }).click();
  await page.getByRole('menuitem', { name: 'Turn rules off' }).click();
  await expect(page.getByText('No rules run now')).toBeVisible();
  await expect(editor.getByText('Not running', { exact: true })).toBeVisible();

  // Save without turning on: saved, still not running, and the menu no longer offers Turn rules off.
  await page.getByRole('button', { name: 'More ways to save' }).click();
  await expect(page.getByRole('menuitem', { name: 'Turn rules off' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Save without turning on' }).click();
  await expect(page.getByText('Saved “Postroom rules”.')).toBeVisible();
  await expect(editor.getByText('Not running', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze()).violations).toEqual([]);
});
