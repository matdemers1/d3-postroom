// PST-T-11.10 / PST-REQ-178: the Suppression list admin screen. It lists a seeded hard bounce with
// the reply that caused it, is axe clean, and adds and removes an address through the
// confirm-and-step-up modal — each change audited (PST-REQ-181) and reflected by the API.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, freshCode, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const CSRF = { 'x-postroom-csrf': '1' };

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let operator: Awaited<ReturnType<typeof ensureOperator>>;

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

const cookieHeader = (): string => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function listed(address: string): Promise<boolean> {
  const res = await api.get(`/api/admin/suppressions?q=${encodeURIComponent(address)}`, { headers: { cookie: cookieHeader() } });
  const body = (await res.json()) as { suppressions: { address: string }[] };
  return body.suppressions.some((s) => s.address === address);
}

test('lists a seeded hard bounce with the reply that caused it, axe clean', async ({ page }) => {
  const address = `gone-${Date.now()}@render.test`;
  const res = await api.post('/api/admin/suppressions/dev-seed-bounce', { headers: { ...CSRF, cookie: cookieHeader() }, data: { address } });
  if (res.status() === 404) throw new Error('the stack has no dev-seed-bounce route: start the api with POSTROOM_E2E_SEED=1');
  expect(res.ok()).toBe(true);

  await page.goto('/admin/suppressions');
  await expect(page.getByRole('heading', { name: 'Suppressions', level: 1 })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search' }).fill(address);
  // A table row on desktop, a card on a phone (PST-T-17.2).
  const row = page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: address });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Hard bounce');
  await expect(row).toContainText('550 5.1.1 No such user');

  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations).toEqual([]);
});

test('adds an address and removes it again, each through the step-up modal', async ({ page }) => {
  const address = `trap-${Date.now()}@manual.test`;
  await page.goto('/admin/suppressions');
  await expect(page.getByRole('heading', { name: 'Suppressions', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add address' }).click();
  const add = page.getByRole('dialog', { name: /Add an address/ });
  await expect(add).toBeVisible();
  await add.getByRole('textbox', { name: 'Address' }).fill(address);
  await add.getByRole('textbox', { name: 'Reason' }).fill('a known spam trap');
  await add.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  const addResults = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(addResults.violations).toEqual([]);
  await add.getByRole('button', { name: 'Verify and add' }).click();

  await expect(page.getByText(`${address} is on the suppression list.`)).toBeVisible();
  expect(await listed(address)).toBe(true);
  await page.getByRole('searchbox', { name: 'Search' }).fill(address);
  const row = page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: address });
  await expect(row).toContainText('Added by an admin');
  await expect(row).toContainText('a known spam trap');

  await row.getByRole('button', { name: `Remove ${address}` }).click();
  const remove = page.getByRole('dialog', { name: `Remove ${address}` });
  await expect(remove).toBeVisible();
  await remove.getByRole('textbox', { name: 'Reason' }).fill('added by mistake');
  await remove.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await remove.getByRole('button', { name: 'Verify and remove' }).click();

  await expect(page.getByText(`${address} is off the suppression list.`)).toBeVisible();
  await expect(page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: address })).toHaveCount(0);
  await expect(page.getByText('No address matches')).toBeVisible();
  expect(await listed(address)).toBe(false);
});
