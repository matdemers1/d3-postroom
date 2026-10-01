// PST-T-3.11's exit demo, as a suite (PST-REQ-079): open a message, r, type, Send — the composer
// closes back to the message it answered (PST-T-3.15) and the reply is in that open thread and in
// Sent, without a reload; a draft saved and closed comes back with its text when the reply is
// reopened; a forward carries the original.
//
// PST-T-14.7 (PST-REQ-191/192/193): replies and forwards open INLINE under the thread, which stays
// on screen, with the quote folded behind "···"; a new message opens in the reading pane with only
// To (chips, contact autocomplete), Subject and the body — Cc and Bcc revealed on demand; Discard
// moves the draft to Trash with an Undo toast that moves it back; a draft opened from Drafts (or
// its Edit draft button) resumes in the composer.
//
// PST-T-15.4 (PST-REQ-194): the composer drawn to the redesign canvas — a "New message" header with
// Minimise, Open full screen and Close; Send as the library's SplitButton (▾ More send options: Send
// later…); Formatting, Insert link and More; "Draft saved" and Discard draft on the right — and
// nothing else by default, axe-clean in both themes. PST-T-15.11 adds Attach files before Formatting;
// its flows are e2e/tests/attachments.spec.ts.
//
// Sending needs DKIM keys (submission never sends unsigned), and the e2e stack has no operator step
// that makes them, so the suite asks for them through the e2e-only POST /api/compose/dev/dkim-keys
// (mounted only with POSTROOM_E2E_SEED=1, like the seed route). Every message this suite sends is
// cancelled on the outbound queue straight away, and the suite waits for the queue to settle, so no
// bounce lands in the shared Inbox while the other specs run.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { clearSuppressions, ensureOperator, seedMail, signInCookies, tag } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });
// The composer flows run in the three-pane desktop layout; the mobile project skips the file (and so
// burns no TOTP step on it).
test.skip(({ isMobile }) => isMobile, 'the composer flows run in the three-pane desktop layout');

const CSRF = { 'x-postroom-csrf': '1' };

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const outbound: string[] = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  // A fresh TOTP step can be up to 30 s away, and the first DKIM keys include an RSA-2048 keypair.
  test.setTimeout(120_000);
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  const operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  const keys = await api.post('/api/compose/dev/dkim-keys', { headers: CSRF });
  if (!keys.ok()) throw new Error(`dkim-keys answered ${String(keys.status())}: ${await keys.text()} (start the api with POSTROOM_E2E_SEED=1)`);
});

interface DeliveryView {
  recipients: { id: string; state: string }[];
}

/** Pull what this suite queued back off the outbound queue, then wait until nothing is in flight. */
async function cancelOutbound(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const view = (await (await api.get(`/api/messages/${id}/delivery`)).json()) as DeliveryView;
    for (const r of view.recipients) {
      if (r.state === 'queued' || r.state === 'deferred') await api.post(`/api/messages/${id}/recipients/${r.id}/cancel`, { headers: CSRF });
    }
  }
  await expect
    .poll(
      async () => {
        let busy = 0;
        for (const id of ids) {
          const view = (await (await api.get(`/api/messages/${id}/delivery`)).json()) as DeliveryView;
          busy += view.recipients.filter((r) => r.state === 'queued' || r.state === 'attempting' || r.state === 'deferred').length;
        }
        return busy;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
}

test.afterAll(async () => {
  await cancelOutbound(outbound);
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  // Earlier sends to these example addresses hard-bounce off a null MX and are suppressed.
  await clearSuppressions(api);
  await context.addCookies(cookies);
  // These specs prove what a send does once it goes. The undo window (PST-T-9.1, default 10 s) is
  // its own spec's subject, so it is off here: a send goes at once, as it did before undo existed.
  await context.addInitScript({ content: "window.localStorage.setItem('postroom.undoSeconds', '0');" });
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page: Page, subject: string) => page.getByRole('option', { name: new RegExp(escape(subject)) });

async function openFromInbox(page: Page, subject: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  await row(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
}

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  // The composer rises and fades in (--dur-3), rows open (--dur-2), menus drop in: axe measures
  // colour, so it measures once everything has arrived — never a half-faded frame.
  await page.waitForFunction(() => (globalThis as unknown as { document: { getAnimations: () => { playState: string }[] } }).document.getAnimations().every((a) => a.playState !== 'running'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function mailboxIds(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; specialUse: string | null }[] };
  const out: Record<string, string> = {};
  for (const m of mailboxes) if (m.specialUse !== null) out[m.specialUse] = m.id;
  return out;
}

async function subjectsIn(mailboxId: string): Promise<string[]> {
  const res = await api.get(`/api/mailboxes/${mailboxId}/messages?limit=200`);
  return ((await res.json()) as { messages: { subject: string | null }[] }).messages.map((m) => m.subject ?? '');
}

/** The outbound id of the newest queued message with this subject, remembered for cancelling. */
async function remember(subject: string): Promise<void> {
  const res = await api.get('/api/messages/outbound?limit=100');
  const body = (await res.json()) as { messages: { id: string; subject: string | null }[] };
  const found = body.messages.find((m) => m.subject === subject);
  if (found !== undefined) {
    outbound.push(found.id);
    await cancelOutbound([found.id]);
  }
}

test('doneWhen: r, type, Send — inline under the thread; the reply is in the thread and in Sent, without a reload', async ({ page }) => {
  const t = tag();
  const subject = `Lunch on Friday ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Alice Example <alice@example.org>', text: 'Are you free for lunch?' }]);
  if (original === undefined) throw new Error('seed returned nothing');
  await openFromInbox(page, subject);

  await page.keyboard.press('r');
  const reply = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(reply).toBeVisible();
  await expect(page).toHaveURL(/compose=reply$/);
  // Inline: the thread it answers is still on screen, above it.
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  await expect(reply).toHaveAttribute('data-placement', 'inline');
  await expect(page.getByTestId('reader-scroll').getByRole('region', { name: 'Reply', exact: true })).toBeVisible();
  // To is a chip; the quote is folded behind "···"; the caret is in the text.
  await expect(reply.getByRole('list', { name: 'To recipients' })).toContainText('Alice Example');
  await expect(reply.getByRole('button', { name: 'Show quoted text' })).toBeVisible();
  await expect(reply.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await expect(reply.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await page.keyboard.type(`Friday works for me ${t}.`);
  await expectNoAxeViolations(page, 'inline reply');
  await reply.getByRole('button', { name: 'Send', exact: true }).click();

  // The composer closes back to the message it answered (PST-T-3.15), which is still open — and the
  // reply is already in its thread, without a reload.
  await expect(reply).toBeHidden();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation.locator('> li')).toHaveCount(2);
  await expect(conversation.locator('> li').first()).toContainText('Are you free for lunch?');
  await expect(conversation.locator('> li').last()).toContainText(`Friday works for me ${t}.`);
  await remember(`Re: ${subject}`);
  await expectNoAxeViolations(page, 'thread');

  // The thread, from the API: the seeded original and the Sent copy — with the folded quote sent.
  const detail = (await (await api.get(`/api/messages/${original.id}`)).json()) as { threadId: string | null };
  expect(detail.threadId).toMatch(/^[0-9a-f-]{36}$/);
  const thread = (await (await api.get(`/api/threads/${detail.threadId ?? ''}`)).json()) as { messages: { id: string; subject: string }[] };
  expect(thread.messages.map((m) => m.subject)).toEqual([subject, `Re: ${subject}`]);
  expect(thread.messages[0]?.id).toBe(original.id);

  // In Sent: the list and the reading pane agree, with no reload needed to get there either.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Sent/ }).click();
  await expect(page.getByRole('listbox', { name: 'Messages in Sent' })).toBeVisible();
  await row(page, `Re: ${subject}`).click();
  await expect(page.getByRole('heading', { name: `Re: ${subject}`, level: 2 })).toBeVisible();
  await expect(page.getByTestId('message-text')).toContainText(`Friday works for me ${t}.`);
  await expect(page.getByTestId('message-text')).toContainText('> Are you free for lunch?');
  const ids = await mailboxIds();
  expect(await subjectsIn(ids['sent'] ?? '')).toContain(`Re: ${subject}`);
});

test('a draft autosaves and comes back; Discard moves it to Trash and Undo brings it back; Drafts resumes it in the composer', async ({ page }) => {
  const t = tag();
  const subject = `Budget review ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Carol <carol@example.org>', text: 'Numbers inside.' }]);
  if (original === undefined) throw new Error('seed returned nothing');
  await openFromInbox(page, subject);

  await page.keyboard.press('r');
  const reply = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(reply).toBeVisible();
  await page.keyboard.type(`Half-written thoughts ${t}`);
  // No Save draft button: saving is automatic, and the footer says so.
  await expect(reply.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(reply.getByTestId('compose-status')).toContainText('Draft saved', { timeout: 15_000 });

  const ids = await mailboxIds();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).toContain(`Re: ${subject}`);

  // Close it (Escape keeps the draft), then reopen the reply: the text is back.
  await page.keyboard.press('Escape');
  await expect(reply).toBeHidden();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  await page.keyboard.press('r');
  const again = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(again.getByRole('textbox', { name: 'Message' })).toHaveValue(new RegExp(`^Half-written thoughts ${t}`));
  await expect(again.getByTestId('compose-status')).toContainText('Picked up your saved draft.');

  // Discard moves it out of Drafts and into Trash — never a hard delete (PST-T-14.1, PST-REQ-129) —
  // and a toast says so, with Undo.
  await again.getByRole('button', { name: 'Discard' }).click();
  await expect(again).toBeHidden();
  const toasts = page.getByRole('region', { name: 'Notifications' });
  await expect(toasts).toContainText('Draft moved to Trash.');
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).not.toContain(`Re: ${subject}`);
  await expect.poll(() => subjectsIn(ids['trash'] ?? '')).toContain(`Re: ${subject}`);

  // Undo moves it back to Drafts.
  await toasts.getByRole('button', { name: /Undo/ }).click();
  await expect(toasts).toContainText('Draft moved back to Drafts.');
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).toContain(`Re: ${subject}`);
  await expect.poll(() => subjectsIn(ids['trash'] ?? '')).not.toContain(`Re: ${subject}`);

  // Opened from Drafts, it resumes in the composer — editable, in the reading pane, still a reply.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Drafts/ }).click();
  await expect(page.getByRole('listbox', { name: 'Messages in Drafts' })).toBeVisible();
  await row(page, `Re: ${subject}`).click();
  await expect(page).toHaveURL(/compose=draft$/);
  const resumed = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(resumed).toHaveAttribute('data-placement', 'pane');
  await expect(resumed.getByRole('textbox', { name: 'Message' })).toHaveValue(new RegExp(`^Half-written thoughts ${t}`));
  await expect(resumed.getByRole('list', { name: 'To recipients' })).toContainText('Carol');
  await expect(resumed).toHaveAttribute('data-source-id', original.id);
  await expectNoAxeViolations(page, 'resumed draft');
  await page.keyboard.press('Escape');
  await expect(resumed).toBeHidden();

  // Read-only, its toolbar leads with Edit draft, which resumes it the same way.
  const draftsList = (await (await api.get(`/api/mailboxes/${ids['drafts'] ?? ''}/messages?limit=200`)).json()) as { messages: { id: string; subject: string | null }[] };
  const draftId = draftsList.messages.find((m) => m.subject === `Re: ${subject}`)?.id ?? '';
  await page.goto(`/mail/${ids['drafts'] ?? ''}/${draftId}`);
  await expect(page.getByRole('heading', { name: `Re: ${subject}`, level: 2 })).toBeVisible();
  await page.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'Edit draft' }).click();
  await expect(page.getByRole('region', { name: 'Reply', exact: true }).getByRole('textbox', { name: 'Message' })).toHaveValue(new RegExp(`^Half-written thoughts ${t}`));

  // Tidy up: discard it for good (to Trash).
  await page.getByRole('region', { name: 'Reply', exact: true }).getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).not.toContain(`Re: ${subject}`);
});

test('a forward opens inline and carries the original, attached whole', async ({ page }) => {
  const t = tag();
  const subject = `Site photos ${t}`;
  const [original] = await seedMail(api, [
    { subject, from: 'Dan <dan@example.org>', text: `Photos from the visit ${t}.`, attachment: { filename: 'notes.txt', contentType: 'text/plain', content: `field notes ${t}` } },
  ]);
  if (original === undefined) throw new Error('seed returned nothing');
  await openFromInbox(page, subject);

  await page.keyboard.press('f');
  const forward = page.getByRole('region', { name: 'Forward' });
  await expect(forward).toBeVisible();
  await expect(forward).toHaveAttribute('data-placement', 'inline');
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  await expect(forward.getByText('The original message is attached in full.')).toBeVisible();
  // The forwarded text is folded; "···" opens it for editing.
  await forward.getByRole('button', { name: 'Show quoted text' }).click();
  await expect(forward.getByRole('textbox', { name: 'Message' })).toHaveValue(/Forwarded message/);
  await forward.getByRole('combobox', { name: 'To' }).fill('erin@example.org');
  await forward.getByRole('combobox', { name: 'To' }).press('Enter');
  await expect(forward.getByRole('list', { name: 'To recipients' })).toContainText('erin@example.org');
  await forward.getByRole('button', { name: 'Send', exact: true }).click();

  // The composer closes back to the forwarded message itself (the one it was opened from).
  await expect(forward).toBeHidden();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  await remember(`Fwd: ${subject}`);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Sent/ }).click();
  await expect(page.getByRole('listbox', { name: 'Messages in Sent' })).toBeVisible();
  await row(page, `Fwd: ${subject}`).click();
  await expect(page.getByRole('heading', { name: `Fwd: ${subject}`, level: 2 })).toBeVisible();
  // Sent routes by its slug (/mail/sent/<id>, PST-T-16.4); any mailbox key works here.
  const sentId = /\/mail\/[^/?]+\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const raw = await (await api.get(`/api/messages/${sentId}/raw`)).text();
  expect(raw).toContain('Content-Type: message/rfc822');
  expect(raw).toContain(`Message-ID: ${original.messageIdHeader}`);
  expect(raw).toContain('filename="notes.txt"');
});

test('a new message opens with To, Subject and the body only; Cc and Bcc reveal on demand; contacts autocomplete; Send', async ({ page }) => {
  const t = tag();
  const subject = `Gear list ${t}`;
  // A contact to find by typing (erin@example.org is one of the addresses the suite un-suppresses).
  const books = (await (await api.get('/api/contacts/address-books')).json()) as { addressBooks: { id: string }[] };
  const book = books.addressBooks[0];
  if (book === undefined) throw new Error('no address book');
  const card = await api.post(`/api/contacts/address-books/${book.id}/cards`, {
    headers: CSRF,
    data: { fn: `Erin Okafor ${t}`, given: 'Erin', family: `Okafor ${t}`, emails: [{ address: 'erin@example.org', type: 'home' }], tels: [], org: '', note: '' },
  });
  expect(card.ok()).toBe(true);

  await page.goto('/?compose=new');
  const fresh = page.getByRole('region', { name: 'New message' });
  await expect(fresh).toBeVisible();
  await expect(fresh).toHaveAttribute('data-placement', 'pane');
  // Only To, Subject and the body — no Cc, Bcc or From rows, and none of the old always-on options.
  await expect(fresh.getByRole('combobox', { name: 'To' })).toBeFocused();
  await expect(fresh.getByRole('textbox', { name: 'Subject' })).toBeVisible();
  await expect(fresh.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(fresh.getByRole('combobox', { name: 'Cc' })).toHaveCount(0);
  await expect(fresh.getByRole('combobox', { name: 'Bcc' })).toHaveCount(0);
  await expect(fresh.getByText('Request read receipt')).toHaveCount(0);
  await expect(fresh.getByText('Remind me')).toHaveCount(0);
  await expectNoAxeViolations(page, 'new message');

  // Contact autocomplete: type part of the name, the contact is offered, Enter adds it as a chip.
  await page.keyboard.type(`Okafor ${t}`);
  const suggestion = fresh.getByRole('option', { name: /erin@example\.org/ });
  await expect(suggestion).toBeVisible();
  await expectNoAxeViolations(page, 'autocomplete open');
  await page.keyboard.press('Enter');
  await expect(fresh.getByRole('list', { name: 'To recipients' })).toContainText(`Erin Okafor ${t}`);

  // Cc reveals its row, focused, opening height + opacity (PST-REQ-192); Bcc stays a link until used.
  // The suite runs with reduced motion (playwright.config.ts); this part is about the motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await fresh.getByRole('button', { name: 'Cc', exact: true }).click();
  const cc = fresh.getByRole('combobox', { name: 'Cc' });
  await expect(cc).toBeFocused();
  await expect(fresh.getByRole('button', { name: 'Cc', exact: true })).toHaveCount(0);
  await expect(fresh.getByRole('button', { name: 'Bcc', exact: true })).toBeVisible();
  await expect(fresh.locator('[data-row="cc"]')).toHaveCSS('opacity', '1');
  await expect(fresh.locator('[data-row="cc"]')).toHaveCSS('animation-name', 'pr-compose-row-in');
  // Under reduced motion nothing moves (PST-REQ-193).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fresh.getByRole('button', { name: 'Bcc', exact: true }).click();
  await expect(fresh.getByRole('combobox', { name: 'Bcc' })).toBeFocused();
  await expect(fresh.locator('[data-row="bcc"]')).toHaveCSS('animation-name', 'none');
  await expect(fresh).toHaveCSS('animation-name', 'none');

  // The rare options live behind ⋯; Send later behind Send's ▾.
  await fresh.getByRole('button', { name: 'More options' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Write in Markdown' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Request read receipt' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Insert template…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign or encrypt…' })).toBeVisible();
  // Measured once the menu has finished fading in (--motion-menu-enter), not mid-animation.
  await expect(menu).toHaveCSS('opacity', '1');
  await expectNoAxeViolations(page, 'overflow menu');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(fresh).toBeVisible();
  await fresh.getByRole('button', { name: 'More send options' }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Send later…' })).toBeVisible();
  await page.keyboard.press('Escape');

  await fresh.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await fresh.getByRole('textbox', { name: 'Message' }).fill(`Tent, stove, lantern ${t}.`);
  await expectNoAxeViolations(page, 'new message, Cc and Bcc open');
  await fresh.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(fresh).toBeHidden();
  await remember(subject);
  const ids = await mailboxIds();
  await expect.poll(() => subjectsIn(ids['sent'] ?? '')).toContain(subject);
});

test('a new message names its draft in the URL once it autosaves, so a reload resumes it', async ({ page }) => {
  const t = tag();
  const subject = `Reload me ${t}`;
  await page.goto('/?compose=new');
  const fresh = page.getByRole('region', { name: 'New message' });
  await expect(fresh).toBeVisible();
  await fresh.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await fresh.getByRole('textbox', { name: 'Message' }).fill(`Half a thought ${t}`);
  await expect(fresh.getByTestId('compose-status')).toContainText('Draft saved', { timeout: 15_000 });
  await expect(page).toHaveURL(/\?compose=draft&id=[0-9a-f-]{36}$/);
  // The same composer carries on (it was not rebuilt): what was typed is still there, focus too.
  await expect(fresh.getByRole('textbox', { name: 'Message' })).toBeFocused();

  await page.reload();
  const resumed = page.getByRole('region', { name: 'New message' });
  await expect(resumed.getByRole('textbox', { name: 'Subject' })).toHaveValue(subject);
  await expect(resumed.getByRole('textbox', { name: 'Message' })).toHaveValue(`Half a thought ${t}`);

  // Tidy up: to Trash.
  await resumed.getByRole('button', { name: 'Discard' }).click();
  const ids = await mailboxIds();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).not.toContain(subject);
});

test('the canvas composer: a header with Minimise, full screen and Close; one quiet bar; nothing else; axe-clean in both themes', async ({ page, context }) => {
  const t = tag();
  await page.goto('/?compose=new');
  const fresh = page.getByRole('region', { name: 'New message' });
  await expect(fresh).toBeVisible();
  await expect(fresh.getByRole('heading', { name: 'New message', level: 2 })).toBeVisible();

  // Exactly these controls, and no others, are on screen by default (the To field's own combobox aside).
  // PST-T-15.11: Attach files (the canvas's paperclip) sits before Formatting.
  const names = ['Minimise', 'Open full screen', 'Close', 'Cc', 'Bcc', 'Send', 'More send options', 'Attach files', 'Formatting', 'Insert link', 'More options', 'Discard draft'];
  for (const name of names) await expect(fresh.getByRole('button', { name, exact: true })).toBeVisible();
  // The e2e project has no DOM lib: the elements are described structurally, as mobile.spec.ts does.
  type Shown = { checkVisibility(): boolean; getAttribute(name: string): string | null; textContent: string | null };
  const visible = await fresh.getByRole('button').evaluateAll((els: unknown[]) =>
    (els as Shown[]).filter((el) => el.checkVisibility()).map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
  );
  // "From" is offered only when the account has aliases to send as.
  expect(visible.filter((n) => n !== 'From').sort()).toEqual([...names].sort());
  await expect(fresh.getByRole('textbox', { name: 'Subject' })).toBeVisible();
  await expect(fresh.getByRole('textbox', { name: 'Message' })).toBeVisible();
  // The body has no visible box: no border, no fill of its own.
  const box = await fresh.locator('.pr-compose__body').evaluate((el) => {
    const s = (globalThis as unknown as { getComputedStyle(e: unknown): { borderTopColor: string; borderLeftColor: string; backgroundColor: string } }).getComputedStyle(el);
    return [s.borderTopColor, s.borderLeftColor, s.backgroundColor];
  });
  expect(box).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  await expectNoAxeViolations(page, 'canvas composer (light)');

  // Send ▾ holds Send later…, which opens the existing Send at row and turns Send into Schedule.
  await fresh.getByRole('button', { name: 'More send options' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Send later…' }).click();
  await expect(fresh.locator('[data-row="send-at"]')).toBeVisible();
  await expect(fresh.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  await fresh.getByRole('button', { name: 'More send options' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Send now instead' }).click();
  await expect(fresh.locator('[data-row="send-at"]')).toHaveCount(0);

  // Minimise folds the composer to its header; Restore brings back what was typed.
  await fresh.getByRole('textbox', { name: 'Subject' }).fill(`Minimised ${t}`);
  await fresh.getByRole('button', { name: 'Minimise', exact: true }).click();
  await expect(fresh.getByRole('textbox', { name: 'Subject' })).toBeHidden();
  await expect(fresh.getByRole('button', { name: 'Restore', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await fresh.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(fresh.getByRole('textbox', { name: 'Subject' })).toHaveValue(`Minimised ${t}`);

  // Open full screen covers the window; Exit full screen puts it back.
  await fresh.getByRole('button', { name: 'Open full screen', exact: true }).click();
  await expect(fresh).toHaveCSS('position', 'fixed');
  await fresh.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect(fresh).not.toHaveCSS('position', 'fixed');

  // Close is Escape's path: the composer closes and what was typed is kept as a draft.
  await fresh.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(fresh).toBeHidden();
  const ids = await mailboxIds();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).toContain(`Minimised ${t}`);

  // The dark theme, with the draft resumed in the composer.
  await context.addInitScript({ content: "window.localStorage.setItem('postroom-theme', 'dark');" });
  const draftsList = (await (await api.get(`/api/mailboxes/${ids['drafts'] ?? ''}/messages?limit=200`)).json()) as { messages: { id: string; subject: string | null }[] };
  const draftId = draftsList.messages.find((m) => m.subject === `Minimised ${t}`)?.id ?? '';
  await page.goto(`/?compose=draft&id=${draftId}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = page.getByRole('region', { name: 'New message' });
  await expect(dark.getByRole('textbox', { name: 'Subject' })).toHaveValue(`Minimised ${t}`);
  await expectNoAxeViolations(page, 'canvas composer (dark)');

  // Tidy up: to Trash.
  await dark.getByRole('button', { name: 'Discard draft' }).click();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).not.toContain(`Minimised ${t}`);
});
