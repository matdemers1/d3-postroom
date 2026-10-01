// PST-T-14.9 (PST-ADR-011; design audit TF-12, TF-I5, MOD-I8, IA-09, IA-I5): sorting you can see and
// correct where you read, end to end.
//
//  - A bucket chip shows only where the bucket isn't implied (Inbox → Everything; not the Priority
//    segment, not inside a bucket folder). Clicking it opens "Why it's here": one plain sentence from
//    the STORED reasons, and the corrections.
//  - A correction is a move plus a recorded sender preference: the row leaves, a Toast offers Undo,
//    the server has the message in its new bucket and a pin for the sender, and Settings → Rules lists
//    it under "Sorting corrections" with Undo, which reverses both.
//  - The Inbox segment is remembered per browser; Everything is the default.
//  - The sender's name opens one Person card: contact status (Add to contacts), their routing as a
//    control, recent messages, and "Open full profile".
//  - axe is green with the popover and the card open.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeededMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

const PASS = {
  spf: { result: 'pass', domain: 'example.org' },
  dkim: [{ result: 'pass', domain: 'example.org' }],
  dmarc: { result: 'pass', policy: 'none', domain: 'example.org' },
  arc: { result: 'none' },
};
const AUTH_REASON = 'auth: spf=pass dkim=pass dmarc=pass arc=none';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (page: Page, name = 'Inbox') => page.getByRole('listbox', { name: `Messages in ${name}` });
const row = (page: Page, subject: string, name = 'Inbox') => list(page, name).getByRole('option', { name: new RegExp(escape(subject)) });
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

async function mailboxByName(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; name: string }[] };
  return Object.fromEntries(mailboxes.map((m) => [m.name, m.id]));
}

async function subjectsIn(mailboxId: string): Promise<string[]> {
  const res = await api.get(`/api/mailboxes/${mailboxId}/messages?limit=200`);
  return ((await res.json()) as { messages: { subject: string }[] }).messages.map((m) => m.subject);
}

async function corrections(): Promise<{ id: string; subject: string | null; target: string; toBucket: string }[]> {
  return ((await (await api.get('/api/sorting/corrections')).json()) as { corrections: { id: string; subject: string | null; target: string; toBucket: string }[] }).corrections;
}

/** A person's first message: filed in the Inbox as People, with the reason the classifier stores. */
async function seedPerson(t: string, who = 'Sam Whitaker'): Promise<SeededMessage> {
  const [m] = await seedMail(api, [
    {
      subject: `Intro ${who} ${t}`,
      from: `${who} <${who.toLowerCase().replace(/\s+/g, '.')}.${t}@example.net>`,
      text: `Hey — would you be up for a call? ${t}`,
      authVerdicts: PASS,
      bucket: 'people',
      reasons: [AUTH_REASON, 'people: human sender not in reply graph, contacts, or an authenticated VIP pin', 'filed: INBOX with keyword $People'],
    },
  ]);
  if (m === undefined) throw new Error('seed returned nothing');
  return m;
}

async function goInbox(page: Page): Promise<void> {
  await page.goto('/');
  await expect(list(page)).toBeVisible();
}

test.describe('the bucket chip and its corrections', () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'driven from the three-pane layout');
    await context.addCookies(cookies);
  });

  test('chip → why → "Move this message to Notifications": moved, pinned, listed in Rules, and Undo there reverses both', async ({ page }) => {
    const t = tag();
    const m = await seedPerson(t, 'Pat Updates');
    const boxes = await mailboxByName();
    await goInbox(page);

    // Everything is the default, and there the People chip is shown beside the subject.
    await expect(page.getByRole('radio', { name: /^Everything/ })).toHaveAttribute('aria-checked', 'true');
    const chip = row(page, m.subject).locator('[data-chip]');
    await expect(chip).toHaveText(/People/);
    await chip.click();

    const why = page.getByRole('dialog', { name: "Why it's here" });
    await expect(why).toBeVisible();
    // One plain sentence, from the stored reasons.
    await expect(why.getByTestId('why-sentence')).toHaveText('Filed in your Inbox as People because a person wrote, but you have not written to them or saved them as a contact yet.');
    await expect(why.getByRole('button', { name: 'Always put Pat Updates in People' })).toBeVisible();
    await expect(why.getByRole('button', { name: 'Move this message to Priority' })).toBeVisible();
    await expect(why.getByRole('button', { name: 'Open Rules' })).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(WCAG).include('[data-testid="why-popover"]').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);

    await why.getByRole('button', { name: 'Somewhere else…' }).click();
    await why.getByRole('button', { name: 'Move this message to Updates' }).click();

    // The row leaves; the Toast says what happened and offers Undo.
    await expect(row(page, m.subject)).toHaveCount(0);
    await expect(toasts(page)).toContainText('Moved to Updates · preference saved');
    await expect.poll(async () => (await subjectsIn(boxes['Updates'] ?? '')).includes(m.subject)).toBe(true);
    const listed = (await corrections()).find((c) => c.subject === m.subject);
    expect(listed).toMatchObject({ target: `pat.updates.${t}@example.net`, toBucket: 'updates' });

    // Settings → Rules → Sorting corrections, with Undo.
    await page.goto('/settings/rules#sorting-corrections');
    const section = page.locator('#sorting-corrections');
    await expect(section.getByRole('heading', { name: 'Sorting corrections' })).toBeVisible();
    await expect(section).toContainText(m.subject);
    await expect(section).toContainText('People → Updates');
    await section.getByRole('button', { name: `Undo the correction for ${m.subject}` }).click();
    await expect(section.getByRole('alert').or(section.getByRole('status')).first()).toContainText('the message is back in People');
    await expect(section).not.toContainText('People → Updates');
    await expect.poll(async () => (await subjectsIn(boxes['INBOX'] ?? '')).includes(m.subject)).toBe(true);
    expect((await corrections()).some((c) => c.subject === m.subject)).toBe(false);
  });

  test('the Toast\'s Undo reverses a correction made in the Inbox', async ({ page }) => {
    const t = tag();
    const m = await seedPerson(t, 'Toast Person');
    await goInbox(page);
    await row(page, m.subject).locator('[data-chip]').click();
    const why = page.getByRole('dialog', { name: "Why it's here" });
    // Arrow keys move through the actions; Enter picks.
    await expect(why.getByRole('button', { name: 'Always put Toast Person in People' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(why.getByRole('button', { name: 'Move this message to Priority' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(toasts(page)).toContainText('Moved to Priority · preference saved');
    // Priority is still the Inbox: the row stays in Everything, now with a Priority chip.
    await expect(row(page, m.subject).locator('[data-chip]')).toHaveText(/Priority/);
    await expect.poll(async () => (await corrections()).some((c) => c.subject === m.subject)).toBe(true);

    await toasts(page).getByRole('button', { name: 'Undo' }).click();
    await expect(toasts(page)).toContainText('Correction undone');
    await expect.poll(async () => (await corrections()).some((c) => c.subject === m.subject)).toBe(false);
    await expect(row(page, m.subject).locator('[data-chip]')).toHaveText(/People/);
  });

  test('no chip where the bucket is implied, and the segment is remembered per browser', async ({ page }) => {
    const t = tag();
    const [n] = await seedMail(api, [
      {
        mailbox: 'notifications',
        subject: `Build failed ${t}`,
        from: `CI <ci@builds-${t}.example>`,
        authVerdicts: PASS,
        bucket: 'notifications',
        reasons: [AUTH_REASON, `notifications: sender domain builds-${t}.example is a notification system (builds-${t}.example)`],
      },
    ]);
    if (n === undefined) throw new Error('seed returned nothing');
    await page.goto(`/mail/${n.mailboxId}`);
    await expect(row(page, n.subject, 'Notifications')).toBeVisible();
    await expect(row(page, n.subject, 'Notifications').locator('[data-chip]')).toHaveCount(0);

    await goInbox(page);
    await page.getByRole('radio', { name: /^Priority/ }).click();
    await expect(page.getByRole('radio', { name: /^Priority/ })).toHaveAttribute('aria-checked', 'true');
    await expect(list(page).locator('[data-chip]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('radio', { name: /^Priority/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: /^Everything/ }).click();
    await page.reload();
    await expect(page.getByRole('radio', { name: /^Everything/ })).toHaveAttribute('aria-checked', 'true');
  });

  // PST-T-16.21 (PST-DA-016): the chip stays away inside a bucket folder, but the open message's header
  // carries a quiet "Why it's here" control there, which opens the same popover.
  for (const [folder, mailbox, bucket, label, reason] of [
    ['Receipts', 'receipts', 'receipts', 'Receipts', 'receipts: sender domain sends order and payment confirmations'],
    ['Junk', 'junk', 'junk', 'Junk', 'junk: spam score over the threshold'],
  ] as const) {
    test(`a message opened in ${folder} offers "Why it's here" in its header`, async ({ page }) => {
      const t = tag();
      const [m] = await seedMail(api, [
        {
          mailbox,
          subject: `${folder} order ${t}`,
          from: `Shop <shop-${t}@example.shop>`,
          authVerdicts: PASS,
          bucket,
          reasons: [AUTH_REASON, reason],
        },
      ]);
      if (m === undefined) throw new Error('seed returned nothing');
      await page.goto(`/mail/${m.mailboxId}/${m.id}`);
      const header = page.getByTestId('message-header');
      await expect(header).toBeVisible();
      // No chip here: the folder already says it.
      await expect(header.getByTestId('bucket-chip')).toHaveCount(0);
      const control = header.getByRole('button', { name: 'Why it’s here' });
      await expect(control).toBeVisible();
      await control.click();

      const why = page.getByRole('dialog', { name: "Why it's here" });
      await expect(why).toBeVisible();
      await expect(why.getByTestId('why-sentence')).not.toHaveText(/Loading the reasons/);
      await expect(why.getByTestId('why-sentence')).toContainText(label);
      await expect(why.getByRole('button', { name: new RegExp(`^Always put .* in ${label}$`) })).toBeVisible();
      await expect(why.getByRole('button', { name: /^Move this message to / }).first()).toBeVisible();
      await expect(why.getByRole('button', { name: 'Open Rules' })).toBeVisible();
      // There is never a positive "Verified" chip (BRAND-04).
      await expect(header).not.toContainText(/verified/i);

      await page.keyboard.press('Escape');
      await expect(why).toBeHidden();
      await expect(control).toBeFocused();
    });
  }
});

test.describe('a message moved into a folder by hand', () => {
  // PST-T-16.21: a manual move only moves the message, so its stored verdict still names the bucket it
  // was in. The control must not claim "Filed in your Inbox as People" for a message sitting in Receipts.
  test('says so plainly and corrects from where it is now', async ({ page }) => {
    const t = tag();
    const [m] = await seedMail(api, [{ subject: `Moved by hand ${t}`, from: `Pat <pat-${t}@example.org>`, authVerdicts: PASS, bucket: 'people', reasons: [AUTH_REASON] }]);
    if (m === undefined) throw new Error('seed returned nothing');
    const receipts = (await mailboxByName())['Receipts'];
    if (receipts === undefined) throw new Error('no Receipts mailbox');
    const detail = (await (await api.get(`/api/messages/${m.id}`)).json()) as { modseq: string };
    const res = await api.patch(`/api/messages/${m.id}`, { headers: { 'x-postroom-csrf': '1', 'if-match': `"${detail.modseq}"` }, data: { mailboxId: receipts } });
    expect(res.ok()).toBe(true);

    await page.goto(`/mail/${receipts}/${m.id}`);
    await page.getByTestId('message-header').getByRole('button', { name: 'Why it’s here' }).click();
    const why = page.getByRole('dialog', { name: "Why it's here" });
    await expect(why.getByTestId('why-sentence')).toHaveText('You moved this here.');
    await expect(why.getByRole('button', { name: /^Always put .* in Receipts$/ })).toBeVisible();
    await expect(why.getByText(/Filed in your Inbox/)).toHaveCount(0);
  });
});

test.describe('the Person card', () => {
  test('the sender name opens one card: contact, routing, recent, full profile', async ({ page }, testInfo) => {
    const t = tag();
    const m = await seedPerson(t, 'Casey Card');
    const address = `casey.card.${t}@example.net`;
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();

    // The keyboard's way to "Why it's here": the open message's header chip (Everything implies no bucket).
    const headerChip = page.getByTestId('message-header').getByRole('button', { name: "People: why it's here" });
    await expect(headerChip).toBeVisible();
    await headerChip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: "Why it's here" })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: "Why it's here" })).toBeHidden();
    await expect(headerChip).toBeFocused();

    await page.getByTestId('message-header').getByRole('button', { name: 'Casey Card' }).click();
    const card = page.getByRole('dialog', { name: 'Casey Card' });
    await expect(card).toBeVisible();
    if (testInfo.project.name === 'mobile') await expect(card).toHaveAttribute('aria-modal', 'true');
    await expect(card).toContainText(address);
    await expect(card).toContainText('Not in your contacts');
    // The design-system Select (PST-T-14.11): its trigger names the choice.
    const routing = card.getByRole('combobox', { name: 'Their mail goes to' });
    await expect(routing).toContainText('Sorted automatically');
    await expect(card.getByRole('link', { name: new RegExp(escape(m.subject)) })).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(WCAG).include('[data-testid="person-card"]').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);

    // Routing is a control: the sender pin, audited server-side.
    await routing.click();
    await page.getByRole('option', { name: 'Receipts' }).click();
    await expect(card).toBeVisible();
    await expect(card.getByRole('status')).toContainText('New mail from Casey Card goes to Receipts.');
    await expect.poll(async () => ((await (await api.get(`/api/senders/${encodeURIComponent(address)}/pin`)).json()) as { bucket: string | null }).bucket).toBe('receipts');
    await routing.click();
    await page.getByRole('option', { name: /^Sorted automatically/ }).click();
    await expect.poll(async () => ((await (await api.get(`/api/senders/${encodeURIComponent(address)}/pin`)).json()) as { bucket: string | null }).bucket).toBeNull();

    await card.getByRole('button', { name: 'Add to contacts' }).click();
    await expect(card).toContainText('In your contacts');

    // Esc closes it and focus goes back to the name.
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(page.getByTestId('message-header').getByRole('button', { name: 'Casey Card' })).toBeFocused();

    await page.getByTestId('message-header').getByRole('button', { name: 'Casey Card' }).click();
    await page.getByRole('dialog', { name: 'Casey Card' }).getByRole('link', { name: /Open full profile/ }).click();
    await expect(page).toHaveURL(new RegExp(`/senders/${escape(encodeURIComponent(address))}`));
  });
});
