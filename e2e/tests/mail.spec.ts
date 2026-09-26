// PST-T-3.10's exit demo, as a suite: the three-pane webmail at 1280 px (sidebar, list, reading
// pane; j/k/Enter/e/r/a/c/s/? from the keyboard; new mail arriving live over SSE) and push navigation
// at 390 px (list → message → back, with the browser's back button too), plus axe in both themes.
// PST-REQ-077, PST-REQ-083, PST-REQ-084; HTML is never put into the app's document (PST-REQ-159).
//
// Mail is filed through the e2e-only POST /api/admin/dev/seed (POSTROOM_E2E_SEED=1): the stack has
// no other way for a browser test to deliver mail. Each test tags its subjects, because every test
// (and both projects) share one inbox.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

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

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

const isDesktop = (name: string): boolean => name === 'desktop';

const row = (page: Page, subject: string) => page.getByRole('option', { name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

async function inboxList(page: Page) {
  await page.goto('/');
  const list = page.getByRole('listbox', { name: 'Messages in Inbox' });
  await expect(list).toBeVisible();
  return list;
}

async function mailboxIds(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; specialUse: string | null }[] };
  const out: Record<string, string> = {};
  for (const m of mailboxes) if (m.specialUse !== null) out[m.specialUse] = m.id;
  return out;
}

test.describe('at 1280 px', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(!isDesktop(testInfo.project.name), 'the three-pane layout is the desktop project');
  });

  test('three panes; j/k move the selection and Enter opens the message', async ({ page }) => {
    const t = tag();
    const [a, b, c] = await seedMail(api, [
      { subject: `Alpha ${t}`, text: `Body of alpha ${t}.` },
      { subject: `Bravo ${t}` },
      { subject: `Charlie ${t}` },
    ]);
    if (a === undefined || b === undefined || c === undefined) throw new Error('seed returned too few');

    await inboxList(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Inbox/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inbox', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No message open' })).toBeVisible();

    // Newest first, and the cursor starts on the top row.
    await expect(row(page, c.subject)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('j');
    await expect(row(page, b.subject)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, c.subject)).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('k');
    await expect(row(page, c.subject)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(row(page, a.subject)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(new RegExp(`/mail/${a.mailboxId}/${a.id}$`));
    await expect(page.getByRole('heading', { name: a.subject, level: 2 })).toBeVisible();
    await expect(page.getByTestId('message-text')).toHaveText(`Body of alpha ${t}.`);
    // All three panes at once.
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // Opening it marked it read.
    await expect(row(page, a.subject)).not.toHaveClass(/pr-row--unread/);

    // With a message open, j/k walk the messages themselves.
    await page.keyboard.press('k');
    await expect(page.getByRole('heading', { name: b.subject, level: 2 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${b.id}$`));
  });

  test('e archives: the message leaves the Inbox and is in Archive', async ({ page }) => {
    const t = tag();
    const [d] = await seedMail(api, [{ subject: `Archive me ${t}` }]);
    if (d === undefined) throw new Error('seed returned nothing');
    await inboxList(page);
    await row(page, d.subject).click();
    await expect(page.getByRole('heading', { name: d.subject, level: 2 })).toBeVisible();

    await page.keyboard.press('e');
    await expect(row(page, d.subject)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Moved to Archive.' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/mail/${d.mailboxId}$`));

    const ids = await mailboxIds();
    await expect
      .poll(async () => {
        const res = await api.get(`/api/mailboxes/${ids['archive'] ?? ''}/messages`);
        return ((await res.json()) as { messages: { subject: string }[] }).messages.some((m) => m.subject === d.subject);
      })
      .toBe(true);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Archive/ }).click();
    await expect(page.getByRole('listbox', { name: 'Messages in Archive' })).toBeVisible();
    await expect(row(page, d.subject)).toBeVisible();
  });

  test('r opens the reply with Re: and the sender; a replies to all but me; c composes', async ({ page }) => {
    const t = tag();
    const [e] = await seedMail(api, [
      {
        subject: `Quarterly numbers ${t}`,
        from: 'Alice Example <alice@example.org>',
        cc: 'Bob Example <bob@example.org>, operator@d3cloud.io',
        text: 'Numbers attached.',
      },
    ]);
    if (e === undefined) throw new Error('seed returned nothing');
    await inboxList(page);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: e.subject, level: 2 })).toBeVisible();

    await page.keyboard.press('r');
    const reply = page.getByRole('region', { name: 'Reply', exact: true });
    await expect(reply).toBeVisible();
    await expect(page).toHaveURL(/compose=reply$/);
    await expect(reply.getByRole('textbox', { name: 'To' })).toHaveValue('Alice Example <alice@example.org>');
    await expect(reply.getByRole('textbox', { name: 'Subject' })).toHaveValue(`Re: Quarterly numbers ${t}`);
    await expect(reply).toHaveAttribute('data-in-reply-to', e.messageIdHeader);
    await expect(reply.getByRole('textbox', { name: 'Message' })).toHaveValue(/> Numbers attached\./);
    await reply.getByRole('button', { name: 'Discard' }).click();
    await expect(reply).toBeHidden();

    await page.keyboard.press('a');
    const all = page.getByRole('region', { name: 'Reply all' });
    await expect(all).toBeVisible();
    await expect(all.getByRole('textbox', { name: 'To' })).toHaveValue('Alice Example <alice@example.org>');
    await expect(all.getByRole('textbox', { name: 'Cc' })).toHaveValue('Bob Example <bob@example.org>');
    await all.getByRole('button', { name: 'Discard' }).click();

    await page.keyboard.press('c');
    const fresh = page.getByRole('region', { name: 'New message' });
    await expect(fresh).toBeVisible();
    await expect(fresh.getByRole('textbox', { name: 'To' })).toHaveValue('');
    await expect(fresh.getByRole('textbox', { name: 'To' })).toBeFocused();
    await expect(fresh.getByRole('textbox', { name: 'Subject' })).toHaveValue('');
    // Typing in the composer is typing, not shortcuts.
    await page.keyboard.type('jk');
    await expect(fresh.getByRole('textbox', { name: 'To' })).toHaveValue('jk');
  });

  test('? shows the shortcuts overlay, and ? again hides it', async ({ page }) => {
    await inboxList(page);
    await page.keyboard.press('?');
    const overlay = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('cell', { name: 'Archive', exact: true })).toBeVisible();
    await page.keyboard.press('?');
    await expect(overlay).toBeHidden();
  });

  test('s stars the selected message, optimistically and on the server', async ({ page }) => {
    const t = tag();
    const [s] = await seedMail(api, [{ subject: `Star me ${t}` }]);
    if (s === undefined) throw new Error('seed returned nothing');
    await inboxList(page);
    await expect(row(page, s.subject)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('s');
    await expect(row(page, s.subject)).toContainText('starred');
    await expect
      .poll(async () => ((await (await api.get(`/api/messages/${s.id}`)).json()) as { flags: string[] }).flags)
      .toContain('\\Flagged');
  });

  test('new mail appears at the top without a reload (SSE)', async ({ page }) => {
    await inboxList(page);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const t = tag();
    const [n] = await seedMail(api, [{ subject: `Live arrival ${t}` }]);
    if (n === undefined) throw new Error('seed returned nothing');
    await expect(row(page, n.subject)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('option').first()).toContainText(n.subject);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Inbox, \d+ unread$/ })).toBeVisible();
  });

  test('an HTML-only message shows the placeholder and never injects its HTML', async ({ page }) => {
    const t = tag();
    const [h] = await seedMail(api, [{ subject: `HTML only ${t}`, text: null, html: '<p id="injected-by-mail">Hello</p><script>window.pwned = 1</script>' }]);
    if (h === undefined) throw new Error('seed returned nothing');
    await inboxList(page);
    await row(page, h.subject).click();
    await expect(page.getByTestId('html-placeholder')).toContainText('HTML version only');
    await expect(page.locator('#injected-by-mail')).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as unknown as { pwned?: number }).pwned)).toBeUndefined();
  });
});

test.describe('at 390 px', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(isDesktop(testInfo.project.name), 'push navigation is the mobile project');
  });

  test('push navigation: list → message → back, and the browser back button', async ({ page }) => {
    const t = tag();
    const [g] = await seedMail(api, [{ subject: `Pocket read ${t}`, text: 'Small screens too.' }]);
    if (g === undefined) throw new Error('seed returned nothing');
    const list = await inboxList(page);
    // One pane at a time: no reading pane beside the list.
    await expect(page.getByRole('heading', { name: 'No message open' })).toHaveCount(0);

    await row(page, g.subject).click();
    await expect(page).toHaveURL(new RegExp(`/mail/${g.mailboxId}/${g.id}$`));
    await expect(page.getByRole('heading', { name: g.subject, level: 2 })).toBeVisible();
    await expect(list).toBeHidden();

    await page.getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/mail/${g.mailboxId}$`));
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();

    await row(page, g.subject).click();
    await expect(page.getByRole('heading', { name: g.subject, level: 2 })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
    await expect(page.getByRole('heading', { name: g.subject, level: 2 })).toHaveCount(0);

    // Up one more level: the mailboxes, then back down into one.
    await page.getByRole('link', { name: 'Mailboxes', exact: true }).click();
    await expect(page).toHaveURL(/\/mail$/);
    await expect(page.getByRole('heading', { name: 'Mailboxes', level: 2 })).toBeVisible();
    await page.getByRole('navigation', { name: 'Mailboxes' }).getByRole('link', { name: /^Archive/ }).click();
    await expect(page.getByRole('listbox', { name: 'Messages in Archive' }).or(page.getByRole('heading', { name: 'No messages here' }))).toBeVisible();
  });
});

test('the mail view has no axe violations, in light and dark', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [{ subject: `Axe ${t}`, text: 'Accessible.', attachment: { filename: 'notes.txt', contentType: 'text/plain', content: 'hi' } }]);
  if (m === undefined) throw new Error('seed returned nothing');
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
    await expect(page.getByRole('link', { name: /notes\.txt/ })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${theme} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
  }
});
