// PST-T-7.1 / PST-REQ-122: the Google (.zip) and Microsoft (.xml.gz) DMARC aggregate fixtures and
// the Google TLS-RPT (.json.gz) fixture render on the admin Deliverability screen.
//
// The real path: POST /api/admin/deliverability/dev/seed (POSTROOM_E2E_SEED=1 only) files one
// message per fixture into the dmarc@ report mailbox, exactly as delivered mail sits there; the
// worker's report sweep (which CI's e2e stack runs; locally, run apps/worker/src/main.ts against the
// same database with REPORTS_SWEEP_MS small) reads the attachments and stores the rows; the screen
// charts them. Axe-clean in both themes, and at 390 px in the mobile project.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const CSRF = { 'x-postroom-csrf': '1' };
const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'reports', 'test', 'fixtures');
const attachment = (suffix: string, contentType: string): { filename: string; contentType: string; contentBase64: string } => {
  const filename = readdirSync(fixtures).find((f) => f.endsWith(suffix));
  if (filename === undefined) throw new Error(`no fixture ending ${suffix}`);
  return { filename, contentType, contentBase64: readFileSync(join(fixtures, filename)).toString('base64') };
};

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const cookieHeader = (): string => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);

  const seeded = await api.post('/api/admin/deliverability/dev/seed', {
    headers: CSRF,
    data: {
      messages: [
        { from: 'noreply-dmarc-support@google.com', subject: 'Report domain: d3cloud.io Submitter: google.com Report-ID: 4817259360124789153', attachments: [attachment('.zip', 'application/zip')] },
        { from: 'dmarcreport@microsoft.com', subject: 'Report Domain: d3cloud.io Submitter: enterprise.protection.outlook.com', attachments: [attachment('.xml.gz', 'application/gzip')] },
        { from: 'noreply-smtp-tls-reporting@google.com', subject: 'Report Domain: d3cloud.io Submitter: google.com Report-ID: <2026.09.24T00.00.00Z+d3cloud.io@google.com>', attachments: [attachment('.json.gz', 'application/tlsrpt+gzip')] },
      ],
    },
  });
  if (seeded.status() === 404) throw new Error('the stack has no deliverability dev seed route: start the api with POSTROOM_E2E_SEED=1');
  expect(seeded.status()).toBe(201);

  // The worker's sweep turns the filed messages into rows. A second project run re-seeds the same
  // reports: they are recognized as duplicates and the totals stay the same.
  await expect
    .poll(
      async () => {
        const res = await api.get('/api/admin/deliverability?days=3650', { headers: { cookie: cookieHeader() } });
        const body = (await res.json()) as { dmarc: { totals: { reports: number } }; tlsrpt: { totals: { reports: number } } };
        return body.dmarc.totals.reports >= 2 && body.tlsrpt.totals.reports >= 1;
      },
      { timeout: 60_000, message: 'the reports never appeared — is the worker running against this stack?' },
    )
    .toBe(true);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test('Google and Microsoft fixtures render on Deliverability, axe clean in both themes', async ({ page }) => {
  await page.goto('/admin/deliverability');
  await expect(page.getByRole('heading', { name: 'Deliverability', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Range' }).click();
  await page.getByRole('option', { name: 'All time' }).click();

  await expect(page.getByRole('img', { name: 'DMARC pass and fail by day' })).toBeVisible();
  // Both fixtures' days carry bars: Google's on 24 September, Microsoft's on 25 September.
  await expect(page.locator('[data-day="2026-09-24"] rect')).toHaveCount(2);
  await expect(page.locator('[data-day="2026-09-25"] rect')).toHaveCount(2);

  const sources = page.getByRole('table', { name: 'DMARC results by sending source' });
  const shared = sources.getByRole('row').filter({ hasText: '203.0.113.25' });
  await expect(shared).toContainText('Enterprise Outlook, google.com');
  await expect(shared).toContainText('59');
  await expect(shared).toContainText('100%');
  await expect(sources.getByRole('row').filter({ hasText: '198.51.100.77' })).toContainText('0%');
  await expect(sources.getByRole('row').filter({ hasText: '2001:db8::25' })).toBeVisible();

  const reporters = page.getByRole('table', { name: 'DMARC results by reporting organization' });
  await expect(reporters.getByRole('row').filter({ hasText: 'google.com' })).toContainText('50');
  await expect(reporters.getByRole('row').filter({ hasText: 'Enterprise Outlook' })).toContainText('19');

  const tls = page.getByRole('table', { name: 'TLS sessions by policy' });
  await expect(tls.getByRole('row').filter({ has: page.getByRole('cell', { name: 'sts', exact: true }) })).toContainText('58');
  await expect(page.getByRole('table', { name: 'TLS failures by type' })).toContainText('certificate-expired');

  const light = await new AxeBuilder({ page }).include('main').analyze();
  expect(light.violations).toEqual([]);
  await page.evaluate(() => {
    localStorage.setItem('postroom-theme', 'dark');
  });
  await page.reload();
  await page.getByRole('combobox', { name: 'Range' }).click();
  await page.getByRole('option', { name: 'All time' }).click();
  await expect(page.getByRole('img', { name: 'DMARC pass and fail by day' })).toBeVisible();
  const dark = await new AxeBuilder({ page }).include('main').analyze();
  expect(dark.violations).toEqual([]);
});

test('no horizontal page overflow at the viewport width', async ({ page }) => {
  await page.goto('/admin/deliverability');
  await expect(page.getByRole('heading', { name: 'Deliverability', level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => {
    const root = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
