// PST-T-6.6 / PST-REQ-121: the Outbound queue admin screen. The doneWhen — force-SES re-routes a
// deferred message — is proved through the API (the transport actually flips to 'ses'); the UI
// half proves the screen renders the seeded recipient, is axe clean, and that clicking Force SES
// through the confirm-and-step-up modal drives the same mutation.
//
// PST-T-16.13 (PST-DA-031, PST-REQ-121/155/198): the row's four actions are one Actions menu, the
// Domain column is gone, the last reply and every attempt are a row drawer, no link points at raw
// /api/ JSON, ?state= and ?message= filter from the URL, and at 1280px the table fits its container.
// On a phone the same rows are cards; the 390px geometry is mobile.spec's.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
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

/** A queue row: a table row on a desktop, a DataList card on a phone. */
const rowOf = (page: Page, text: string) => page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: text });

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
  await page.getByRole('searchbox', { name: 'Domain' }).first().fill(domain);
  await expect(rowOf(page, `first@${domain}`)).toBeVisible();

  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations).toEqual([]);
});

test('Force SES, through the confirm-and-step-up modal, re-routes a deferred message (the doneWhen)', async ({ page }) => {
  const domain = `force-ses-${Date.now()}.test`;
  const { recipientId } = await seedDeferred(domain);

  await page.goto('/admin/queue');
  await page.getByRole('searchbox', { name: 'Domain' }).first().fill(domain);
  const row = rowOf(page, `first@${domain}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: 'Force SES' }).click();

  const dialog = page.getByRole('dialog', { name: /Force SES/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await dialog.getByRole('button', { name: /Verify and force ses/i }).click();

  await expect(page.getByText('done.')).toBeVisible();

  // Polled: the list the toast refreshed and this read can race the worker's own pass over the row.
  await expect
    .poll(async () => {
      const after = await api.get('/api/admin/queue', { headers: { cookie: cookieHeader() } });
      const body = (await after.json()) as { messages: { recipients: { id: string; transport: string; domain: string }[] }[] };
      return body.messages.flatMap((m) => m.recipients).find((r) => r.id === recipientId)?.transport;
    })
    .toBe('ses');
});

test('the row’s four actions are one Actions menu, and nothing links to raw /api/ JSON', async ({ page }) => {
  const domain = `menu-${Date.now()}.test`;
  await seedDeferred(domain);

  await page.goto(`/admin/queue?domain=${domain}`);
  const row = rowOf(page, `first@${domain}`);
  await expect(row).toBeVisible();
  // Collapsed: no per-row Retry / Force SES / Bounce / Delete buttons until the menu opens.
  for (const name of ['Retry now', 'Force SES', 'Bounce', 'Delete']) await expect(row.getByRole('button', { name, exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: /^Actions for / }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Retry now', 'Force SES', 'Bounce', 'Delete']);
  await page.keyboard.press('Escape');

  expect(await page.locator('main a[href^="/api/"]').count()).toBe(0);
});

test('the row drawer shows the last response and the delivery evidence', async ({ page }) => {
  const domain = `drawer-${Date.now()}.test`;
  await seedDeferred(domain);

  await page.goto(`/admin/queue?domain=${domain}`);
  await rowOf(page, `first@${domain}`).getByRole('button', { name: `Delivery details for first@${domain}` }).click();
  const drawer = page.getByRole('dialog', { name: 'Delivery details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('queue-last-response')).toContainText('greylisted (seeded for e2e)');
  await expect(drawer.getByTestId('inspect-delivery')).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
});

test('?state= and ?message= filter the list from the URL, and reload keeps them', async ({ page }) => {
  const domain = `url-${Date.now()}.test`;
  const first = await seedDeferred(domain);
  const second = await seedDeferred(domain);

  // ?state=: the seeded rows are deferred, so "pending" hides them and "deferred" shows them.
  await page.goto(`/admin/queue?domain=${domain}&state=pending`);
  await expect(page.getByRole('radiogroup', { name: 'State' }).getByRole('radio', { name: /^Pending/ })).toHaveAttribute('aria-checked', 'true');
  await expect(rowOf(page, `first@${domain}`)).toHaveCount(0);
  await page.goto(`/admin/queue?domain=${domain}&state=deferred`);
  await expect(rowOf(page, `first@${domain}`)).toHaveCount(2);

  // ?message=: one message's recipients only.
  await page.goto(`/admin/queue?domain=${domain}&message=${first.messageId}`);
  await expect(rowOf(page, `first@${domain}`)).toHaveCount(1);
  await expect(page.getByText('Showing one message’s recipients only.')).toBeVisible();
  await page.reload();
  await expect(rowOf(page, `first@${domain}`)).toHaveCount(1);
  expect(second.messageId).not.toBe(first.messageId);
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page).not.toHaveURL(/message=/);
  await expect(rowOf(page, `first@${domain}`)).toHaveCount(2);

  // Typing a domain writes it to the URL.
  await page.getByRole('searchbox', { name: 'Domain' }).first().fill(domain);
  await expect(page).toHaveURL(new RegExp(`domain=${domain.replace(/\./g, '\\.')}`));
});

test('at 1280px the table fits: no Domain column, no sideways scroll inside it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop table; a phone gets cards (mobile.spec)');
  const domain = `fit-${Date.now()}.test`;
  for (let i = 0; i < 3; i++) await seedDeferred(domain);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/admin/queue?domain=${domain}`);
  await expect(rowOf(page, `first@${domain}`).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Domain' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Last response' })).toHaveCount(0);

  const widths = await page.locator('.d3-tbl-scroll').first().evaluate((el) => {
    const box = el as unknown as { scrollWidth: number; clientWidth: number };
    return { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
  });
  expect(widths.scrollWidth, 'the queue table scrolls sideways at 1280px').toBeLessThanOrEqual(widths.clientWidth);
});
