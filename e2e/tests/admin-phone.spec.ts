// PST-T-17.2 (PST-REQ-155, PST-REQ-194): the four admin list screens — DNS & DKIM, Jobs, Suppressions
// and Sign-in sessions — on a phone, upright (390×844) and on its side (844×390). Each renders its
// list as DataList cards, every row action (Copy, Replay, Remove, Sign out) is on the card and
// inside the viewport, and nothing in <main> overflows sideways. The DNS page, with every seeded
// record shown, is under 4000 px tall (it was ~12,000 px when the table was crushed to 390).
//
// Runs in the phone projects only. Portrait is the 'mobile' project's. Landscape is the 'landscape'
// project's when that project includes this file; until then the 'mobile' project runs the landscape
// suite itself at 844×390, so the assertion is never silently skipped.
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { ensureOperator, signInCookies, tag, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.skip(({ isMobile }) => !isMobile, 'phone layouts: the mobile and landscape projects run this');

const CSRF = { 'x-postroom-csrf': '1' };
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

let api: APIRequestContext;
let other: APIRequestContext;
let operator: Operator;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let otherSessionId = '';
let suppressed = '';

/** Whether the 'landscape' project's testMatch picks up this file (it matched only mobile.spec at first). */
function landscapeProjectRunsThis(testInfo: TestInfo): boolean {
  const project = testInfo.config.projects.find((p) => p.name === 'landscape');
  if (project === undefined) return false;
  const matchers = Array.isArray(project.testMatch) ? project.testMatch : [project.testMatch];
  return matchers.some((m) => (m instanceof RegExp ? m.test(testInfo.file) : testInfo.file.endsWith(m.replace(/^\*\*\//, ''))));
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  const options = baseURL === undefined ? {} : { baseURL };
  api = await playwright.request.newContext(options);
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);

  // Jobs: a dead inbound job, so a row has its Replay.
  const job = await api.post('/api/admin/jobs/dev-seed-failure', { headers: CSRF });
  if (job.status() === 404) throw new Error('the stack has no dev-seed-failure route: start the api with POSTROOM_E2E_SEED=1');
  expect(job.ok()).toBe(true);

  // Suppressions: a hard bounce, so a row has its Remove.
  suppressed = `gone-${tag()}@phone.test`;
  const bounce = await api.post('/api/admin/suppressions/dev-seed-bounce', { headers: CSRF, data: { address: suppressed } });
  expect(bounce.ok()).toBe(true);

  // Sign-in sessions: a second session (its own cookie jar), so a row that is not this browser has Sign out.
  other = await playwright.request.newContext(options);
  await signInCookies(other, operator);
  const own = (await (await other.get('/api/auth/sessions')).json()) as { sessions: { id: string; current: boolean }[] };
  otherSessionId = own.sessions.find((s) => s.current)?.id ?? '';
  expect(otherSessionId).not.toBe('');
});

test.afterAll(async () => {
  await other.dispose();
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

// The e2e project has no DOM lib (see support.ts): browser globals are described structurally.
interface EvalBox {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
}
interface EvalWindow {
  innerWidth: number;
  document: { documentElement: EvalBox; querySelector(selector: string): EvalBox | null };
}

/** Nothing scrolls sideways: not the page, and not <main> (a list may only scroll inside its own box). */
async function assertNoSidewaysOverflow(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const w = globalThis as unknown as EvalWindow;
    const main = w.document.querySelector('main');
    return {
      page: w.document.documentElement.scrollWidth,
      viewport: w.innerWidth,
      main: main === null ? 0 : main.scrollWidth,
      mainBox: main === null ? 0 : main.clientWidth,
    };
  });
  expect(m.page, `${where}: the page is ${String(m.page)}px wide in a ${String(m.viewport)}px viewport`).toBeLessThanOrEqual(m.viewport);
  expect(m.main, `${where}: <main> scrolls ${String(m.main)}px in a ${String(m.mainBox)}px box`).toBeLessThanOrEqual(m.mainBox);
}

/** The control is visible and wholly inside the viewport's width once scrolled to: reachable without a sideways scroll. */
async function assertReachable(page: Page, control: Locator, where: string): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control, where).toBeVisible();
  const box = await control.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box, where).not.toBeNull();
  expect(box?.x ?? -1, `${where}: starts left of the viewport`).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${where}: ends past the viewport's right edge`).toBeLessThanOrEqual(width);
}

/** The tallest scroller on the page: the document, or <main> when the shell scrolls inside it. */
async function pageHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = globalThis as unknown as EvalWindow;
    const main = w.document.querySelector('main');
    return Math.max(w.document.documentElement.scrollHeight, main === null ? 0 : main.scrollHeight);
  });
}

async function checkAllFour(page: Page, geometry: string): Promise<void> {
  await test.step(`DNS & DKIM (${geometry})`, async () => {
    await page.goto('/admin/dns?show=all');
    await expect(page.getByRole('heading', { name: 'DNS & DKIM', level: 1 })).toBeVisible();
    const records = page.getByRole('list', { name: /records for/ });
    await expect(records.first()).toBeVisible({ timeout: 30_000 });
    // Cards, not a table: no row of cells anywhere on the page.
    await expect(page.getByRole('table')).toHaveCount(0);
    await assertReachable(page, page.getByRole('button', { name: 'Re-check' }), 'DNS Re-check');
    await assertReachable(page, page.getByRole('button', { name: /^Copy expected / }).first(), 'DNS Copy on a card');
    await assertNoSidewaysOverflow(page, `/admin/dns (${geometry})`);
    const height = await pageHeight(page);
    expect(height, `/admin/dns with every record shown is ${String(height)}px tall`).toBeLessThan(4000);
  });

  await test.step(`Jobs (${geometry})`, async () => {
    await page.goto('/admin/jobs?status=dead');
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Jobs' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await assertReachable(page, page.getByRole('radiogroup', { name: 'Status' }), 'Jobs status filter');
    await assertReachable(page, page.getByRole('button', { name: /^Replay / }).first(), 'Jobs Replay on a card');
    await assertNoSidewaysOverflow(page, `/admin/jobs (${geometry})`);
  });

  await test.step(`Suppressions (${geometry})`, async () => {
    await page.goto('/admin/suppressions');
    await expect(page.getByRole('heading', { name: 'Suppression list', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search addresses' }).fill(suppressed);
    const list = page.getByRole('list', { name: 'Suppression list' });
    await expect(list.getByText(suppressed)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await assertReachable(page, page.getByRole('button', { name: `Remove ${suppressed}` }), 'Suppressions Remove on a card');
    await assertReachable(page, page.getByRole('button', { name: 'Add address' }), 'Suppressions Add address');
    await assertNoSidewaysOverflow(page, `/admin/suppressions (${geometry})`);
  });

  await test.step(`Sign-in sessions (${geometry})`, async () => {
    await page.goto('/admin/sessions');
    await expect(page.getByRole('heading', { name: 'Sign-in sessions', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Live sessions' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await assertReachable(page, page.locator(`button[data-session-id="${otherSessionId}"]`), 'Sessions Sign out on a card');
    await assertNoSidewaysOverflow(page, `/admin/sessions (${geometry})`);
  });
}

test.describe('Admin lists on a phone, upright (390×844)', () => {
  test.use({ viewport: PORTRAIT });

  test('DNS, Jobs, Suppressions and Sign-in sessions are cards with every action reachable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'portrait geometry: the mobile project runs it');
    await checkAllFour(page, '390×844');
  });
});

test.describe('Admin lists on a phone, on its side (844×390)', () => {
  test.use({ viewport: LANDSCAPE });

  test('DNS, Jobs, Suppressions and Sign-in sessions stay cards with every action reachable', async ({ page }, testInfo) => {
    const mine = testInfo.project.name === 'landscape' || (testInfo.project.name === 'mobile' && !landscapeProjectRunsThis(testInfo));
    test.skip(!mine, 'the landscape project runs it');
    await checkAllFour(page, '844×390');
  });
});
