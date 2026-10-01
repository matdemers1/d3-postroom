// PST-T-14.5 (PST-REQ-190, PST-REQ-192, PST-REQ-193, PST-ADR-011): the triage loop, end to end.
// Archive the open message → the row leaves → the NEXT (older) message opens at once → a toast says
// what happened and offers Undo (z) → Undo moves the message back ON THE SERVER (it gets a new id in
// the Inbox, and that is the one that reopens). By keyboard (e, z) and by mouse (the row's action
// cluster, the toast's Undo button); x-selection with its header toolbar; v's Move dialog; row
// actions reachable from the keyboard; mail arriving under the pointer waits behind "N new"; reduced
// motion removes the row without an exit animation; axe over the list in selection mode.
//
// Seeded mail has no threadId (admin-dev seed files independent messages), so the "whole thread in
// this mailbox" scope is covered by apps/web/test/unit/triage.test.ts rather than here.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeededMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

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

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the triage loop is driven from the three-pane layout; push navigation has its own suite');
  await context.addCookies(cookies);
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page: Page, subject: string) => page.getByRole('listbox', { name: 'Messages in Inbox' }).getByRole('option', { name: new RegExp(escape(subject)) });
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

async function mailboxIds(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; specialUse: string | null }[] };
  const out: Record<string, string> = {};
  for (const m of mailboxes) if (m.specialUse !== null) out[m.specialUse] = m.id;
  return out;
}

/** Subjects in a mailbox, as the server has them. */
async function subjectsIn(mailboxId: string): Promise<string[]> {
  const res = await api.get(`/api/mailboxes/${mailboxId}/messages?limit=200`);
  return ((await res.json()) as { messages: { subject: string }[] }).messages.map((m) => m.subject);
}

async function seedThree(t: string): Promise<[SeededMessage, SeededMessage, SeededMessage]> {
  const [a, b, c] = await seedMail(api, [
    { subject: `Oldest ${t}`, from: `Ada Lovelace <ada.${t}@example.org>`, text: `First one ${t}.` },
    { subject: `Middle ${t}`, from: `Grace Hopper <grace.${t}@example.org>`, text: `Second one ${t}.` },
    { subject: `Newest ${t}`, from: `Alan Turing <alan.${t}@example.org>`, text: `Third one ${t}.` },
  ]);
  if (a === undefined || b === undefined || c === undefined) throw new Error('seed returned too few');
  return [a, b, c];
}

test('keyboard: e archives the open message, the next (older) one opens, z moves it back on the server', async ({ page }) => {
  const t = tag();
  const [a, b] = await seedThree(t);
  const ids = await mailboxIds();
  await page.goto('/');
  await row(page, b.subject).click();
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();

  // The row shows the sender's NAME, and a one-line snippet.
  await expect(row(page, a.subject)).toContainText('Ada Lovelace');
  await expect(row(page, a.subject)).toContainText(`First one ${t}.`);

  await page.keyboard.press('e');
  await expect(row(page, b.subject)).toHaveCount(0);
  // The next message — the one below, older — is open at once; no empty "No message open" pane.
  await expect(page).toHaveURL(new RegExp(`/mail/inbox/${a.id}$`));
  await expect(page.getByRole('heading', { name: a.subject, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No message open' })).toHaveCount(0);
  await expect(toasts(page)).toContainText(`Moved to Archive · ${b.subject}`);
  await expect(toasts(page).getByRole('button', { name: 'Undo' })).toHaveAttribute('aria-keyshortcuts', 'z');
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).includes(b.subject)).toBe(true);

  await page.keyboard.press('z');
  await expect(toasts(page)).toContainText('Moved back to Inbox.');
  await expect(row(page, b.subject)).toHaveCount(1);
  // The message is reopened under the NEW id the server gave it back in the Inbox.
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/${b.id}$`));
  await expect.poll(async () => (await subjectsIn(b.mailboxId)).includes(b.subject)).toBe(true);
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).includes(b.subject)).toBe(false);
});

test('mouse: the row action archives, the next message opens, the toast\'s Undo moves it back', async ({ page }) => {
  const t = tag();
  const [a, b] = await seedThree(t);
  const ids = await mailboxIds();
  await page.goto('/');
  await row(page, b.subject).click();
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();

  await row(page, b.subject).hover();
  const actions = page.getByRole('toolbar', { name: `Actions for ${b.subject}` });
  await expect(actions).toBeVisible();
  await actions.getByRole('button', { name: 'Archive' }).click();

  await expect(row(page, b.subject)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/${a.id}$`));
  await expect(page.getByRole('heading', { name: a.subject, level: 2 })).toBeVisible();
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).includes(b.subject)).toBe(true);

  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, b.subject)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).includes(b.subject)).toBe(false);
  await expect.poll(async () => (await subjectsIn(b.mailboxId)).includes(b.subject)).toBe(true);
});

test('after archive → z, the message is back at its original position, not at the top (PST-T-14.10)', async ({ page }) => {
  const t = tag();
  // One seed call each, so the three internal dates are strictly ordered (the list sorts by date).
  const seeded: SeededMessage[] = [];
  for (const [label, who] of [['Oldest', 'ada'], ['Middle', 'grace'], ['Newest', 'alan']] as const) {
    const [m] = await seedMail(api, [{ subject: `${label} ${t}`, from: `${who} <${who}.${t}@example.org>`, text: `${label} ${t}.` }]);
    if (m === undefined) throw new Error('seed returned nothing');
    seeded.push(m);
  }
  const [a, b, c] = seeded as [SeededMessage, SeededMessage, SeededMessage];
  const expected = [c.subject, b.subject, a.subject];
  const listed = async (): Promise<string[]> => {
    const names = await page.getByRole('listbox', { name: 'Messages in Inbox' }).getByRole('option').allTextContents();
    return names.flatMap((n) => expected.filter((s) => n.includes(s)));
  };
  await page.goto('/');
  await row(page, b.subject).click();
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
  await expect.poll(listed).toEqual(expected);

  await page.keyboard.press('e');
  await expect(row(page, b.subject)).toHaveCount(0);
  await expect.poll(listed).toEqual([c.subject, a.subject]);
  await page.keyboard.press('z');
  await expect(toasts(page)).toContainText('Moved back to Inbox.');
  await expect(row(page, b.subject)).toHaveCount(1);
  // Between the two it was between — it has a new (higher) UID, but the same internal date.
  await expect.poll(listed).toEqual(expected);
  await expect.poll(async () => (await subjectsIn(b.mailboxId)).filter((s) => expected.includes(s))).toEqual(expected);
  // And after a reload, from the server's first page.
  await page.reload();
  await expect.poll(listed).toEqual(expected);
});

test('delete (#) from the list with nothing open moves the cursor row to Trash, and z brings it back', async ({ page }) => {
  const t = tag();
  const [, , c] = await seedThree(t);
  const ids = await mailboxIds();
  await page.goto('/');
  await expect(row(page, c.subject)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('#');
  await expect(row(page, c.subject)).toHaveCount(0);
  await expect(toasts(page)).toContainText(`Moved to Trash · ${c.subject}`);
  await expect.poll(async () => (await subjectsIn(ids['trash'] ?? '')).includes(c.subject)).toBe(true);
  await page.keyboard.press('z');
  await expect(row(page, c.subject)).toHaveCount(1);
  await expect.poll(async () => (await subjectsIn(ids['trash'] ?? '')).includes(c.subject)).toBe(false);
});

test('x selects rows and swaps the header for a selection toolbar that acts on all of them', async ({ page }) => {
  const t = tag();
  const [, b, c] = await seedThree(t);
  const ids = await mailboxIds();
  await page.goto('/');
  await expect(row(page, c.subject)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('x');
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  const bar = page.getByRole('toolbar', { name: 'Selected messages' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('2 selected');
  await expect(row(page, c.subject)).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, b.subject)).toHaveAttribute('aria-checked', 'true');

  // axe in selection mode, with the row actions and toolbar on screen.
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);

  await bar.getByRole('button', { name: 'Archive' }).click();
  await expect(row(page, b.subject)).toHaveCount(0);
  await expect(row(page, c.subject)).toHaveCount(0);
  await expect(bar).toBeHidden();
  await expect(toasts(page)).toContainText('Moved 2 messages to Archive');
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).filter((s) => s.endsWith(t)).sort()).toEqual([b.subject, c.subject].sort());

  await page.keyboard.press('z');
  await expect(row(page, b.subject)).toHaveCount(1);
  await expect(row(page, c.subject)).toHaveCount(1);
  await expect.poll(async () => (await subjectsIn(ids['archive'] ?? '')).filter((s) => s.endsWith(t))).toEqual([]);

  // Escape leaves selection.
  await page.keyboard.press('x');
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});

test('v opens Move; choosing a mailbox moves the open message there and opens the next one', async ({ page }) => {
  const t = tag();
  const [a, b] = await seedThree(t);
  const ids = await mailboxIds();
  await page.goto(`/mail/${b.mailboxId}/${b.id}`);
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
  await page.keyboard.press('v');
  const dialog = page.getByRole('dialog', { name: 'Move to' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Inbox' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Junk' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/${a.id}$`));
  await expect(toasts(page)).toContainText(`Moved to Junk · ${b.subject}`);
  await expect.poll(async () => (await subjectsIn(ids['junk'] ?? '')).includes(b.subject)).toBe(true);
});

test('the row actions are reachable from the keyboard, not only on hover', async ({ page }) => {
  const t = tag();
  const [, , c] = await seedThree(t);
  await page.goto('/');
  const list = page.getByRole('listbox', { name: 'Messages in Inbox' });
  await list.focus();
  // The keyboard drives it: j and back with k, so the cursor is on the top row again.
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  const actions = page.getByRole('toolbar', { name: `Actions for ${c.subject}` });
  await expect(actions).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(actions.getByRole('button', { name: 'Archive' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(actions.getByRole('button', { name: 'Delete' })).toBeFocused();
});

test('mail arriving under the pointer waits behind an "N new" pill instead of shifting the rows', async ({ page }) => {
  const t = tag();
  const [, , c] = await seedThree(t);
  await page.goto('/');
  await row(page, c.subject).hover();
  const [n] = await seedMail(api, [{ subject: `Arrived ${t}` }]);
  if (n === undefined) throw new Error('seed returned nothing');
  const pill = page.getByRole('button', { name: /new message/ });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(row(page, n.subject)).toHaveCount(0);
  await pill.click();
  await expect(page.getByRole('option').first()).toContainText(n.subject);
  await expect(pill).toHaveCount(0);
});

test('reduced motion: the row goes without an exit animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const t = tag();
  const [, b] = await seedThree(t);
  await page.goto(`/mail/${b.mailboxId}/${b.id}`);
  await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
  await page.keyboard.press('e');
  await expect(row(page, b.subject)).toHaveCount(0);
  expect(await page.locator('.pr-mrow--leaving').count()).toBe(0);
});
