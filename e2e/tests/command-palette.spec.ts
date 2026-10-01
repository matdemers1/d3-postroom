// PST-T-9.3's exit demo (PST-REQ-147): ⌘K opens the command palette from anywhere in the mail view
// — even while a text field has focus, since it is a chord — and moving a message to a bucket
// through it is the same write the keyboard shortcuts and the reading pane's own actions make (a
// PATCH with If-Match), so the message leaves the list and shows up in Receipts through the API.
// PST-T-15.5 (PST-REQ-194) rebuilt it on @d3cloud/ui's CommandPalette and made it search: typing
// asks GET /api/search into a Messages group, filter chips narrow the ask, Go to and Actions stay.
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
// The library names the dialog and its combobox with the one label.
const input = (page: Page) => palette(page).getByRole('combobox', { name: 'Command palette' });
const group = (page: Page, name: string) => palette(page).getByRole('group', { name, exact: true });
// Options of the command groups — everything but the Messages group, whose rows are search answers.
const commandOptions = (page: Page) => palette(page).getByRole('group', { name: /^(Actions|Go to|Settings|Admin)$/ }).getByRole('option');

interface Summary {
  id: string;
  mailboxId: string;
  subject: string | null;
}

/** The list's own summary of a seeded message — what GET /api/search answers `messages` with. */
async function summaryOf(mailboxId: string, id: string): Promise<Summary> {
  const { messages } = (await (await api.get(`/api/mailboxes/${mailboxId}/messages`)).json()) as { messages: Summary[] };
  const found = messages.find((m) => m.id === id);
  if (found === undefined) throw new Error(`seeded message ${id} is not in its mailbox`);
  return found;
}

/**
 * Answers GET /api/search with `messages` and records every ask. The e2e seed route files messages
 * without a message_search row (only the worker's file stage and compose index), so a seeded
 * message is never a real hit; the search endpoint's own matching is apps/api's mail-search
 * integration suite. What this proves is the palette's side: when it asks, with what, and what it
 * does with the answer — in the exact response shape the endpoint returns.
 */
async function answerSearch(page: Page, messages: Summary[]): Promise<URL[]> {
  const asked: URL[] = [];
  await page.route('**/api/search?**', async (route) => {
    asked.push(new URL(route.request().url()));
    await route.fulfill({ json: { results: [], messages, nextCursor: null, warnings: [] } });
  });
  return asked;
}

test('⌘K opens the palette, from a text field too, and Escape closes it', async ({ page }) => {
  const t = tag();
  await seedMail(api, [{ subject: `Chord ${t}` }]);
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();

  // The search box is a text field; the chord still opens the palette from inside it. Focused, not
  // clicked: a pointer on the list's search field may open the palette itself (openPalette).
  await page.getByRole('searchbox', { name: 'Search mail' }).focus();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('Escape returns focus to where ⌘K was pressed', async ({ page }) => {
  await seedMail(api, [{ subject: `Focus return ${tag()}` }]);
  await page.goto('/');
  const list = page.getByRole('listbox', { name: 'Messages in Inbox' });
  await expect(list).toBeVisible();
  await list.focus();
  await page.keyboard.press('Control+k');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(list).toBeFocused();
});

test('typing searches messages: debounced, marked, "sender · date", and Enter opens the message', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Acadia over the long weekend ${t}`, from: 'priya@example.org' }]);
  if (m === undefined) throw new Error('seed returned nothing');
  const asked = await answerSearch(page, [await summaryOf(m.mailboxId, m.id)]);
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();

  await page.keyboard.press('Control+k');
  // A run of the subject, so the library marks it in the label.
  const query = `weekend ${t}`;
  await page.keyboard.type(query);
  const messages = group(page, 'Messages');
  await expect(messages).toBeVisible();
  // One ask for the whole burst of keystrokes, with exactly what was typed.
  expect(asked.length).toBeLessThan(query.length);
  expect(asked.at(-1)?.searchParams.get('q')).toBe(query);
  expect(asked.at(-1)?.searchParams.has('mailboxId')).toBe(false);

  const hit = messages.getByRole('option', { name: new RegExp(`^Acadia over the long weekend ${t}`) });
  await expect(hit).toBeVisible();
  // The subject is the label, the match marked; the sender and the date follow it.
  await expect(hit.locator('mark')).toHaveText([query]);
  await expect(hit).toContainText('priya@example.org · ');
  // No command is called "weekend …", so the Messages group leads and its first row is selected.
  await expect(hit).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/mail/inbox/${m.id}$`));
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
});

test('filter chips toggle, and narrow the search to what the API honours', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Chips ${t}` }]);
  if (m === undefined) throw new Error('seed returned nothing');
  const asked = await answerSearch(page, [await summaryOf(m.mailboxId, m.id)]);
  const ids = await mailboxIds();
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('priya');
  await expect(group(page, 'Messages')).toBeVisible();

  const filters = palette(page).getByRole('group', { name: 'Filters' });
  const last = () => asked.at(-1);
  const chip = async (name: string, param: 'q' | 'mailboxId', expected: string | undefined) => {
    const button = filters.getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // A pointer on a chip leaves the typing where it was.
    await expect(input(page)).toBeFocused();
    await expect.poll(() => last()?.searchParams.get(param)).toBe(expected);
  };

  await chip('Has attachment', 'q', 'priya has:attachment');
  await chip('From', 'q', 'from:"priya" has:attachment');
  await chip('Date: last 7 days', 'q', 'from:"priya" has:attachment after:7d');
  await chip('In: Inbox', 'mailboxId', ids['inbox']);

  // Off again: the ask loses it.
  await filters.getByRole('button', { name: 'Has attachment', exact: true }).click();
  await expect.poll(() => last()?.searchParams.get('q')).toBe('from:"priya" after:7d');

  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('Go to lists the matching mailboxes', async ({ page }) => {
  await seedMail(api, [{ subject: `Go to ${tag()}` }]);
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('receipts');
  await expect(group(page, 'Go to').getByRole('option', { name: 'Go to Receipts' })).toBeVisible();
  await expect(group(page, 'Go to').getByRole('option', { name: 'Go to Newsletters' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('with a conversation open, Actions leads with Archive, Snooze and Move, with their keys', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Actions ${t}` }]);
  if (m === undefined) throw new Error('seed returned nothing');
  await page.goto('/');
  await row(page, m.subject).click();
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();

  await page.keyboard.press('Control+k');
  const actions = group(page, 'Actions').getByRole('option');
  await expect(actions.nth(0)).toHaveAccessibleName('Archive');
  await expect(actions.nth(0).locator('kbd')).toHaveText(['e']);
  await expect(actions.nth(1)).toHaveAccessibleName('Snooze the conversation');
  await expect(actions.nth(1).locator('kbd')).toHaveText(['b']);
  await expect(actions.nth(2)).toHaveAccessibleName('Move to a mailbox');
  await expect(actions.nth(2).locator('kbd')).toHaveText(['v']);
  await page.keyboard.press('Escape');
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

  const combobox = input(page);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const activeId = await combobox.getAttribute('aria-activedescendant');
  expect(activeId).toBe(await options.nth(1).getAttribute('id'));

  // "Archive" the action, "Go to Archive" and "Move to Archive" (the cursor is on a real message)
  // all match — every one of them says "Archive" — but no command that does not. (Messages that
  // match "archive" are search answers, in their own group.)
  await page.keyboard.type('archive');
  const commands = commandOptions(page);
  await expect(commands.first()).toBeVisible();
  const filteredCount = await commands.count();
  expect(filteredCount).toBeGreaterThan(0);
  expect(filteredCount).toBeLessThan(initialCount);
  for (const text of await commands.allTextContents()) expect(text).toMatch(/Archive/);
  await expect(group(page, 'Actions').getByRole('option', { name: 'Archive', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('the command palette has no axe violations, in light and dark', async ({ page }) => {
  // Radix's dialog fades in; scanning mid-transition catches a half-opaque frame and axe reads that
  // as low contrast (a false positive on the transition, not the design). Reduced motion skips it,
  // the same way a user who asked for less motion would see the palette appear.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Axe ${t}`, from: 'priya@example.org' }]);
  if (m === undefined) throw new Error('seed returned nothing');
  await answerSearch(page, [await summaryOf(m.mailboxId, m.id)]);
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    // With everything drawn: a query, a Messages group with its avatars, and a chip pressed.
    await page.keyboard.type(t);
    await expect(group(page, 'Messages').getByRole('option')).toHaveCount(1);
    await palette(page).getByRole('button', { name: 'Has attachment', exact: true }).click();
    await expect(palette(page).getByRole('button', { name: 'Has attachment', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(group(page, 'Messages').getByRole('option')).toHaveCount(1);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${theme} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  }
});
