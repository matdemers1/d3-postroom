// PST-T-7.6: the admin Health and Jobs screens (PST-REQ-127, PST-REQ-128). Health tiles render and
// a simulated fault (a dead inbound job) shows as a down tile; Jobs lists the failure and Replay
// re-files it — enqueueing a fresh 'inbound' job for the same message, from the chosen stage.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

const CSRF = { 'x-postroom-csrf': '1' };

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test('Health renders a tile per source, axe clean in both themes', async ({ page }) => {
  await page.goto('/admin/health');
  await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeVisible();
  const grid = page.getByRole('list', { name: 'Health tiles' });
  await expect(grid).toBeVisible();
  await expect(page.locator('[data-tile-id="queue"]')).toBeVisible();
  await expect(page.locator('[data-tile-id="backup"]')).toBeVisible();
  await expect(page.locator('[data-tile-id="drill"]')).toBeVisible();

  const light = await new AxeBuilder({ page }).include('main').analyze();
  expect(light.violations).toEqual([]);
  await page.evaluate(() => {
    localStorage.setItem('postroom-theme', 'dark');
  });
  await page.reload();
  const dark = await new AxeBuilder({ page }).include('main').analyze();
  expect(dark.violations).toEqual([]);
});

test('a simulated fault (a dead inbound job) shows the queue tile down', async ({ page }) => {
  const before = await api.get('/api/admin/health', { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  expect(before.ok()).toBe(true);

  const seeded = await api.post('/api/admin/jobs/dev-seed-failure', { headers: CSRF });
  if (seeded.status() === 404) throw new Error('the stack has no dev-seed-failure route: start the api with POSTROOM_E2E_SEED=1');
  expect(seeded.ok()).toBe(true);
  const { inboundMessageId, jobId } = (await seeded.json()) as { inboundMessageId: string; jobId: string };

  await page.goto('/admin/health');
  const queueTile = page.locator('[data-tile-id="queue"]');
  await expect(queueTile).toHaveAttribute('data-tile-state', 'down');
  await expect(queueTile).toContainText('dead job');

  await test.step('Jobs lists the failure and Replay re-files it', async () => {
    await page.goto('/admin/jobs');
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Dead' }).click();

    const row = page.getByRole('row').filter({ hasText: 'simulated file-stage failure' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Replay' }).click();

    const dialog = page.getByRole('dialog', { name: 'Replay from a stage' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'From stage' }).click();
    await page.getByRole('option', { name: 'file', exact: true }).click();
    await dialog.getByRole('button', { name: 'Replay', exact: true }).click();

    await expect(page.getByText(new RegExp(`re-filing message ${inboundMessageId}`))).toBeVisible();

    const after = await api.get(`/api/admin/jobs?queue=inbound`, {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    const { jobs } = (await after.json()) as { jobs: { id: string; payload: unknown; status: string }[] };
    const replayed = jobs.find((j) => j.id !== jobId && (j.payload as { inboundMessageId?: string }).inboundMessageId === inboundMessageId);
    expect(replayed).toBeDefined();
    expect(replayed?.status).toBe('pending');
  });
});
