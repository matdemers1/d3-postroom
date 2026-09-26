// PST-T-9.3's exit demo (PST-REQ-147): ⌘K opens the command palette from anywhere in the mail view
// — even while a text field has focus, since it is a chord — and moving a message to a bucket
// through it is the same write the keyboard shortcuts and the reading pane's own actions make (a
// PATCH with If-Match), so the message leaves the list and shows up in Receipts through the API.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });
// The palette's own three-pane mount is the desktop layout; the mobile project would burn a TOTP
// step re-proving the same registry and API write.
test.skip(({ isMobile }) => isMobile, 'the palette runs the same registry regardless of viewport');

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

const row = (page: Page, subject: string) => page.getByRole('option', { name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

async function mailboxIds(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; name: string; specialUse: string | null }[] };
  const out: Record<string, string> = {};
  for (const m of mailboxes) out[m.specialUse ?? m.name] = m.id;
  return out;
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });

test('⌘K opens the palette, from a text field too, and Escape closes it', async ({ page }) => {
  const t = tag();
  await seedMail(api, [{ subject: `Chord ${t}` }]);
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('combobox', { name: 'Type a command' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();

  // The search box is a text field; the chord still opens the palette from inside it.
  await page.getByRole('searchbox', { name: 'Search mail' }).click();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('combobox', { name: 'Type a command' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('types "rec", Enter on "Move to Receipts": the message leaves the list and is filed in Receipts', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Palette move ${t}` }]);
  if (m === undefined) throw new Error('seed returned nothing');
  await page.goto('/');
  await row(page, m.subject).click();
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type('rec');
  await expect(palette(page).getByRole('option', { name: 'Move to Receipts' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');

  await expect(palette(page)).toBeHidden();
  await expect(row(page, m.subject)).toHaveCount(0);

  const ids = await mailboxIds();
  await expect
    .poll(async () => {
      const res = await api.get(`/api/mailboxes/${ids['Receipts'] ?? ''}/messages`);
      return ((await res.json()) as { messages: { subject: string }[] }).messages.some((msg) => msg.subject === m.subject);
    })
    .toBe(true);
});

test('arrow keys move the selection and the list re-filters as the query changes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();

  const options = palette(page).getByRole('option');
  const initialCount = await options.count();
  expect(initialCount).toBeGreaterThan(1);

  const combobox = palette(page).getByRole('combobox', { name: 'Type a command' });
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const activeId = await combobox.getAttribute('aria-activedescendant');
  expect(activeId).toBe(await options.nth(1).getAttribute('id'));

  // "Archive" the action, "Go to Archive" and "Move to Archive" (the cursor is on a real message)
  // all match — every one of them says "Archive" — but nothing that does not.
  await page.keyboard.type('archive');
  const filteredCount = await options.count();
  expect(filteredCount).toBeGreaterThan(0);
  expect(filteredCount).toBeLessThan(initialCount);
  for (const text of await options.allTextContents()) expect(text).toMatch(/Archive/);
  await expect(page.getByRole('option', { name: /^Archive/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('the command palette has no axe violations, in light and dark', async ({ page }) => {
  // Radix's dialog fades in; scanning mid-transition catches a half-opaque frame and axe reads that
  // as low contrast (a false positive on the transition, not the design). Reduced motion skips it,
  // the same way a user who asked for less motion would see the palette appear.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${theme} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  }
});
