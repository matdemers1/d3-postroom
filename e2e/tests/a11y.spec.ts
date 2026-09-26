// PST-T-11.1 (PST-P-11): the webmail and admin area meet WCAG 2.2 AA, and every screen has a
// designed empty, loading, error and denied state.
//
// Every route in apps/web/src/App.tsx is visited in the light and the dark theme, and AxeBuilder
// with the WCAG 2.0/2.1/2.2 A and AA tags reports zero violations on each, in each state:
//
//   - seeded: realistic data filed through the e2e-only seed routes and the public API;
//   - empty: the screen's own data call answers with its collections emptied (route interception
//     over the real response, so every other field is the server's own);
//   - loading → loading-complete: the data call is held; while it is held the screen shows a
//     skeleton or spinner inside a container with an accessible name (never a blank area), and
//     once released the settled screen is axe-clean;
//   - error: the data call answers 500 — the screen shows a designed error state, never a raw
//     code, a stack or a blank area;
//   - denied: a non-admin session opening /admin/* (the Gate's /api/auth/state answers with
//     isAdmin false and every /api/admin call 403s, which is exactly what the server does for a
//     non-admin — Postroom has no way to create a second human account without D3 Auth); an
//     admin role withdrawn while the page is open (the admin calls answer 403); and an expired
//     session (the cookie cleared mid-page, then a screen's fetch answers 401 from the real server).
//
// docs/qa/screen-inventory.md is the table of screen × state this spec proves.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Route } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type Operator } from './support.js';

test.describe.configure({ mode: 'default', timeout: 600_000 });

const CSRF = { 'x-postroom-csrf': '1' };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

type Json = Record<string, unknown>;

interface Screen {
  /** The row in docs/qa/screen-inventory.md. */
  name: string;
  path: () => string;
  /** Resolves once the screen's own chrome is on the page (not necessarily its data). */
  ready: (page: Page) => Promise<void>;
  /** The screen's own data call — what the empty, loading and error states intercept. */
  data?: RegExp;
  /** Turns the real response into the empty one. Default: every top-level array becomes []. */
  empty?: ((body: Json) => Json) | false;
  /** Only an admin may open it. */
  admin?: boolean;
  /** What the designed empty state is, when it is not an EmptyState. */
  emptyShows?: (page: Page) => ReturnType<Page['locator']>;
  /** Below the mail view's split width (768 px) the screen is a different view with other data. */
  narrow?: { data?: RegExp; empty?: ((body: Json) => Json) | false; session?: false };
}

/** The screen as it is at this viewport: below 768 px, its `narrow` overrides apply. */
function atWidth(screen: Screen, page: Page): Screen {
  const width = page.viewportSize()?.width ?? 1280;
  if (width >= 768 || screen.narrow === undefined) return screen;
  const { narrow, ...rest } = screen;
  return { ...rest, ...(narrow.data === undefined ? {} : { data: narrow.data }), ...(narrow.empty === undefined ? {} : { empty: narrow.empty }) };
}

/** Whether moving to the screen in-app makes a fetch at all (the session-ended case needs one). */
function fetchesOnArrival(screen: Screen, page: Page): boolean {
  const width = page.viewportSize()?.width ?? 1280;
  return !(width < 768 && screen.narrow?.session === false);
}

const h1 = (name: string | RegExp) => async (page: Page) => {
  await expect(page.getByRole('heading', { name, level: 1 })).toBeAttached();
};

const emptyArrays = (body: Json): Json => {
  const out: Json = {};
  for (const [k, v] of Object.entries(body)) out[k] = Array.isArray(v) ? [] : v;
  return out;
};

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let operator: Operator;

const seeded = {
  inbox: '',
  message: '',
  newsletters: '',
  sender: '',
  addressBook: '',
  card: '',
};

const SCREENS: Screen[] = [
  {
    name: 'Mail — inbox',
    path: () => '/',
    ready: h1('Mail'),
    data: /\/api\/mailboxes\/[^/]+\/messages(\?|$)/,
  },
  {
    name: 'Mail — mailbox list (/mail)',
    path: () => '/mail',
    ready: h1('Mail'),
    data: /\/api\/mailboxes\/[^/]+\/messages(\?|$)/,
    // Below 768 px /mail is the list of mailboxes itself (push navigation's first level), drawn from
    // the mailboxes the shell already holds: moving to it in-app fetches nothing.
    narrow: { data: /\/api\/mailboxes(\?|$)/, session: false },
  },
  {
    name: 'Mail — open message',
    path: () => `/mail/${seeded.inbox}/${seeded.message}`,
    ready: h1('Mail'),
    data: /\/api\/messages\/[0-9a-f-]{36}$/,
    empty: false,
  },
  {
    name: 'Mail — composer',
    path: () => '/?compose=new',
    ready: async (page) => {
      await expect(page.getByRole('region', { name: 'New message' })).toBeVisible();
    },
  },
  {
    name: 'Mail — Newsletters feed',
    path: () => `/mail/${seeded.newsletters}`,
    ready: h1('Mail'),
    data: /\/api\/mailboxes\/[^/]+\/messages(\?|$)/,
  },
  {
    name: 'Calendar',
    path: () => '/calendar',
    ready: h1('Calendar'),
    data: /\/api\/calendar\/events(\?|$)/,
    // An empty month is still the month: every day cell present and labelled "0 events" (the
    // agenda view at phone width shows "Nothing scheduled" instead).
    emptyShows: (page) => page.locator('main :is(.d3-es, table.pr-cal-month td[aria-label$=", 0 events"])'),
  },
  {
    name: 'Contacts',
    path: () => '/contacts',
    ready: h1('Contacts'),
    data: /\/api\/contacts(\?|$)/,
  },
  {
    name: 'Contacts — new contact',
    path: () => '/contacts/new',
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    },
  },
  {
    name: 'Contacts — one contact',
    path: () => `/contacts/${seeded.addressBook}/${encodeURIComponent(seeded.card)}`,
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    },
    data: /\/api\/contacts\/address-books\/[^/]+\/cards\/[^/?]+$/,
    empty: false,
  },
  {
    name: 'Sender profile',
    path: () => `/senders/${encodeURIComponent(seeded.sender)}`,
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    },
    data: /\/api\/senders\/[^/]+\/profile(\?|$)/,
  },
  { name: 'App passwords', path: () => '/app-passwords', ready: h1('App passwords'), data: /\/api\/app-passwords(\?|$)/ },
  { name: 'Masked aliases', path: () => '/account/aliases', ready: h1('Masked aliases'), data: /\/api\/aliases(\?|$)/ },
  { name: 'Change password', path: () => '/account/password', ready: h1('Change password') },
  { name: 'Devices (own sessions)', path: () => '/account/sessions', ready: h1('Devices'), data: /\/api\/auth\/sessions(\?|$)/ },
  {
    name: 'Import mail',
    path: () => '/account/import',
    ready: h1('Import mail'),
    data: /\/api\/import(\?|$)/,
    empty: (body) => ({ ...body, import: null }),
  },
  { name: 'Set up iPhone / Mac', path: () => '/account/device-setup', ready: h1('Set up iPhone / Mac') },
  { name: 'Rules', path: () => '/account/rules', ready: h1('Rules'), data: /\/api\/sieve\/scripts(\?|$)/ },
  { name: 'Compose templates', path: () => '/account/templates', ready: h1('Compose templates'), data: /\/api\/templates(\?|$)/ },
  { name: 'Admin — Sessions', path: () => '/admin/sessions', ready: h1('Sessions'), data: /\/api\/admin\/sessions(\?|$)/, admin: true },
  { name: 'Admin — Health', path: () => '/admin/health', ready: h1('Health'), data: /\/api\/admin\/health(\?|$)/, admin: true },
  { name: 'Admin — Jobs', path: () => '/admin/jobs', ready: h1('Jobs'), data: /\/api\/admin\/jobs(\?|$)/, admin: true },
  { name: 'Admin — Outbound queue', path: () => '/admin/queue', ready: h1('Outbound queue'), data: /\/api\/admin\/queue(\?|$)/, admin: true },
  {
    name: 'Admin — Deliverability',
    path: () => '/admin/deliverability',
    ready: h1('Deliverability'),
    data: /\/api\/admin\/deliverability(\?|$)/,
    empty: emptyDeep,
    admin: true,
  },
  { name: 'Admin — SMTP sessions', path: () => '/admin/smtp', ready: h1('SMTP sessions'), data: /\/api\/admin\/smtp\/transcripts(\?|$)/, admin: true },
];

/** Every array anywhere in the body becomes [], and every count 0 — Deliverability's shape nests. */
function emptyDeep(body: Json): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return [];
    if (typeof v === 'number') return 0;
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(body) as Json;
}

// --- helpers -----------------------------------------------------------------------------------

const SENDER_FRAME = 'iframe[data-testid="message-html"]';
const LOADERS = 'main .d3-skl, main .d3-skl__lines, main .d3-spn';

async function useTheme(context: BrowserContext, theme: Theme): Promise<void> {
  await context.addInitScript((t) => {
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('postroom-theme', t);
  }, theme);
}

/** Zero violations, as a soft assertion so one run reports every screen × state at once. */
async function axe(page: Page, theme: Theme, label: string): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // A message's own HTML renders in a sandboxed frame on the usercontent origin with scripts off
  // (PST-T-3.12): axe cannot run inside it, and its markup is the sender's, not Postroom's. The frame
  // element itself still needs a name, which is asserted here instead.
  for (const frame of await page.locator(SENDER_FRAME).all()) {
    expect.soft(await frame.getAttribute('title'), `${label}: a message frame has no title`).toBeTruthy();
  }
  const results = await new AxeBuilder({ page }).withTags(WCAG).exclude(SENDER_FRAME).analyze();
  const found = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')} — ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 240)}`),
  }));
  expect.soft(found, `${label} [${theme}]: axe violations`).toEqual([]);
}

/**
 * No skeleton or spinner left in view, and nothing marked busy. Only what is on screen counts: the
 * Newsletters feed loads each issue's body when it scrolls near the viewport, so an issue far below
 * the fold keeps its placeholder by design.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((selector) => {
          const w = globalThis as unknown as {
            innerHeight: number;
            document: { querySelectorAll(s: string): { getBoundingClientRect(): { top: number; bottom: number; height: number } }[] };
          };
          return [...w.document.querySelectorAll(selector)].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.bottom > 0 && r.top < w.innerHeight;
          }).length;
        }, LOADERS),
      { timeout: 15_000, message: 'a skeleton or spinner is still in view' },
    )
    .toBe(0);
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

/** The page is not a blank area: main holds visible text. */
async function notBlank(page: Page, label: string): Promise<void> {
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim();
  expect.soft(text.length, `${label}: main is blank`).toBeGreaterThan(0);
}

/** The data call answers with the real response, transformed. */
async function fulfilEmpty(route: Route, transform: (b: Json) => Json): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as Json;
  await route.fulfill({ response, json: transform(body) });
}

const RAW = /internal_error|http_500|http_401|http_403|Internal Server Error|unauthenticated|forbidden|\bundefined\b|\[object Object\]/;

async function noRawError(page: Page, label: string): Promise<void> {
  const text = await page.locator('body').innerText();
  expect.soft(text, `${label}: a raw error reached the screen`).not.toMatch(RAW);
}

// --- setup -------------------------------------------------------------------------------------

test.beforeAll(async ({ playwright }, testInfo) => {
  // Signing in may wait out a TOTP step, and the worker's report sweep is on its own clock.
  test.setTimeout(180_000);
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  await seed();
});

test.afterAll(async () => {
  await api.dispose();
});

async function seed(): Promise<void> {
  const t = tag();
  seeded.sender = `digest-${t}@example.test`;
  const [msg] = await seedMail(api, [
    {
      subject: `Quarterly numbers ${t}`,
      from: `Rosa Park <rosa.${t}@example.org>`,
      text: 'Hi — the quarterly numbers are attached, with a short summary below.\n\nRevenue is up 4%.',
      attachment: { filename: 'numbers.csv', contentType: 'text/csv', content: 'quarter,revenue\nQ3,104\n' },
      authVerdicts: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
    { subject: `Lunch on Friday? ${t}`, from: `Sam Lee <sam.${t}@example.org>`, text: 'Are you free?', flags: ['\\Seen'] },
    { subject: `Your receipt ${t}`, from: `Shop <billing.${t}@shop.example>`, text: 'Thanks for your order.', flags: ['\\Flagged'] },
  ]);
  if (msg === undefined) throw new Error('seed returned nothing');
  seeded.inbox = msg.mailboxId;
  seeded.message = msg.id;

  const feed = await seedMail(api, [
    { subject: `Weekly Digest ${t}`, from: `Digest <${seeded.sender}>`, text: `Issue one of ${t}.` },
    { subject: `Product Update ${t}`, from: `Digest <${seeded.sender}>`, text: `Issue two of ${t}.` },
  ]);
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; name: string }[] };
  const newsletters = mailboxes.find((m) => m.name === 'Newsletters');
  if (newsletters === undefined) throw new Error('no Newsletters mailbox');
  seeded.newsletters = newsletters.id;
  for (const m of feed) {
    const detail = (await (await api.get(`/api/messages/${m.id}`)).json()) as { modseq: string };
    await api.patch(`/api/messages/${m.id}`, { headers: { ...CSRF, 'if-match': `"${detail.modseq}"` }, data: { mailboxId: newsletters.id } });
  }

  const cals = (await (await api.get('/api/calendar/calendars')).json()) as { calendars: { id: string; canHoldEvents: boolean }[] };
  const calendarId = cals.calendars.find((c) => c.canHoldEvents)?.id;
  if (calendarId !== undefined) {
    const today = new Date().toISOString().slice(0, 10);
    await api.post(`/api/calendar/calendars/${calendarId}/events`, {
      headers: CSRF,
      data: { summary: `Planning review ${t}`, start: `${today}T09:00`, end: `${today}T10:00`, timezone: 'UTC' },
    });
  }

  const books = (await (await api.get('/api/contacts/address-books')).json()) as { addressBooks: { id: string }[] };
  const book = books.addressBooks[0];
  if (book === undefined) throw new Error('no address book');
  const card = await api.post(`/api/contacts/address-books/${book.id}/cards`, {
    headers: CSRF,
    data: {
      fn: `Ada Lovelace ${t}`,
      given: 'Ada',
      family: `Lovelace ${t}`,
      emails: [{ address: `ada.${t}@example.org`, type: 'work' }],
      tels: [{ value: '+1 555 0100', type: 'cell' }],
      org: 'Analytical Engines',
      note: 'Met at the conference.',
    },
  });
  if (!card.ok()) throw new Error(`contact create answered ${String(card.status())}`);
  const saved = (await card.json()) as { addressBookId: string; name: string };
  seeded.addressBook = saved.addressBookId;
  seeded.card = saved.name;

  await api.post('/api/app-passwords', { headers: CSRF, data: { label: `Phone Mail ${t}`, scopes: ['imap', 'smtp'] } });
  await api.post('/api/aliases', { headers: CSRF, data: { site: `shop-${t}.example` } });
  await api.post('/api/templates', { headers: CSRF, data: { shortcut: `ty${t}`, name: `Thank you ${t}`, body: 'Thanks for reaching out.' } });
  await api.post('/api/admin/jobs/dev-seed-failure', { headers: CSRF });
  await api.post('/api/admin/queue/dev-seed-deferred', { headers: CSRF, data: { domain: `a11y-${t}.test` } });

  // DMARC and TLS-RPT reports, filed as delivered mail exactly as deliverability.spec.ts does; the
  // worker's report sweep turns them into the rows Deliverability charts. Re-filing the same
  // reports is recognised as a duplicate, so a second project's run adds nothing.
  const reports = await api.post('/api/admin/deliverability/dev/seed', {
    headers: CSRF,
    data: {
      messages: [
        { from: 'noreply-dmarc-support@google.com', subject: 'Report domain: d3cloud.io Submitter: google.com Report-ID: 4817259360124789153', attachments: [fixture('.zip', 'application/zip')] },
        { from: 'noreply-smtp-tls-reporting@google.com', subject: 'Report Domain: d3cloud.io Submitter: google.com Report-ID: <2026.09.24T00.00.00Z+d3cloud.io@google.com>', attachments: [fixture('.json.gz', 'application/tlsrpt+gzip')] },
      ],
    },
  });
  if (!reports.ok()) throw new Error(`deliverability seed answered ${String(reports.status())}`);
  await expect
    .poll(
      async () => {
        const body = (await (await api.get('/api/admin/deliverability?days=3650')).json()) as { dmarc: { totals: { reports: number } } };
        return body.dmarc.totals.reports > 0;
      },
      { timeout: 60_000, message: 'the reports never appeared — is the worker running against this stack?' },
    )
    .toBe(true);
}

const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'reports', 'test', 'fixtures');
function fixture(suffix: string, contentType: string): { filename: string; contentType: string; contentBase64: string } {
  const filename = readdirSync(fixtures).find((f) => f.endsWith(suffix));
  if (filename === undefined) throw new Error(`no fixture ending ${suffix}`);
  return { filename, contentType, contentBase64: readFileSync(join(fixtures, filename)).toString('base64') };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

// --- seeded ------------------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`every route, seeded, is axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    for (const screen of SCREENS) {
      await page.goto(screen.path());
      await screen.ready(page);
      await settled(page);
      await notBlank(page, screen.name);
      await axe(page, theme, `${screen.name} (seeded)`);
    }
  });
}

// --- empty ---------------------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`every data screen has a designed empty state, axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    for (const screen of SCREENS.map((s) => atWidth(s, page))) {
      if (screen.data === undefined || screen.empty === false) continue;
      const transform = screen.empty ?? emptyArrays;
      await page.route(screen.data, (route) => fulfilEmpty(route, transform));
      await page.goto(screen.path());
      await screen.ready(page);
      await settled(page);
      const shown = screen.emptyShows?.(page) ?? page.locator('main .d3-es');
      await expect.soft(shown.first(), `${screen.name}: no designed empty state`).toBeVisible();
      await notBlank(page, `${screen.name} (empty)`);
      await axe(page, theme, `${screen.name} (empty)`);
      await page.unroute(screen.data);
    }
  });
}

// --- loading → loading-complete ------------------------------------------------------------------

for (const theme of THEMES) {
  test(`every data screen shows a named loading state, then settles axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    for (const screen of SCREENS.map((s) => atWidth(s, page))) {
      if (screen.data === undefined) continue;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(screen.data, async (route) => {
        await held;
        await route.fallback();
      });
      await page.goto(screen.path());
      await screen.ready(page);
      // Held: a skeleton or spinner is visible, inside something with an accessible name that says
      // it is busy (Skeleton itself is aria-hidden by design — its container carries the meaning).
      await expect.soft(page.locator(LOADERS).first(), `${screen.name}: nothing visible while loading`).toBeVisible();
      await expect
        .soft(page.locator('main :is([aria-busy="true"], [role="status"], [role="progressbar"])[aria-label]').first(), `${screen.name}: the loading state has no accessible name`)
        .toBeAttached();
      release();
      await settled(page);
      await notBlank(page, `${screen.name} (loaded)`);
      await axe(page, theme, `${screen.name} (loading-complete)`);
      await page.unroute(screen.data);
    }
  });
}

// --- error -------------------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`every data screen has a designed error state for a 500, axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    for (const screen of SCREENS.map((s) => atWidth(s, page))) {
      if (screen.data === undefined) continue;
      await page.route(screen.data, (route) => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
      await page.goto(screen.path());
      await screen.ready(page);
      await settled(page);
      await expect
        .soft(page.locator('main :is(.d3-es[data-kind="error"], [role="alert"])').first(), `${screen.name}: no designed error state`)
        .toBeVisible();
      await noRawError(page, screen.name);
      await axe(page, theme, `${screen.name} (error)`);
      await page.unroute(screen.data);
    }
  });
}

// --- denied ------------------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`a non-admin opening /admin/* sees a designed no-access state, axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    await page.route(/\/api\/auth\/state(\?|$)/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { account?: Json };
      await route.fulfill({ response, json: { ...body, account: { ...body.account, isAdmin: false } } });
    });
    await page.route(/\/api\/admin\//, (route) => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
    for (const screen of SCREENS.filter((s) => s.admin === true)) {
      await page.goto(screen.path());
      await expect.soft(page.locator('main .d3-es[data-kind="no-access"]'), `${screen.name}: no designed no-access state`).toBeVisible();
      await expect.soft(page.getByRole('navigation').getByRole('link', { name: 'Health' }), 'admin links are hidden from a non-admin').toHaveCount(0);
      await noRawError(page, `${screen.name} (denied)`);
      await axe(page, theme, `${screen.name} (denied: not an admin)`);
    }
  });

  test(`an admin role withdrawn mid-session: every /admin/* screen says so, axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    // The page still believes it is an admin (its auth state was fetched before), but the server
    // now refuses: each admin screen's own call answers 403.
    await page.route(/\/api\/admin\//, (route) => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
    for (const screen of SCREENS.filter((s) => s.admin === true)) {
      await page.goto(screen.path());
      await screen.ready(page);
      await expect
        .soft(page.locator('main .d3-es[data-kind="no-access"]').filter({ hasText: 'You do not have access to this' }).first(), `${screen.name}: no designed no-access state for a 403`)
        .toBeVisible();
      await noRawError(page, `${screen.name} (403)`);
      await axe(page, theme, `${screen.name} (denied: 403 from the server)`);
    }
  });

  test(`an expired session shows a designed signed-out state, axe-clean — ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    for (const screen of SCREENS.filter((s) => fetchesOnArrival(s, page)).map((s) => atWidth(s, page))) {
      if (screen.data === undefined) continue;
      await context.addCookies(cookies);
      // Start on a screen that loads nothing, signed in, then end the session while the page is
      // open: the cookie goes, and moving to the next screen (client-side, no reload) makes its
      // fetch — which the real server answers 401.
      await page.goto('/account/password');
      await expect(page.getByRole('heading', { name: 'Change password', level: 1 })).toBeVisible();
      await context.clearCookies();
      await navigateInApp(page, screen.path());
      await screen.ready(page);
      await expect
        .soft(page.locator('main .d3-es[data-kind="no-access"]').filter({ hasText: 'Your session has ended' }).first(), `${screen.name}: no designed session-ended state`)
        .toBeVisible();
      await expect.soft(page.getByRole('link', { name: 'Sign in again' }).first(), `${screen.name}: no way back in`).toBeVisible();
      await noRawError(page, `${screen.name} (session ended)`);
      await axe(page, theme, `${screen.name} (denied: session ended)`);
    }
  });
}

/** A client-side navigation, as a link click in the app makes it: no reload, no new Gate check. */
async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    const w = globalThis as unknown as {
      history: { pushState(s: unknown, t: string, u: string): void };
      dispatchEvent(e: unknown): void;
      PopStateEvent: new (t: string) => unknown;
    };
    w.history.pushState({}, '', to);
    w.dispatchEvent(new w.PopStateEvent('popstate'));
  }, path);
}

// --- before a session: Setup and Sign in -----------------------------------------------------------

for (const theme of THEMES) {
  test(`Setup and Sign in are axe-clean, with a designed error — ${theme}`, async ({ browser }) => {
    const context = await browser.newContext();
    await useTheme(context, theme);
    const page = await context.newPage();

    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Sign in to Postroom' })).toBeVisible();
    await axe(page, theme, 'Sign in');
    await page.getByRole('textbox', { name: 'Login' }).fill(operator.login);
    await page.getByLabel('Password', { exact: true }).fill('not the password at all');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await noRawError(page, 'Sign in (wrong password)');
    await axe(page, theme, 'Sign in (wrong password)');

    // /setup renders only while the server says setup is required; this stack is set up, so the
    // Gate is told otherwise — the screen itself is the real one.
    await page.route(/\/api\/auth\/state(\?|$)/, (route) =>
      route.fulfill({ json: { setupRequired: true, oidcConfigured: false, oidcAvailable: false, signedIn: false } }),
    );
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'Set up Postroom' })).toBeVisible();
    await axe(page, theme, 'Setup');

    // The server not answering at all: the Gate's own designed state.
    await page.unroute(/\/api\/auth\/state(\?|$)/);
    await page.route(/\/api\/auth\/state(\?|$)/, (route) => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.goto('/');
    await expect(page.getByText('Could not reach the server')).toBeVisible();
    await noRawError(page, 'Gate (server down)');
    await axe(page, theme, 'Gate (server down)');
    await context.close();
  });
}
