// PST-T-16.8 (PST-DA-046), PST-T-17.11: "Import" — a provider (or a known address) fills the server
// and port, the certificate fingerprint and folder list sit under a collapsed Advanced, and the
// authentication code is asked in "Confirm it is you" when the import starts (a 403
// step_up_required), never as a field of the form. The step-up and start requests are stubbed, so
// the spec needs no real remote IMAP server and burns no TOTP step.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  cookies = await signInCookies(api, await ensureOperator(api));
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(cookies);
  // No active import, so the form shows.
  await page.route('**/api/import', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { import: null } });
    else await route.fallback();
  });
});

async function open(page: Page): Promise<void> {
  await page.goto('/settings/import');
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();
}

test('choosing a provider fills the server and port', async ({ page }) => {
  await open(page);
  const server = page.getByRole('textbox', { name: 'Server' });
  const port = page.getByRole('textbox', { name: 'Port' });

  for (const [label, host] of [
    ['Gmail', 'imap.gmail.com'],
    ['iCloud', 'imap.mail.me.com'],
    ['Outlook / Microsoft 365', 'outlook.office365.com'],
    ['Fastmail', 'imap.fastmail.com'],
  ] as const) {
    await page.getByRole('combobox', { name: 'Provider' }).click();
    await page.getByRole('option', { name: label }).click();
    await expect(server).toHaveValue(host);
    await expect(port).toHaveValue('993');
  }
  await page.getByRole('combobox', { name: 'Provider' }).click();
  await page.getByRole('option', { name: 'Other' }).click();
  await expect(server).toHaveValue('');
});

test('entering a known address picks its provider and warns about app passwords', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Email address or username' }).fill('someone@gmail.com');
  await expect(page.getByRole('textbox', { name: 'Server' })).toHaveValue('imap.gmail.com');
  await expect(page.getByRole('textbox', { name: 'Port' })).toHaveValue('993');
  await expect(page.getByRole('combobox', { name: 'Provider' })).toContainText('Gmail');
  await expect(page.getByText(/app-specific password/)).toBeVisible();

  await page.getByRole('textbox', { name: 'Email address or username' }).fill('someone@mac.com');
  await expect(page.getByRole('textbox', { name: 'Server' })).toHaveValue('imap.mail.me.com');
});

test('the certificate fingerprint and folder list sit under a collapsed Advanced', async ({ page }) => {
  await open(page);
  const advanced = page.getByRole('button', { name: 'Advanced' });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('textbox', { name: /Trust this certificate/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Only these folders/ })).toHaveCount(0);

  await advanced.click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('textbox', { name: /Trust this certificate/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Only these folders/ })).toBeVisible();
});

test('the authentication code is asked in Confirm it is you when the import starts, then the start runs again', async ({ page }) => {
  const calls: string[] = [];
  let started: Record<string, unknown> = {};
  let stepped = false;
  await page.route('**/api/auth/step-up', async (route) => {
    calls.push(`step-up:${(route.request().postDataJSON() as { code: string }).code}`);
    stepped = true;
    await route.fulfill({ json: { ok: true } });
  });
  let created: Record<string, unknown> | null = null;
  await page.route('**/api/import', async (route) => {
    // Once started, the page polls the running import: it is the one just created.
    if (route.request().method() === 'GET') return created === null ? route.fallback() : route.fulfill({ json: { import: created } });
    if (route.request().method() !== 'POST') return route.fallback();
    calls.push('start');
    // As the server does: no fresh step-up, no import.
    if (!stepped) return route.fulfill({ status: 403, json: { error: 'step_up_required' } });
    started = route.request().postDataJSON() as Record<string, unknown>;
    created = {
      id: 'imp-1',
      status: 'pending',
      host: 'imap.fastmail.com',
      port: 993,
      username: 'someone@fastmail.com',
      pinned: false,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequested: false,
      folders: [],
      totals: { folders: 0, foldersDone: 0, total: 0, imported: 0, duplicates: 0 },
    };
    return route.fulfill({ json: created });
  });

  await open(page);
  // No code field on the page: the form asks only for the other server.
  await expect(page.getByRole('textbox', { name: 'Authentication code' })).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Email address or username' }).fill('someone@fastmail.com');
  await page.getByLabel('Password', { exact: true }).fill('app password');

  // Cancelling the prompt starts nothing and leaves the form as it was.
  await page.getByRole('button', { name: 'Start import' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(calls).toEqual(['start']);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('app password');
  await expect(page.getByRole('textbox', { name: 'Email address or username' })).toHaveValue('someone@fastmail.com');

  // Confirmed: the code is verified, then the import starts again, once.
  calls.length = 0;
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('textbox', { name: 'Authentication code' }).fill('123456');
  await confirm.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Import started.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toEqual(['start', 'step-up:123456', 'start']);
  expect(started).toMatchObject({ host: 'imap.fastmail.com', port: 993, username: 'someone@fastmail.com' });
  // The running import is its own card; the form steps aside until it ends.
  await expect(page.getByRole('heading', { name: 'Import in progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start import' })).toHaveCount(0);
});

test('a finished import is the Last import card, under the form', async ({ page }) => {
  await page.route('**/api/import', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const at = new Date().toISOString();
    await route.fulfill({
      json: {
        import: {
          id: 'imp-0',
          status: 'done',
          host: 'imap.fastmail.com',
          port: 993,
          username: 'someone@fastmail.com',
          pinned: false,
          requestedAt: at,
          startedAt: at,
          finishedAt: at,
          error: null,
          cancelRequested: false,
          folders: [{ name: 'INBOX', target: 'INBOX', total: 3, imported: 3, duplicates: 0, done: true }],
          totals: { folders: 1, foldersDone: 1, total: 3, imported: 3, duplicates: 0 },
        },
      },
    });
  });
  await open(page);
  const form = page.getByRole('heading', { name: 'Start an import' });
  const last = page.getByRole('heading', { name: 'Last import' });
  await expect(last).toBeVisible();
  expect((await last.boundingBox())?.y ?? 0).toBeGreaterThan((await form.boundingBox())?.y ?? 0);
  await expect(page.getByText('From someone@fastmail.com at imap.fastmail.com')).toBeVisible();
});
