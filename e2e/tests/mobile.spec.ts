// PST-T-11.2 / PST-REQ-… : every route in apps/web/src/App.tsx, visited at 390×844 (the mobile
// project's viewport), admin screens included, each with realistic seeded data. On every one:
//   - the page never grows wider than the viewport (document.documentElement.scrollWidth stays at
//     or under window.innerWidth) — no horizontal scroll, even with long unbroken strings (message
//     IDs, addresses) or a wide admin table (a table may scroll INSIDE its own container; the page
//     itself never does);
//   - every interactive element not explicitly allowlisted below owns a 44×44 CSS px hit area,
//     proven by hit-testing (document.elementFromPoint at its centre and 20 px out each way): its
//     own box is that big, or every probe lands on it — and no probe ever lands on a different
//     control, so an invisible extension can never steal a neighbour's tap (see
//     apps/web/src/styles/mobile-targets.css);
//   - the primary action for the screen is reachable without ever scrolling sideways.
//
// This test skips itself outside the 'mobile' Playwright project — the desktop project's exit demo
// is the other specs' 1280 px assertions.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

import { ensureOperator, openNav, seedMail, signInCookies, tag, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.skip(({ isMobile }) => !isMobile, 'this is the mobile project’s own pass');

const CSRF = { 'x-postroom-csrf': '1' };

/**
 * Elements allowlisted out of the 44×44 rule, each with why. Kept as CSS selectors so the check
 * itself (evaluated in the page) can skip them without a component-level opt-out attribute.
 *
 *  - `.pr-msg-html a`, `.pr-msg-text a`, `[data-testid="message-text"] a`: inline links inside a
 *    message body's running text — WCAG 2.5.8's own inline exception (a link inside a sentence of
 *    text is exempt because enlarging it would require reflowing the paragraph).
 *  - `.pr-thread a`, `.d3-descitem a`: a citation/description-list link that is a single inline
 *    word inside a line of text, same inline exception.
 *  - `.pr-feed__item-meta a`: the Newsletters feed's "From address · date" line — the address is a
 *    link inline with the date in one line of running text, same inline exception.
 *  - `figure [role="img"] title`, `svg *`: decorative or data-visualisation SVG children (chart
 *    bars with a `<title>` tooltip) are not the interactive element — the enclosing `<figure>` is
 *    not a control at all.
 *  - `.d3-shell__skip`: the "Skip to content" link is 1×1 and off-canvas by design until it
 *    receives keyboard focus (a standard skip-link pattern) — it is never a pointer target while
 *    invisible, so WCAG 2.5.8 (a pointer-input criterion) does not apply to its hidden state.
 */
const INLINE_TEXT_LINK_ALLOWLIST = [
  '.pr-msg-html a',
  '.pr-msg-text a',
  '[data-testid="message-text"] a',
  '[data-testid="html-placeholder"] a',
  '.pr-thread a',
  '.d3-desc-item a',
  '.d3-descitem a',
  '.pr-feed__item-meta a',
  'figcaption a',
  '.d3-shell__skip',
  'svg, svg *',
].join(', ');

interface TargetProblem {
  kind: 'small' | 'overlap';
  tag: string;
  role: string | null;
  name: string;
  className: string;
  width: number;
  height: number;
  /** For an overlap: the control a probe inside this one's hit area actually landed on. */
  stolenBy?: string;
  at?: string;
}

// The e2e project has no DOM lib (see support.ts's note on calendar-contacts.spec.ts): every
// browser global reached from a page.evaluate is described structurally through a cast, exactly as
// the rest of this suite does (deliverability.spec.ts's overflow check, calendar-contacts.spec.ts's
// `El` interface for chip elements).
interface EvalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
interface EvalElement {
  tagName: string;
  className: unknown;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): EvalRect;
  textContent: string | null;
  contains(other: EvalElement): boolean;
  closest(selector: string): EvalElement | null;
  /** On a <label>: the control it labels (clicking the label activates it). */
  control?: EvalElement | null;
  scrollIntoView(opts: { block: string; inline: string }): void;
}
interface EvalDocument {
  documentElement: { scrollWidth: number; clientWidth: number };
  querySelectorAll(selector: string): EvalElement[];
  elementFromPoint(x: number, y: number): EvalElement | null;
}
interface EvalWindow {
  document: EvalDocument;
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(el: EvalElement): { display: string; visibility: string; pointerEvents: string };
}

/**
 * No horizontal scroll, and every interactive element (not allowlisted above) owns a 44×44 CSS px
 * hit area — measured by hit-testing, not by anything the stylesheet says about itself. Each
 * element is scrolled into view and probed with document.elementFromPoint at its centre and 20 px
 * out on each side (clamped to the viewport):
 *   - a probe may land on the element, on something inside it, on its own <label>, or on nothing
 *     interactive — but never on a different interactive control (an invisible extension that shadows a neighbour's
 *     box would send a tap meant for one control to another);
 *   - an element whose own box is under 44 px either way must have every probe land on itself —
 *     otherwise its "equivalent hit area" does not exist.
 */
async function assertMobileFriendly(page: Page, context?: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const w = globalThis as unknown as EvalWindow;
    return { scrollWidth: w.document.documentElement.scrollWidth, innerWidth: w.innerWidth };
  });
  expect(overflow.scrollWidth, `${context ?? ''}: document.documentElement.scrollWidth (${String(overflow.scrollWidth)}) exceeds innerWidth (${String(overflow.innerWidth)}) — a page-level horizontal scroll`).toBeLessThanOrEqual(overflow.innerWidth);

  const problems = await page.evaluate((allow: string) => {
    const w = globalThis as unknown as EvalWindow;
    // Radix (behind @d3cloud/ui's Select and Checkbox) renders a visually-hidden, non-interactive
    // native <select>/<input> alongside the real, visible control — for browser autofill and plain
    // <form> submission — marked aria-hidden and tabindex="-1" (and, for the checkbox, pointer-events:
    // none) precisely so it is never a pointer target. Excluding that pattern here, rather than
    // per-screen, is what actually describes it (it is not a control at all, on any screen).
    const NOT_A_REAL_TARGET = ':not([aria-hidden="true"]):not([tabindex="-1"])';
    const SELECTOR = `a[href], button, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="spinbutton"], input:not([type="hidden"])${NOT_A_REAL_TARGET}, select${NOT_A_REAL_TARGET}, textarea, summary, [tabindex]:not([tabindex="-1"]):not([role="tablist"]):not([role="listbox"]):not([role="radiogroup"]):not([role="group"])`;
    // What a probe landing somewhere would actually activate. A scrolling region (tabindex="0" on a
    // table wrapper or the calendar's week view) is focusable for the keyboard, not a pointer
    // control: a tap on its empty space activates nothing, so it never "steals" a tap.
    const CONTROL = SELECTOR.replace(', [tabindex]:not([tabindex="-1"])', ', [tabindex]:not([tabindex="-1"]):not([role="region"]):not([role="tabpanel"]):not(table):not(div):not(section)');
    const describe = (el: EvalElement): string =>
      `${el.tagName.toLowerCase()}${el.getAttribute('role') === null ? '' : `[role=${el.getAttribute('role') ?? ''}]`} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40).replace(/\s+/g, ' ')}"`;
    const out: TargetProblem[] = [];
    const allowed = new Set(w.document.querySelectorAll(allow));
    for (const el of w.document.querySelectorAll(SELECTOR)) {
      if (allowed.has(el)) continue;
      const style = w.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      let rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not actually rendered (e.g. a hidden drawer)
      if (rect.bottom <= 0 || rect.top >= w.innerHeight || rect.right <= 0 || rect.left >= w.innerWidth) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        rect = el.getBoundingClientRect();
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Something else (a sticky header, a drawer) covers this control's centre: it is not a
      // pointer target where it sits right now, so there is nothing of its own to measure.
      const centreHit = w.document.elementFromPoint(cx, cy);
      if (centreHit === null || !(centreHit === el || el.contains(centreHit) || centreHit.contains(el))) continue;
      const clampX = (x: number): number => Math.min(Math.max(x, 0), w.innerWidth - 1);
      const clampY = (y: number): number => Math.min(Math.max(y, 0), w.innerHeight - 1);
      const probes: [number, number, string][] = [
        [cx, cy, 'centre'],
        [clampX(cx - 20), cy, 'left'],
        [clampX(cx + 20), cy, 'right'],
        [cx, clampY(cy - 20), 'top'],
        [cx, clampY(cy + 20), 'bottom'],
      ];
      const small = rect.width < 43.5 || rect.height < 43.5;
      let allOwn = true;
      for (const [x, y, at] of probes) {
        const hit = w.document.elementFromPoint(x, y);
        if (hit === null) {
          allOwn = false;
          continue;
        }
        // The control's own <label> activates it too (a Checkbox's text beside its box).
        if (hit === el || el.contains(hit) || hit.closest('label')?.control === el) continue;
        allOwn = false;
        const owner = hit.closest(CONTROL);
        // A probe that lands on this control's own container (a label wrapping it, a row that holds
        // it) or on plain content is fine; a different control is not.
        if (owner === null || owner.contains(el)) continue;
        out.push({
          kind: 'overlap',
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          name: describe(el),
          className: typeof el.className === 'string' ? el.className : '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          stolenBy: describe(owner),
          at,
        });
        break;
      }
      if (small && !allOwn && !out.some((p) => p.name === describe(el) && p.kind === 'overlap')) {
        out.push({
          kind: 'small',
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          name: describe(el),
          className: typeof el.className === 'string' ? el.className : '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return out;
  }, INLINE_TEXT_LINK_ALLOWLIST);
  expect(problems, `${context ?? ''}: tap targets that are under 44×44 CSS px by hit-test, or whose hit area lands on another control — ${JSON.stringify(problems)}`).toEqual([]);
}

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
let operator: Operator;

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  if (cookies.length > 0) await context.addCookies(cookies);
});

test('Setup and Sign in are usable at 390 px, before any session exists', async ({ page }) => {
  const state = (await (await api.get('/api/auth/state')).json()) as { setupRequired: boolean };
  test.skip(!state.setupRequired, 'this stack already has an operator — /setup was already exercised on it');

  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Set up Postroom' })).toBeVisible();
  await assertMobileFriendly(page, '/setup');

  // /signin redirects to /setup while setupRequired is still true (redirectFor in api.ts) — so
  // Sign in's own layout can only be seen once setup is done over the API (this does not sign the
  // browser in: the page above never had cookies added, and none are added until after this test).
  operator = await ensureOperator(api);

  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in to Postroom' })).toBeVisible();
  await assertMobileFriendly(page, '/signin');

  cookies = await signInCookies(api, operator);
});

test.describe('signed in', () => {
  test.beforeAll(async () => {
    if (cookies.length === 0) {
      operator = await ensureOperator(api);
      cookies = await signInCookies(api, operator);
    }
  });

  test('Mail: inbox list, an open message, the composer and the Newsletters feed', async ({ page }) => {
    const t = tag();
    const longAddress = `a-very-long-unbroken-address-that-would-otherwise-widen-the-page.${t}@subdomain.example-corporation.invalid`;
    const [msg] = await seedMail(api, [
      {
        subject: `Quarterly numbers with a long unbroken Message-ID and address ${t}`,
        from: `Someone Withaverylongdisplaynamethatdoesnotwrap <${longAddress}>`,
        text: `A body line with a long unbroken token: ${'x'.repeat(120)}\n\nAnd a normal line.`,
      },
    ]);
    if (msg === undefined) throw new Error('seed returned nothing');

    await page.goto('/');
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
    await assertMobileFriendly(page, '/ (inbox list)');

    // The sidebar is a drawer below tablet width (Shell.tsx) — open it once to check its own
    // mailbox/organise/account/admin links, then close it before the rest of this test's navigation.
    await openNav(page);
    await assertMobileFriendly(page, '/ (navigation drawer open)');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Navigation' }).waitFor({ state: 'detached' });

    await page.getByRole('option', { name: new RegExp(msg.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await expect(page.getByRole('heading', { name: msg.subject, level: 2 })).toBeVisible();
    await assertMobileFriendly(page, `/mail/${msg.mailboxId}/${msg.id} (open message)`);

    await page.goto('/?compose=new');
    await expect(page.getByRole('region', { name: 'New message' })).toBeVisible();
    await assertMobileFriendly(page, '/?compose=new (composer)');

    // The Newsletters feed: three messages moved there, exactly as feed-and-profile.spec.ts seeds it.
    const from = `feed-mobile-${t}@example.test`;
    const feedSeed = await seedMail(api, [
      { subject: `Weekly Digest ${t}`, from: `Digest <${from}>`, text: `Issue one of ${t}.` },
      { subject: `Product Update ${t}`, from: `Digest <${from}>`, text: `Issue two of ${t}.` },
    ]);
    const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; name: string }[] };
    const newsletters = mailboxes.find((m) => m.name === 'Newsletters');
    if (newsletters === undefined) throw new Error('no Newsletters mailbox');
    for (const m of feedSeed) {
      const detail = (await (await api.get(`/api/messages/${m.id}`)).json()) as { modseq: string };
      await api.patch(`/api/messages/${m.id}`, { headers: { ...CSRF, 'if-match': `"${detail.modseq}"` }, data: { mailboxId: newsletters.id } });
    }
    await page.goto(`/mail/${newsletters.id}`);
    await expect(page.getByTestId('feed')).toBeVisible();
    await assertMobileFriendly(page, `/mail/${newsletters.id} (Newsletters feed)`);

    // The sender profile, linked from the feed's From line.
    await page.getByRole('link', { name: from }).first().click();
    await expect(page).toHaveURL(new RegExp(`/senders/${encodeURIComponent(from)}`));
    await expect(page.getByRole('heading', { name: from })).toBeVisible();
    await assertMobileFriendly(page, `/senders/${from}`);
  });

  test('Calendar and Contacts', async ({ page }) => {
    const t = tag();
    const cals = (await (await api.get('/api/calendar/calendars')).json()) as { calendars: { id: string; canHoldEvents: boolean }[] };
    const calendarId = cals.calendars.find((c) => c.canHoldEvents)?.id ?? '';
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
    await api.post(`/api/calendar/calendars/${calendarId}/events`, {
      headers: CSRF,
      data: { summary: `A meeting with a long unbroken title that must not widen the page ${t}`, start: `${monday}T09:00`, end: `${monday}T10:00`, timezone: 'UTC' },
    });

    await page.goto(`/calendar?view=month&date=${monday}`);
    await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/calendar');

    const books = (await (await api.get('/api/contacts/address-books')).json()) as { addressBooks: { id: string }[] };
    const book = books.addressBooks[0];
    if (book === undefined) throw new Error('no address book');
    const created = await api.post(`/api/contacts/address-books/${book.id}/cards`, {
      headers: CSRF,
      data: {
        fn: `Ada Lovelace-Byron-King-Noel ${t}`,
        given: 'Ada',
        family: `Lovelace ${t}`,
        emails: [{ address: `ada.a-very-long-unbroken-address-${t}@analytical-engines.example.org`, type: 'work' }],
        tels: [{ value: '+44 20 7946 0000', type: 'cell' }],
        org: 'Analytical Engines',
        note: 'Met at the conference.',
      },
    });
    expect(created.ok(), `contact create answered ${String(created.status())}`).toBe(true);
    const card = (await created.json()) as { addressBookId: string; name: string };
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/contacts');

    // App.tsx's /contacts/:addressBookId/:name — one contact, opened from its own URL.
    const cardPath = `/contacts/${encodeURIComponent(card.addressBookId)}/${encodeURIComponent(card.name)}`;
    await page.goto(cardPath);
    await expect(page.getByRole('heading', { name: `Ada Lovelace-Byron-King-Noel ${t}` }).first()).toBeVisible();
    await assertMobileFriendly(page, cardPath);

    await page.goto('/contacts/new');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/contacts/new');
  });

  test('Account screens: app passwords, aliases, password, devices, import, device setup, rules, templates', async ({ page }) => {
    const t = tag();

    await api.post('/api/app-passwords', { headers: CSRF, data: { label: `Phone Mail ${t}`, scopes: ['imap', 'smtp'] } }).catch(() => undefined);
    await page.goto('/app-passwords');
    await expect(page.getByRole('heading', { name: 'App passwords', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/app-passwords');

    await api.post('/api/aliases', { headers: CSRF, data: { site: `shop-${t}.example` } }).catch(() => undefined);
    await page.goto('/account/aliases');
    await expect(page.getByRole('heading', { name: 'Masked aliases', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/aliases');

    await page.goto('/account/password');
    await expect(page.getByRole('heading', { name: 'Change password', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/password');

    await page.goto('/account/sessions');
    await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/sessions');

    await page.goto('/account/import');
    await expect(page.getByRole('heading', { name: 'Import mail', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/import');

    await page.goto('/account/device-setup');
    await expect(page.getByRole('heading', { name: 'Set up iPhone / Mac', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/device-setup');

    await page.goto('/account/rules');
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Add rule' }).click();
    // Another test (or an earlier run against this database) may have left a rule here already —
    // "Add rule" always appends, so the newest one is always last.
    await page.getByRole('textbox', { name: 'Text' }).last().fill(`billing-${t}@shop.example`);
    await page.getByRole('textbox', { name: 'Folder' }).last().fill('Receipts');
    await page.getByRole('button', { name: 'Save and turn on' }).click();
    await expect(page.getByText('now runs on new mail')).toBeVisible();
    await assertMobileFriendly(page, '/account/rules');

    await api.post('/api/templates', { headers: CSRF, data: { shortcut: `ty${t}`, name: `Thank you ${t}`, body: 'Thanks for reaching out.' } }).catch(() => undefined);
    await page.goto('/account/templates');
    await expect(page.getByRole('heading', { name: 'Compose templates', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/account/templates');
  });

  test('Admin: sessions, health, jobs, queue, deliverability, SMTP sessions', async ({ page }) => {
    const t = tag();

    await page.goto('/admin/sessions');
    await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/sessions');

    await page.goto('/admin/health');
    await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/health');

    const seededFailure = await api.post('/api/admin/jobs/dev-seed-failure', { headers: CSRF });
    if (seededFailure.status() === 404) throw new Error('the stack has no dev-seed-failure route: start the api with POSTROOM_E2E_SEED=1');
    await page.goto('/admin/jobs');
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/jobs');

    await api.post('/api/admin/queue/dev-seed-deferred', { headers: CSRF, data: { domain: `mobile-${t}.test` } });
    await page.goto('/admin/queue');
    await expect(page.getByRole('heading', { name: 'Outbound queue', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/queue');

    await page.goto('/admin/deliverability');
    await expect(page.getByRole('heading', { name: 'Deliverability', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/deliverability');

    // No e2e seed route exists for SMTP transcripts (they are written by the smtp-in/submission
    // daemons themselves, which this stack does not run) and @postroom/e2e has no database
    // dependency to insert one directly — so this screen is exercised in its real "no transcripts
    // yet" empty state, which is itself a state the mobile layout must handle without overflow.
    await page.goto('/admin/smtp');
    await expect(page.getByRole('heading', { name: 'SMTP sessions', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/smtp');
  });
});
