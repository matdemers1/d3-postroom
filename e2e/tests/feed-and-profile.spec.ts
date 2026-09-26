// PST-T-5.6's exit demo: the Newsletters feed scrolls three seeded newsletters (PST-REQ-109), Mark
// all read clears them, and the sender profile renders for a fixture sender (PST-REQ-113).
//
// Mail is filed through the e2e-only POST /api/admin/dev/seed (POSTROOM_E2E_SEED=1) and then moved
// into Newsletters with the same PATCH the reading pane's own "move" action uses — the seed route
// has no `mailbox: 'newsletters'` option or a way to set arbitrary headers, so it cannot hand a
// message a `List-Unsubscribe`/`List-Unsubscribe-Post` pair. The one-click POST itself (RFC 8058,
// PST-REQ-110) — a message whose DMARC passed, the exact body reaching a local listener, and the
// refusal when DMARC did not pass — is proven at the API layer instead, against a real database and
// blob store: apps/api/test/integration/unsubscribe-and-profile.test.ts. This spec still exercises
// the button's UI path end to end (offered: false for a message with no one-click headers).
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeededMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  cookies = await signInCookies(api, await ensureOperator(api));
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

async function mailboxByName(name: string): Promise<{ id: string; unseen: number }> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; name: string; unseen: number }[] };
  const found = mailboxes.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no ${name} mailbox`);
  return found;
}

/** Moves a seeded (Inbox) message into `mailboxId`, exactly what a drag or the "move" action does. */
async function moveTo(message: SeededMessage, mailboxId: string): Promise<void> {
  const detail = await (await api.get(`/api/messages/${message.id}`)).json() as { modseq: string };
  const res = await api.patch(`/api/messages/${message.id}`, {
    headers: { 'x-postroom-csrf': '1', 'if-match': `"${detail.modseq}"` },
    data: { mailboxId },
  });
  if (!res.ok()) throw new Error(`move answered ${String(res.status())}`);
}

test('the Newsletters feed scrolls three newsletters, marks them all read, and the sender profile renders', async ({ page }) => {
  const t = tag();
  const from = `feed-${t}@example.test`;
  const seeded = await seedMail(api, [
    { subject: `Weekly Digest ${t}`, from: `Digest <${from}>`, text: `Issue one of ${t}.` },
    { subject: `Product Update ${t}`, from: `Digest <${from}>`, text: `Issue two of ${t}.` },
    { subject: `Community Notes ${t}`, from: `Digest <${from}>`, text: `Issue three of ${t}.` },
  ]);
  expect(seeded).toHaveLength(3);

  const newsletters = await mailboxByName('Newsletters');
  for (const m of seeded) await moveTo(m, newsletters.id);

  // Straight to the feed: the sidebar is a drawer at phone width, and the feed is the route.
  await page.goto(`/mail/${newsletters.id}`);

  const feed = page.getByTestId('feed');
  await expect(feed).toBeVisible();
  // Other specs file newsletters into the same shared account, so count this test's own three.
  const items = page.getByTestId('feed-item').filter({ hasText: t });
  await expect(items).toHaveCount(3);

  // Scrolling reveals each item's body frame, lazily.
  for (const subject of [`Weekly Digest ${t}`, `Product Update ${t}`, `Community Notes ${t}`]) {
    const item = page.getByTestId('feed-item').filter({ hasText: subject });
    await item.scrollIntoViewIfNeeded();
    await expect(item.getByTestId('message-html')).toBeVisible({ timeout: 15_000 });
  }

  // None of these carry RFC 8058 headers (the seed route cannot set them) — the button says so.
  const firstItem = items.first();
  await firstItem.getByTestId('unsubscribe-button').click();
  await expect(firstItem.getByTestId('unsubscribe-not-offered')).toBeVisible();

  // Mark all read.
  expect((await mailboxByName('Newsletters')).unseen).toBeGreaterThan(0);
  await page.getByTestId('mark-all-read').click();
  await expect(page.getByTestId('mark-all-read')).toBeDisabled();
  await expect.poll(async () => (await mailboxByName('Newsletters')).unseen).toBe(0);

  // The sender profile, linked from a feed item's From line, for this fixture sender.
  await page.getByRole('link', { name: from }).first().click();
  await expect(page).toHaveURL(new RegExp(`/senders/${encodeURIComponent(from)}`));
  await expect(page.getByRole('heading', { name: from })).toBeVisible();
  await expect(page.getByText('3', { exact: true })).toBeVisible();
  await expect(page.getByText('Never attempted')).toBeVisible();
});
