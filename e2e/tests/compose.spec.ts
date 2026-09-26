// PST-T-3.11's exit demo, as a suite (PST-REQ-079): open a message, r, type, Send — the reply is in
// the conversation and in Sent without a reload; a draft saved and closed comes back with its text
// when the reply is reopened; a forward carries the original.
//
// Sending needs DKIM keys (submission never sends unsigned), and the e2e stack has no operator step
// that makes them, so the suite asks for them through the e2e-only POST /api/compose/dev/dkim-keys
// (mounted only with POSTROOM_E2E_SEED=1, like the seed route). Every message this suite sends is
// cancelled on the outbound queue straight away, and the suite waits for the queue to settle, so no
// bounce lands in the shared Inbox while the other specs run.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

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
  await context.addCookies(cookies);
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

test('doneWhen: r, type, Send — the reply is in the thread and in Sent, without a reload', async ({ page }) => {
  const t = tag();
  const subject = `Lunch on Friday ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Alice Example <alice@example.org>', text: 'Are you free for lunch?' }]);
  if (original === undefined) throw new Error('seed returned nothing');
  await openFromInbox(page, subject);

  await page.keyboard.press('r');
  const reply = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(reply).toBeVisible();
  await expect(reply.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await page.keyboard.type(`Friday works for me ${t}.`);
  await expectNoAxeViolations(page, 'composer');
  await reply.getByRole('button', { name: 'Send' }).click();

  // The receipt: the conversation as the server now has it — the original, then the reply.
  const receipt = page.getByRole('region', { name: 'Message sent' });
  await expect(receipt).toBeVisible();
  const conversation = receipt.getByRole('list', { name: 'Conversation' });
  await expect(conversation.getByRole('listitem')).toHaveCount(2);
  await expect(conversation.getByRole('listitem').first()).toContainText(subject);
  await expect(conversation.getByRole('listitem').last()).toContainText(`You · Re: ${subject}`);
  await remember(`Re: ${subject}`);
  await expectNoAxeViolations(page, 'receipt');

  // The thread, from the API: the seeded original and the Sent copy.
  const threadId = await receipt.getAttribute('data-thread-id');
  expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  const thread = (await (await api.get(`/api/threads/${threadId ?? ''}`)).json()) as { messages: { id: string; subject: string }[] };
  expect(thread.messages.map((m) => m.subject)).toEqual([subject, `Re: ${subject}`]);
  expect(thread.messages[0]?.id).toBe(original.id);

  // In Sent, without a reload: the link opens it there, in the list and in the reading pane.
  await receipt.getByRole('link', { name: 'Open in Sent' }).click();
  await expect(page.getByRole('listbox', { name: 'Messages in Sent' })).toBeVisible();
  await expect(row(page, `Re: ${subject}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: `Re: ${subject}`, level: 2 })).toBeVisible();
  await expect(page.getByTestId('message-text')).toContainText(`Friday works for me ${t}.`);
  const ids = await mailboxIds();
  expect(await subjectsIn(ids['sent'] ?? '')).toContain(`Re: ${subject}`);
});

test('a draft saved and closed comes back with its text; Discard throws it away', async ({ page }) => {
  const t = tag();
  const subject = `Budget review ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Carol <carol@example.org>', text: 'Numbers inside.' }]);
  if (original === undefined) throw new Error('seed returned nothing');
  await openFromInbox(page, subject);

  await page.keyboard.press('r');
  const reply = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(reply).toBeVisible();
  await page.keyboard.type(`Half-written thoughts ${t}`);
  await reply.getByRole('button', { name: 'Save draft' }).click();
  await expect(reply.getByRole('status')).toContainText('Draft saved');

  const ids = await mailboxIds();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).toContain(`Re: ${subject}`);

  // Close it (Escape keeps the draft), then reopen the reply: the text is back.
  await page.keyboard.press('Escape');
  await expect(reply).toBeHidden();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
  await page.keyboard.press('r');
  const again = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(again.getByRole('textbox', { name: 'Message' })).toHaveValue(new RegExp(`^Half-written thoughts ${t}`));
  await expect(again.getByRole('status')).toContainText('Picked up your saved draft.');

  // Discard removes it from Drafts.
  await again.getByRole('button', { name: 'Discard' }).click();
  await expect(again).toBeHidden();
  await expect.poll(() => subjectsIn(ids['drafts'] ?? '')).not.toContain(`Re: ${subject}`);
});

test('a forward carries the original, attached whole', async ({ page }) => {
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
  await expect(forward.getByText('The original message is attached in full.')).toBeVisible();
  await forward.getByRole('textbox', { name: 'To' }).fill('Erin <erin@example.org>');
  await forward.getByRole('button', { name: 'Send' }).click();
  const receipt = page.getByRole('region', { name: 'Message sent' });
  await expect(receipt).toBeVisible();
  await remember(`Fwd: ${subject}`);

  await receipt.getByRole('link', { name: 'Open in Sent' }).click();
  await expect(page.getByRole('heading', { name: `Fwd: ${subject}`, level: 2 })).toBeVisible();
  const sentId = /\/mail\/[0-9a-f-]{36}\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const raw = await (await api.get(`/api/messages/${sentId}/raw`)).text();
  expect(raw).toContain('Content-Type: message/rfc822');
  expect(raw).toContain(`Message-ID: ${original.messageIdHeader}`);
  expect(raw).toContain('filename="notes.txt"');
});
