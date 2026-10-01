// PST-T-17.8 (PST-REQ-194, PST-REQ-155; critique-settings X4, X12): every Settings and Admin screen's
// h1 is its nav label, verbatim — the three Security & devices screens share the section's name, and
// every other screen's h1 is its route title. On a phone the context bar is a large-title bar: empty
// while that h1 shows below it, and the h1's words once it has scrolled under.
//
// The list mirrors apps/web/src/routes.ts (Settings and Admin routes, in table order). The route
// table cannot be imported here (it is bundler-resolved web source, this is a NodeNext project), so
// apps/web/test/unit/routes.test.ts reads this file and fails if the two ever disagree.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** [path, the nav label, which is the page's h1]. */
const SCREENS: readonly (readonly [string, string])[] = [
  ['/settings/account', 'Account'],
  ['/settings/security', 'Security & devices'],
  ['/settings/security/sessions', 'Security & devices'],
  ['/settings/security/devices', 'Security & devices'],
  ['/settings/addresses', 'Addresses'],
  ['/settings/rules', 'Rules & sorting'],
  ['/settings/templates', 'Templates'],
  ['/settings/import', 'Import'],
  ['/settings/keys', 'Encryption keys'],
  ['/admin/health', 'Health'],
  ['/admin/queue', 'Outbound queue'],
  ['/admin/deliverability', 'Deliverability'],
  ['/admin/dns', 'DNS & DKIM'],
  ['/admin/smtp', 'Live SMTP'],
  ['/admin/jobs', 'Jobs'],
  ['/admin/sessions', 'Sign-in sessions'],
  ['/admin/sign-in', 'Sign in with D3 Auth'],
  ['/admin/suppressions', 'Suppressions'],
  ['/admin/setup', 'Setup'],
];

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

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

/** The h1's own words: PageHeader's count ("2 sessions") and icon are not part of the title. */
async function h1Title(page: Page): Promise<string> {
  const h1 = page.locator('h1.d3-ph__title');
  await expect(h1).toHaveCount(1);
  return h1.evaluate((el) => {
    type Node = { textContent: string | null; cloneNode: (deep: boolean) => Node; querySelectorAll: (s: string) => { forEach: (f: (n: { remove: () => void }) => void) => void } };
    const copy = (el as unknown as Node).cloneNode(true);
    copy.querySelectorAll('.d3-ph__count, .d3-ph__icon').forEach((n) => {
      n.remove();
    });
    return (copy.textContent ?? '').trim();
  });
}

test('every Settings and Admin screen’s h1 is its nav label', async ({ page, isMobile }) => {
  for (const [path, label] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    expect(await h1Title(page), path).toBe(label);
    await expect(page.getByRole('heading', { level: 1 }), `${path}: one h1`).toHaveCount(1);
    if (isMobile) continue;
    // The nav entry marked current carries the same words.
    const place = path.startsWith('/admin') ? 'Admin console' : 'Settings';
    const current = page.getByRole('navigation', { name: place }).locator('a[aria-current="page"] .d3-snav__label');
    await expect(current, path).toHaveText(label);
  }
});

test('on a phone the context bar is empty until the h1 scrolls under it, then takes its words', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the context bar is the phone’s chrome');
  for (const [path, label] of [['/settings/account', 'Account'], ['/settings/security/devices', 'Security & devices'], ['/admin/health', 'Health']] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    const bar = page.getByTestId('context-bar');
    const title = bar.locator('.pr-cbar__title');
    await expect(bar, path).toHaveAttribute('data-large-title', 'expanded');
    await expect(title, path).toHaveText('');
    // Room to scroll on any page, however short.
    // The CSP refuses an injected <style> (style-src 'self'), which is the point of it; the CSSOM is
    // not inline markup, so give the page room to scroll through it instead.
    await page.evaluate(() => {
      const el = (globalThis as unknown as { document: { querySelector(s: string): { style: { paddingBottom: string } } | null } }).document.querySelector('.pr-push--page');
      if (el !== null) el.style.paddingBottom = '3000px';
    });
    await page.evaluate(() => {
      (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 800);
    });
    await expect(bar, path).toHaveAttribute('data-large-title', 'collapsed');
    await expect(title, path).toHaveText(label);
    await page.evaluate(() => {
      (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 0);
    });
    await expect(title, path).toHaveText('');
  }
});

test('on a phone the account row sits on the Settings and Admin indexes only, and a short page ends in sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the push stack is the phone’s');
  for (const index of ['/settings', '/admin']) {
    await page.goto(index);
    await expect(page.locator('button.d3-acct')).toHaveCount(1);
  }
  await page.goto('/settings/templates');
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  await expect(page.locator('button.d3-acct')).toHaveCount(0);
  const viewport = page.viewportSize();
  const frame = await page.locator('.pr-push--page').boundingBox();
  expect(frame?.height ?? 0).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 1);
});
