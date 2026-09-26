// PST-T-3.15's exit demo (PST-REQ-079): opening a message with replies shows the whole conversation
// in order, newest expanded; a reply sent from the composer appears in the open thread without a
// reload. PST-T-6.4's exit demo (PST-REQ-119): a deferred outbound recipient shows its reason and
// next retry on the sent message.
//
// A real thread needs a real reply — the e2e-only seed route files independent messages with no
// threadId at all (PST-T-3.10's least-invasive door has no reason to thread). So the fixture seeds
// one root message, then sends two replies for real through POST /api/compose/send (the same path
// compose.spec.ts's Send button uses), which threads them via @postroom/threading and backfills the
// root's threadId too. Sending needs DKIM keys, asked for through the e2e-only
// POST /api/compose/dev/dkim-keys, exactly as compose.spec.ts does. Every message this suite sends
// is cancelled on the outbound queue straight away, so no bounce lands in the shared Inbox.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const CSRF = { 'x-postroom-csrf': '1' };

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const outbound: string[] = [];

test.beforeAll(async ({ playwright }, testInfo) => {
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
  // These specs prove what a send does once it goes. The undo window (PST-T-9.1, default 10 s) is
  // its own spec's subject, so it is off here: a send goes at once, as it did before undo existed.
  await context.addInitScript({ content: "window.localStorage.setItem('postroom.undoSeconds', '0');" });
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page: Page, subject: string) => page.getByRole('option', { name: new RegExp(escape(subject)) });

interface SendResponse {
  messageId: string;
  outboundId: string;
  sentMessageId: string;
  sentMailboxId: string;
  threadId: string | null;
}

/** A reply, sent for real (not through the UI), so a fixture thread exists before the test opens it. */
async function sendReply(input: { to: string; subject: string; text: string; inReplyTo: string; references: string[] }): Promise<SendResponse> {
  const res = await api.post('/api/compose/send', {
    headers: CSRF,
    data: {
      from: 'operator@d3cloud.io',
      to: [input.to],
      cc: [],
      bcc: [],
      subject: input.subject,
      text: input.text,
      inReplyTo: input.inReplyTo,
      references: input.references,
      forwardOf: null,
      draftId: null,
    },
  });
  if (!res.ok()) throw new Error(`compose/send answered ${String(res.status())}: ${await res.text()}`);
  const body = (await res.json()) as SendResponse;
  outbound.push(body.outboundId);
  await cancelOutbound([body.outboundId]);
  return body;
}

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function openFromInbox(page: Page, subject: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  await row(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
}

test('doneWhen: opening a message with replies shows the conversation in order, newest expanded; a reply from the composer joins it without a reload', async ({ page, isMobile }) => {
  // The reply-and-send half of this test drives the composer, which (like compose.spec.ts) only
  // runs in the three-pane desktop layout; the axe-at-390 half of the doneWhen is covered below by
  // "the thread view has no axe violations at every width", which every project runs.
  test.skip(isMobile, 'the composer flows run in the three-pane desktop layout');
  const t = tag();
  const subject = `Roadmap review ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Alice Example <alice@example.org>', text: 'Are we still on for Thursday?' }]);
  if (original === undefined) throw new Error('seed returned nothing');

  const reply1 = await sendReply({
    to: 'alice@example.org',
    subject: `Re: ${subject}`,
    text: `Thursday works ${t}.`,
    inReplyTo: original.messageIdHeader,
    references: [original.messageIdHeader],
  });
  const reply2 = await sendReply({
    to: 'alice@example.org',
    subject: `Re: ${subject}`,
    text: `Actually, could we do Friday instead ${t}?`,
    inReplyTo: original.messageIdHeader,
    references: [original.messageIdHeader],
  });
  expect(reply1.threadId).not.toBeNull();
  expect(reply1.threadId).toBe(reply2.threadId);

  // Opened from Inbox: the pane shows all three, in order, newest expanded. Scoped to direct
  // children: an expanded row's own Delivery section (PST-T-6.4) nests its own <li> recipients.
  await openFromInbox(page, subject);
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation.locator('> li')).toHaveCount(3);
  const items = conversation.locator('> li');
  await expect(items.nth(0)).toHaveAttribute('data-message-id', original.id);
  await expect(items.nth(0)).toHaveAttribute('data-expanded', 'true'); // the message that was opened
  await expect(items.nth(1)).toHaveAttribute('data-expanded', 'false'); // an older reply, collapsed
  await expect(items.nth(2)).toHaveAttribute('data-message-id', reply2.sentMessageId);
  await expect(items.nth(2)).toHaveAttribute('data-expanded', 'true'); // the newest
  await expect(items.nth(2)).toContainText(`Friday instead ${t}`);
  // A collapsed row names its sender and is reachable from the keyboard.
  const collapsedButton = items.nth(1).getByRole('button');
  await expect(collapsedButton).toBeVisible();
  await expect(collapsedButton).toHaveAttribute('aria-expanded', 'false');
  await expectNoAxeViolations(page, 'thread (collapsed)');

  // Expanding a collapsed row by keyboard.
  await collapsedButton.focus();
  await page.keyboard.press('Enter');
  await expect(items.nth(1)).toHaveAttribute('data-expanded', 'true');
  await expect(items.nth(1)).toContainText(`Thursday works ${t}`);

  // r on the open thread replies to the message that was opened (the root); Send closes the composer
  // back to it, and the new reply shows up in the SAME open thread — no navigation, no reload.
  await page.keyboard.press('r');
  const composer = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(composer).toBeVisible();
  await page.keyboard.type(`Friday it is ${t}.`);
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toBeHidden();
  await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();

  const conversationAfter = page.getByRole('list', { name: 'Conversation' });
  await expect(conversationAfter.locator('> li')).toHaveCount(4);
  const newest = conversationAfter.locator('> li').nth(3);
  await expect(newest).toHaveAttribute('data-expanded', 'true');
  await expect(newest).toContainText(`Friday it is ${t}`);
  await remember(`Re: ${subject}`);
});

test('the thread view has no axe violations at every width', async ({ page }) => {
  const t = tag();
  const subject = `Budget approvals ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Alice Example <alice@example.org>', text: 'Ready for a look?' }]);
  if (original === undefined) throw new Error('seed returned nothing');
  const reply = await sendReply({
    to: 'alice@example.org',
    subject: `Re: ${subject}`,
    text: `Looks good ${t}.`,
    inReplyTo: original.messageIdHeader,
    references: [original.messageIdHeader],
  });
  expect(reply.threadId).not.toBeNull();

  await openFromInbox(page, subject);
  await expect(page.getByRole('list', { name: 'Conversation' }).locator('> li')).toHaveCount(2);
  await expectNoAxeViolations(page, 'thread');
});

async function remember(subject: string): Promise<void> {
  const res = await api.get('/api/messages/outbound?limit=100');
  const body = (await res.json()) as { messages: { id: string; subject: string | null }[] };
  const found = body.messages.find((m) => m.subject === subject && !outbound.includes(m.id));
  if (found !== undefined) {
    outbound.push(found.id);
    await cancelOutbound([found.id]);
  }
}

test('doneWhen: a deferred outbound recipient shows its reason and next retry', async ({ page }) => {
  // dev-seed-deferred (PST-T-6.6, apps/api/src/admin-queue) files an OutboundMessage and a deferred
  // OutboundRecipient straight into the queue, with no corresponding Sent-mailbox Message — it was
  // built for e2e/tests/admin-queue.spec.ts, which drives the admin queue screen directly. PST-T-6.7
  // gave the route an optional messageId, so this fixture can pass the opened message's own
  // Message-ID header (bracketed, the way OutboundMessage stores it) and get a REAL link: the
  // reading pane's GET /api/messages/:id/outbound then resolves this seeded row on its own, an
  // indexed lookup, with nothing intercepted.
  const t = tag();
  const subject = `Renewal notice ${t}`;
  const [original] = await seedMail(api, [{ subject, from: 'Vendor <billing@example.org>', text: 'Your plan renews soon.' }]);
  if (original === undefined) throw new Error('seed returned nothing');

  const domain = `example-${t}.test`;
  const seeded = await api.post('/api/admin/queue/dev-seed-deferred', {
    headers: CSRF,
    data: { domain, messageId: `<${original.messageIdHeader}>` },
  });
  if (!seeded.ok()) throw new Error(`dev-seed-deferred answered ${String(seeded.status())}: ${await seeded.text()}`);
  const { messageId: outboundId, recipientId } = (await seeded.json()) as { messageId: string; recipientId: string };
  outbound.push(outboundId);

  await openFromInbox(page, subject);
  const delivery = page.getByRole('region', { name: 'Delivery' });
  await expect(delivery).toBeVisible();
  const recipientRow = delivery.getByTestId('delivery-recipient');
  await expect(recipientRow).toHaveAttribute('data-state', 'deferred');
  await expect(recipientRow.getByTestId('delivery-state')).toHaveText('Deferred');
  await expect(recipientRow.getByTestId('deferral-reason')).toContainText('greylisted (seeded for e2e)');
  await expect(recipientRow.getByTestId('next-retry')).toContainText('Next retry at');
  await expect(recipientRow.getByTestId('next-retry')).toContainText(/in \d+ (min|hr)/);
  await expectNoAxeViolations(page, 'delivery');

  // Clean up: cancel it so it never lingers on the shared queue.
  await api.post(`/api/messages/${outboundId}/recipients/${recipientId}/cancel`, { headers: CSRF });
});
