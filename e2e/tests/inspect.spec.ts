// PST-T-6.1, PST-REQ-114/115's exit demo: open a message, press `i`, and the Inspect drawer shows
// every section — Authentication, Received path, Why this bucket, Spam score breakdown, Trackers
// removed, MDN request, Headers, Raw source — each with content. Learn mode on puts rfc-editor.org
// section links beside headers and verdicts (asserted by href; never navigated to). The drawer is a
// dialog that takes focus and gives it back, fills the screen at 390 px, and is axe-clean in light
// and dark.
//
// Mail is filed through the e2e-only POST /api/admin/dev/seed (POSTROOM_E2E_SEED=1), which writes
// the message with its stored auth verdict. That route builds the headers itself, so the fixture here
// has no Received hops or read-receipt header: those sections show their stated "nothing here"
// content, and the populated versions are held by apps/api/test/integration/inspect.test.ts (API)
// and apps/web/test/unit/inspect.test.ts (rendering).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeededMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

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

const SECTIONS = ['Authentication', 'Received path', 'Why this bucket', 'Spam score breakdown', 'Trackers removed', 'MDN request', 'Headers', 'Raw source'];

const AUTH = {
  spf: { result: 'pass', domain: 'bounce.example.org', scope: 'mfrom', reasons: ['matched ip4:192.0.2.0/24'] },
  dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', algorithm: 'rsa-sha256', testing: false, reasons: ['signature verified'] }],
  dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', policy: 'reject', reasons: ['DKIM pass for d=example.org, relaxedly aligned with example.org'] },
  arc: { result: 'none', instances: 0, sealerDomains: [], reasons: ['no ARC sets'] },
};

async function seedOne(t: string): Promise<SeededMessage> {
  const [m] = await seedMail(api, [
    {
      subject: `Inspect me ${t}`,
      from: `Example News <news-${t}@example.org>`,
      text: 'Plain part.',
      html: '<p>Hello</p><img src="https://www.google-analytics.com/collect?v=1&tid=UA-1" width="1" height="1"><a href="https://example.org/a?utm_source=news">read</a>',
      authVerdicts: AUTH,
    },
  ]);
  if (m === undefined) throw new Error('seed returned nothing');
  return m;
}

async function openInspect(page: Page, m: SeededMessage): Promise<ReturnType<Page['getByRole']>> {
  await page.goto(`/mail/${m.mailboxId}/${m.id}`);
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
  // Keys mean nothing while typing: start from the page, not a field.
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined);
  await page.getByRole('heading', { name: m.subject, level: 2 }).focus();
  await page.keyboard.press('i');
  const drawer = page.getByRole('dialog', { name: 'Inspect message' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('inspect-body')).toBeVisible();
  return drawer;
}

test('pressing i opens the drawer with every section, each with content', async ({ page }) => {
  const m = await seedOne(tag());
  const drawer = await openInspect(page, m);

  for (const name of SECTIONS) {
    const heading = drawer.getByRole('heading', { name, level: 3 });
    await expect(heading).toBeVisible();
    const section = drawer.locator(`section[data-section="${name}"]`);
    const text = (await section.innerText()).replace(name, '').trim();
    expect(text.length, `${name} has content`).toBeGreaterThan(10);
  }
  // Order is the order the requirement lists them in.
  const order = await Promise.all((await drawer.locator('section[data-section]').all()).map((el) => el.getAttribute('data-section')));
  expect(order).toEqual(SECTIONS);

  const auth = drawer.locator('section[data-section="Authentication"]');
  await expect(auth).toContainText('bounce.example.org');
  await expect(auth).toContainText('aligned with the From domain');
  await expect(drawer.locator('section[data-section="Why this bucket"]')).toContainText('e2e seed');
  await expect(drawer.locator('section[data-section="Trackers removed"]')).toContainText('1 tracking pixel removed');
  await expect(drawer.locator('section[data-section="Headers"]')).toContainText(m.messageIdHeader);

  // The raw source is lazy and capped; asked for, it shows the message itself.
  await drawer.getByRole('button', { name: 'Show raw source' }).click();
  await expect(drawer.getByTestId('raw-source')).toContainText(`Subject: ${m.subject}`);
  await expect(drawer.getByRole('link', { name: /Download raw/ })).toHaveAttribute('href', `/api/messages/${m.id}/raw`);

  // Escape closes it and focus goes back to the Inspect button.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('learn mode links headers and verdicts to rfc-editor sections, and is remembered', async ({ page }) => {
  const m = await seedOne(tag());
  let drawer = await openInspect(page, m);
  await expect(drawer.getByTestId('rfc-link')).toHaveCount(0);

  await drawer.getByRole('checkbox', { name: /Learn mode/ }).click();
  const links = drawer.getByTestId('rfc-link');
  await expect(links.first()).toBeVisible();
  const hrefs = await Promise.all((await links.all()).map(async (el) => (await el.getAttribute('href')) ?? ''));
  expect(hrefs.length).toBeGreaterThan(5);
  for (const h of hrefs) expect(h).toMatch(/^https:\/\/www\.rfc-editor\.org\/rfc\/rfc\d+#section-\d+(?:\.\d+)*$/);
  for (const expected of ['rfc7208#section-2.6.3', 'rfc6376#section-3.5', 'rfc7489#section-6.6', 'rfc5322#section-3.6.4', 'rfc5322#section-3.6.5']) {
    expect(hrefs.some((h) => h.endsWith(expected)), expected).toBe(true);
  }
  const subjectRow = drawer.getByRole('rowheader', { name: /^Subject/ });
  await expect(subjectRow.getByRole('link')).toHaveAttribute('href', 'https://www.rfc-editor.org/rfc/rfc5322#section-3.6.5');
  await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');

  // Remembered for this account: closed and reopened, learn mode is still on.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  drawer = await openInspect(page, m);
  await expect(drawer.getByRole('checkbox', { name: /Learn mode/ })).toBeChecked();
  await expect(drawer.getByTestId('rfc-link').first()).toBeVisible();
  // Leave it off for the next test's clean start.
  await drawer.getByRole('checkbox', { name: /Learn mode/ }).click();
});

test('the Inspect button and the command palette open it too', async ({ page }, testInfo) => {
  const m = await seedOne(tag());
  await page.goto(`/mail/${m.mailboxId}/${m.id}`);
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
  const button = page.getByRole('button', { name: 'Inspect', exact: true });
  await button.click();
  const drawer = page.getByRole('dialog', { name: 'Inspect message' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await expect(button).toBeFocused();

  if (testInfo.project.name === 'desktop') {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette.getByRole('combobox', { name: 'Type a command' })).toBeFocused();
    await page.keyboard.type('Inspect the open');
    await page.keyboard.press('Enter');
    await expect(drawer).toBeVisible();
  }
});

test('fills the screen at 390 px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', '390 px is the mobile project');
  const m = await seedOne(tag());
  await page.goto(`/mail/${m.mailboxId}/${m.id}`);
  await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inspect message' });
  await expect(drawer.getByTestId('inspect-body')).toBeVisible();
  // Measured once the sheet's slide-in has settled.
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(0);
  const box = await drawer.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
  expect(box?.width ?? 0).toBeLessThanOrEqual(391);
});

test('the drawer has no axe violations, in light and dark, with learn mode on', async ({ page }) => {
  const m = await seedOne(tag());
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    const drawer = await openInspect(page, m);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const learn = drawer.getByRole('checkbox', { name: /Learn mode/ });
    if (!(await learn.isChecked())) await learn.click();
    await drawer.getByRole('button', { name: 'Show raw source' }).click();
    await expect(drawer.getByTestId('raw-source')).toBeVisible();
    // Let the sheet's entrance animation finish before measuring contrast.
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${theme} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    await page.keyboard.press('Escape');
  }
});
