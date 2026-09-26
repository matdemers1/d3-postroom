// PST-T-6.6 / PST-REQ-121: the Outbound queue admin screen. The doneWhen — force-SES re-routes a
// deferred message — is proved through the API (the transport actually flips to 'ses'); the UI
// half proves the screen renders the seeded recipient, is axe clean, and that clicking Force SES
// through the confirm-and-step-up modal drives the same mutation.
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

async function seedDeferred(domain: string): Promise<{ messageId: string; recipientId: string }> {
  const res = await api.post('/api/admin/queue/dev-seed-deferred', { headers: { ...CSRF, cookie: cookieHeader() }, data: { domain } });
  if (res.status() === 404) throw new Error('the stack has no dev-seed-deferred route: start the api with POSTROOM_E2E_SEED=1');
  expect(res.ok()).toBe(true);
  return (await res.json()) as { messageId: string; recipientId: string };
}

test('renders the queue with a seeded deferred recipient, axe clean', async ({ page }) => {
  const domain = `render-${Date.now()}.test`;
  await seedDeferred(domain);

  await page.goto('/admin/queue');
  await expect(page.getByRole('heading', { name: 'Outbound queue', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Domain' }).first().fill(domain);
  await expect(page.getByRole('row').filter({ hasText: `first@${domain}` })).toBeVisible();

  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations).toEqual([]);
});

test('Force SES, through the confirm-and-step-up modal, re-routes a deferred message (the doneWhen)', async ({ page }) => {
  const domain = `force-ses-${Date.now()}.test`;
  const { recipientId } = await seedDeferred(domain);

  await page.goto('/admin/queue');
  await page.getByRole('textbox', { name: 'Domain' }).first().fill(domain);
  const row = page.getByRole('row').filter({ hasText: `first@${domain}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Force SES' }).click();

  const dialog = page.getByRole('dialog', { name: /Force SES/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: /Verify and force ses/i }).click();

  await expect(page.getByText('done.')).toBeVisible();

  const after = await api.get('/api/admin/queue', { headers: { cookie: cookieHeader() } });
  const body = (await after.json()) as { messages: { recipients: { id: string; transport: string; domain: string }[] }[] };
  const found = body.messages.flatMap((m) => m.recipients).find((r) => r.id === recipientId);
  expect(found?.transport).toBe('ses');
});
