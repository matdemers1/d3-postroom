// PST-T-14.3 (PST-REQ-189, PST-ADR-011): three places. Mail's sidebar holds mailboxes and the
// Calendar and Contacts places only; Settings and the Admin console are reached from the account
// menu, each with its own left nav and "Back to Mail"; the old /account/* and /app-passwords URLs
// redirect; the ⌘K palette lists every place from the same route table, grouped, with keycaps; and
// places swap with a cross-fade no longer than --dur-2 — never a slide.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });
// The mobile project covers the drawer in mobile.spec.ts; the places and their navs are the same.
test.skip(({ isMobile }) => isMobile, 'the navs are the same at every width; mobile.spec.ts checks the drawer');

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

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function openAccountMenu(page: Page): Promise<void> {
  await page.locator('button.d3-acct').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('the Mail sidebar is mailboxes and the Calendar and Contacts places — nothing else', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const nav = mainNav(page);
  await expect(nav.getByRole('button', { name: 'Compose' })).toBeVisible();
  for (const name of [/^Inbox/, /^Sent/, /^Drafts/, /^Archive/, /^Junk/, /^Rejects/, /^Calendar$/, /^Contacts$/]) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }
  const sorted = nav.getByRole('group', { name: 'Sorted for you' });
  for (const name of ['Updates', 'Receipts', 'Notifications', 'Newsletters']) {
    await expect(sorted.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  // Settings and admin screens are not in Mail's sidebar any more.
  for (const name of ['App passwords', 'Masked aliases', 'Change password', 'Devices', 'Health', 'Sessions', 'SMTP sessions']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  // Trash and other folders fold behind More.
  const more = nav.getByRole('button', { name: /^More/ });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: /^Trash/ })).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: /^Trash/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('the account menu opens Settings and the Admin console; each has its own nav and Back to Mail', async ({ page }) => {
  // Axe runs right after moving between places; a cross-fade mid-frame reads as low contrast.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(mainNav(page)).toBeVisible();
  // Leave a mailbox open, so Back to Mail has somewhere to return to.
  await mainNav(page).getByRole('link', { name: /^Sent/ }).click();
  await expect(page).toHaveURL(/\/mail\/[0-9a-f-]+$/);
  const sentUrl = page.url();

  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Admin console/ })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page).toHaveTitle('Account — Postroom');
  const settings = page.getByRole('navigation', { name: 'Settings' });
  await expect(mainNav(page)).toHaveCount(0);
  const settingsLinks = settings.getByRole('group', { name: 'Settings' }).getByRole('link');
  await expect(settingsLinks).toHaveText(['Account', 'Security & devices', 'Addresses', 'Rules', 'Templates', 'Import & export', 'Encryption keys']);
  await settings.getByRole('link', { name: 'Security & devices' }).click();
  await expect(page.getByRole('heading', { name: 'Browser sessions', level: 1 })).toBeVisible();
  // One vocabulary: the section's own links name Browser sessions and Devices.
  const sub = page.getByRole('navigation', { name: 'Security & devices' });
  await expect(sub.getByRole('link')).toHaveText(['Browser sessions', 'Devices', 'Set up iPhone / Mac']);
  await sub.getByRole('link', { name: 'Devices' }).click();
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  await expect(settings.getByRole('link', { name: 'Security & devices' })).toHaveAttribute('aria-current', 'page');
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: /^Admin console/ }).click();
  await expect(page).toHaveURL(/\/admin\/health$/);
  const admin = page.getByRole('navigation', { name: 'Admin console' });
  await expect(admin.getByRole('group', { name: 'Admin console' }).getByRole('link')).toHaveText([
    'Health',
    'Outbound queue',
    'Deliverability',
    'DNS & DKIM',
    'Live SMTP',
    'Jobs',
    'Sign-in sessions',
    'Suppressions',
    /^Setup/,
  ]);
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await admin.getByRole('link', { name: 'Back to Mail' }).click();
  await expect(page).toHaveURL(sentUrl);
  await expect(mainNav(page)).toBeVisible();
});

test('the old URLs redirect to their new homes', async ({ page }) => {
  const moved: [string, RegExp, string][] = [
    ['/app-passwords', /\/settings\/security\/devices$/, 'Devices'],
    ['/account/password', /\/settings\/account$/, 'Change password'],
    ['/account/sessions', /\/settings\/security$/, 'Browser sessions'],
    ['/account/device-setup', /\/settings\/security\/device-setup$/, 'Set up iPhone / Mac'],
    ['/account/aliases', /\/settings\/addresses$/, 'Masked aliases'],
    ['/account/rules', /\/settings\/rules$/, 'Rules'],
    ['/account/templates', /\/settings\/templates$/, 'Compose templates'],
    ['/account/import', /\/settings\/import$/, 'Import mail'],
    ['/account/keys', /\/settings\/keys$/, 'Keys'],
    ['/admin', /\/admin\/health$/, 'Health'],
  ];
  for (const [from, to, h1] of moved) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
    await expect(page.getByRole('heading', { name: h1, level: 1 })).toBeVisible();
  }
});

test('the palette lists every place from the route table, grouped, with keycaps', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: /^Messages in/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  for (const group of ['Message actions', 'Go to', 'Settings', 'Admin']) {
    await expect(palette.getByRole('group', { name: group })).toBeVisible();
  }
  const settings = palette.getByRole('group', { name: 'Settings' });
  for (const name of ['Account', 'Browser sessions', 'Devices', 'Set up iPhone / Mac', 'Addresses', 'Rules', 'Templates', 'Import & export', 'Encryption keys']) {
    await expect(settings.getByRole('option', { name: new RegExp(`^${name.replace(/[/]/g, '\\/')}`) })).toHaveCount(1);
  }
  await expect(palette.getByRole('group', { name: 'Admin' }).getByRole('option')).toHaveCount(9);
  // Keycaps from keys.ts: "Go to Inbox" carries g then i; Reply carries r.
  const inbox = palette.getByRole('option', { name: /^Go to Inbox/ });
  await expect(inbox.locator('kbd')).toHaveText(['g', 'i']);
  await expect(palette.getByRole('option', { name: /^Reply$/ }).locator('kbd')).toHaveText(['r']);

  // Typing an old name finds the new place.
  await page.keyboard.type('smtp sessions');
  await palette.getByRole('option', { name: /^Live SMTP/ }).click();
  await expect(page).toHaveURL(/\/admin\/smtp$/);

  // Outside Mail, ⌘K still opens the palette — with places, not message actions.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('group', { name: 'Message actions' })).toHaveCount(0);
  await expect(palette.getByRole('group', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('moving between places cross-fades within --dur-2 and never slides; a page load does not fade', async ({ page }) => {
  const animation = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const style = (globalThis as unknown as { getComputedStyle: (e: unknown) => { animationName: string; animationDuration: string } }).getComputedStyle(el);
      return { name: style.animationName, duration: Number.parseFloat(style.animationDuration) };
    });
  await page.goto('/settings/account');
  await expect(page.locator('[data-place="settings"]')).toBeVisible();
  expect((await animation('[data-place="settings"]')).name).toBe('none');

  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Back to Mail' }).click();
  await expect(page.locator('[data-place="mail"]')).toBeVisible();
  const fade = await animation('[data-place="mail"]');
  // pr-place-in animates opacity only (places.css): no transform, so nothing slides.
  expect(fade.name).toBe('pr-place-in');
  expect(fade.duration).toBeGreaterThan(0);
  expect(fade.duration).toBeLessThanOrEqual(0.14);

  // Asked for less motion: the swap is instant.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('button.d3-acct').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.locator('[data-place="settings"]')).toBeVisible();
  expect((await animation('[data-place="settings"]')).name).toBe('none');
});
