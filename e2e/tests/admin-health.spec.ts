// PST-T-7.6: the admin Health and Jobs screens (PST-REQ-127, PST-REQ-128). Health tiles render and
// a simulated fault (a dead inbound job) shows as a down tile; Jobs lists the failure and Replay
// re-files it — a real message, seeded through the blobstore with a real recipient by
// POST /api/admin/jobs/dev-seed-failure, actually appears in the operator's INBOX once the worker
// (which CI's e2e stack runs) has processed the replayed job. Locally, run the worker alongside the
// api with the same env (`node --conditions=source --import tsx apps/worker/src/main.ts`) for this
// assertion to observe real filing rather than just the enqueue.
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

    const row = page.getByRole('row').filter({ hasText: 'simulated worker crash' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Replay' }).click();

    const dialog = page.getByRole('dialog', { name: 'Replay from a stage' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'From stage' }).click();
    await page.getByRole('option', { name: 'file', exact: true }).click();
    await dialog.getByRole('button', { name: 'Replay', exact: true }).click();

    await expect(page.getByText(new RegExp(`re-filing message ${inboundMessageId}`))).toBeVisible();

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const after = await api.get('/api/admin/jobs?queue=inbound', { headers: { cookie: cookieHeader } });
    const { jobs } = (await after.json()) as { jobs: { id: string; payload: unknown; status: string }[] };
    const replayed = jobs.find((j) => j.id !== jobId && (j.payload as { inboundMessageId?: string }).inboundMessageId === inboundMessageId);
    expect(replayed).toBeDefined();

    // The real proof: CI's e2e stack runs the worker, so the replayed job actually gets processed
    // and a copy of the seeded message shows up in the operator's INBOX (PST-REQ-128's "re-files").
    const mailboxesRes = await api.get('/api/mailboxes', { headers: { cookie: cookieHeader } });
    const { mailboxes } = (await mailboxesRes.json()) as { mailboxes: { id: string; specialUse: string | null }[] };
    const inboxId = mailboxes.find((m) => m.specialUse === 'inbox')?.id;
    expect(inboxId).toBeDefined();

    await expect
      .poll(
        async () => {
          const messagesRes = await api.get(`/api/mailboxes/${String(inboxId)}/messages?limit=50`, { headers: { cookie: cookieHeader } });
          const { messages } = (await messagesRes.json()) as { messages: { subject: string | null }[] };
          return messages.some((m) => m.subject === 'Seeded failure (dev-seed-failure)');
        },
        { timeout: 30_000, message: 'the replayed message never appeared in INBOX — is the worker running against this stack?' },
      )
      .toBe(true);
  });
});
