// PST-T-14.3 (PST-REQ-189, PST-ADR-011): three places. Mail's sidebar holds mailboxes and the
// Calendar and Contacts places only; Settings and the Admin console are reached from the account
// menu, each with its own left nav and "Back to Mail"; the old /account/* and /app-passwords URLs
// redirect; the ⌘K palette lists every place from the same route table, grouped, with keycaps; and
// places swap with a cross-fade no longer than --dur-2 — never a slide.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

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
  await expect(nav.getByRole('button', { name: 'New message' })).toBeVisible();
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
  // PST-T-16.4: a special-use mailbox is named by its slug.
  await expect(page).toHaveURL(/\/mail\/sent$/);
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
  await expect(settingsLinks).toHaveText(['Account', 'Security & devices', 'Addresses', 'Rules & sorting', 'Templates', 'Import & export', 'Encryption keys']);
  await settings.getByRole('link', { name: 'Security & devices' }).click();
  // PST-T-16.3: Security & devices leads with connecting a device, then Browser sessions.
  await expect(page.getByRole('heading', { name: 'Set up iPhone / Mac', level: 1 })).toBeVisible();
  // One vocabulary: the section's own links name Browser sessions and Devices.
  const sub = page.getByRole('navigation', { name: 'Security & devices' });
  await expect(sub.getByRole('link')).toHaveText(['Set up iPhone / Mac', 'Browser sessions', 'Devices']);
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
    ['/account/password', /\/settings\/account$/, 'Account'],
    ['/account/sessions', /\/settings\/security\/sessions$/, 'Browser sessions'],
    ['/account/device-setup', /\/settings\/security$/, 'Set up iPhone / Mac'],
    ['/settings/security/device-setup', /\/settings\/security$/, 'Set up iPhone / Mac'],
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
  // The list only renders over a non-empty Inbox; this spec may be the first on its stack.
  await seedMail(api, [{ subject: `Palette check ${tag()}` }]);
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: /^Messages in/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  for (const group of ['Actions', 'Go to', 'Settings', 'Admin']) {
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
  await expect(palette).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Live SMTP', level: 1 })).toBeVisible();

  // Outside Mail, ⌘K still opens the palette — with places, not message actions.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('group', { name: 'Actions' })).toHaveCount(0);
  await expect(palette.getByRole('group', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('moving between places cross-fades within --dur-2 and never slides; a page load does not fade', async ({ page }) => {
  // The suite runs with reduced motion (playwright.config.ts); this test is about the motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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

// PST-T-16.4 (PST-REQ-198, PST-DA-052): a list's filters are the URL's — a reload and Back keep them.
test('the jobs status filter is ?status=: a reload and Back keep it', async ({ page }) => {
  await page.goto('/admin/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
  const status = page.getByRole('combobox', { name: 'Status' });
  await status.click();
  await page.getByRole('option', { name: 'Dead' }).click();
  // In place: choosing a filter adds no history entry of its own.
  await expect(page).toHaveURL(/\/admin\/jobs\?status=dead$/);

  const askedOnReload = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/admin/jobs' && new URL(r.url()).searchParams.get('status') === 'dead');
  await page.reload();
  await askedOnReload;
  await expect(status).toContainText('Dead');

  // Away to another admin screen, then Back.
  await page.getByRole('navigation', { name: 'Admin console' }).getByRole('link', { name: 'Health' }).click();
  await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeVisible();
  const askedOnBack = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/admin/jobs' && new URL(r.url()).searchParams.get('status') === 'dead');
  await page.goBack();
  await askedOnBack;
  await expect(page).toHaveURL(/\/admin\/jobs\?status=dead$/);
  await expect(status).toContainText('Dead');

  // All statuses is the bare URL.
  await status.click();
  await page.getByRole('option', { name: 'All statuses' }).click();
  await expect(page).toHaveURL(/\/admin\/jobs$/);
});

test('the contacts search and address book are ?q= and ?book=: a reload and Back keep them', async ({ page }) => {
  const t = tag();
  const { addressBooks } = (await (await api.get('/api/contacts/address-books')).json()) as { addressBooks: { id: string; slug: string; displayName: string }[] };
  const book = addressBooks.find((b) => b.slug === 'contacts') ?? addressBooks[0];
  if (book === undefined) throw new Error('no address book');
  for (const [given, family] of [['Ada', `Byron ${t}`], ['Grace', `Hopper ${t}`]] as const) {
    const made = await api.post(`/api/contacts/address-books/${encodeURIComponent(book.id)}/cards`, {
      headers: { 'x-postroom-csrf': '1' },
      data: { fn: `${given} ${family}`, given, family, emails: [{ address: `${given.toLowerCase()}-${t}@example.org`, type: null }], tels: [], org: '', note: '' },
    });
    expect(made.ok(), `create ${given}`).toBe(true);
  }
  const ada = page.getByRole('link', { name: `Ada Byron ${t}` });
  const grace = page.getByRole('link', { name: `Grace Hopper ${t}` });
  const search = page.getByRole('searchbox', { name: 'Search contacts' });

  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
  await search.fill(`ada-${t}`);
  await expect(page).toHaveURL(new RegExp(`/contacts\\?q=ada-${t}$`));
  await expect(ada).toBeVisible();
  await expect(grace).toHaveCount(0);

  await page.reload();
  await expect(search).toHaveValue(`ada-${t}`);
  await expect(ada).toBeVisible();
  await expect(grace).toHaveCount(0);

  // The book rides in the URL by its slug; with more than one book the select shows it.
  await page.goto(`/contacts?q=${t}&book=${book.slug}`);
  await expect(ada).toBeVisible();
  await expect(grace).toBeVisible();
  if (addressBooks.length > 1) await expect(page.getByRole('combobox', { name: 'Address book' })).toContainText(book.displayName);

  // Open a contact: the filters ride along, and the list beside it stays filtered.
  await ada.click();
  await expect(page).toHaveURL(new RegExp(`/contacts/[^?]+\\?q=${t}&book=${book.slug}$`));
  await expect(search).toHaveValue(t);

  // Away to another place, then Back — twice.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Calendar$/ }).click();
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/contacts/[^?]+\\?q=${t}&book=${book.slug}$`));
  await expect(search).toHaveValue(t);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/contacts\\?q=${t}&book=${book.slug}$`));
  await expect(search).toHaveValue(t);
  await expect(ada).toBeVisible();
  await expect(grace).toBeVisible();
});
