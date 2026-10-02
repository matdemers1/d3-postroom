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
// This test skips itself outside the phone Playwright projects — the desktop project's exit demo
// is the other specs' 1280 px assertions. The 'mobile' project (390×844) runs the sweeps below;
// the 'landscape' project (844×390, PST-T-16.18) runs only the last suite, because the sweeps
// above it measure against portrait numbers (390 wide, 844 tall).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { ensureOperator, seedMail, signInCookies, tag, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.skip(({ isMobile }) => !isMobile, 'this is the mobile project’s own pass');

// PST-T-16.18: the suite that is the landscape project's, and only its. Everything else in this file
// asserts portrait geometry (390 px wide, a viewport 844 tall) and runs in the 'mobile' project.
const LANDSCAPE_SUITE = 'Landscape phone (PST-T-16.18)';
test.beforeEach(({ isMobile }, testInfo) => {
  if (!isMobile) return; // the file-level skip above already covers it
  const inLandscapeProject = testInfo.project.name === 'landscape';
  const isLandscapeTest = testInfo.titlePath.includes(LANDSCAPE_SUITE);
  test.skip(inLandscapeProject !== isLandscapeTest, inLandscapeProject ? 'portrait-only: asserts 390×844 geometry; the mobile project runs it' : 'landscape-only: the landscape project runs it');
});

const CSRF = { 'x-postroom-csrf': '1' };

/**
 * Elements allowlisted out of the 44×44 rule, each with why. Kept as CSS selectors so the check
 * itself (evaluated in the page) can skip them without a component-level opt-out attribute.
 *
 *  - `.pr-msg-html a`, `.pr-msg-text a`, `[data-testid="message-text"] a`: inline links inside a
 *    message body's running text — WCAG 2.5.8's own inline exception (a link inside a sentence of
 *    text is exempt because enlarging it would require reflowing the paragraph).
 *  - `.pr-thread a`, `.d3-descitem a`, `.d3-desc__value a`: a citation/description-list link that
 *    is a single inline word inside a line of text, same inline exception. `.d3-desc__value a` is
 *    @d3cloud/ui 1.2.2's actual DescriptionItem value class (the reading pane's "Sender profile"
 *    and "In contacts as …" links, PST-DA-028) — `.d3-descitem`/`.d3-desc-item` above predate it
 *    and are kept in case an older build still renders them.
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
  '.d3-desc__value a',
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
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true, level: 1 })).toBeVisible();
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
    // PST-T-14.8: one push stack — no hamburger drawer competing with it, and the Inbox's segments
    // are 44 px. PST-T-15.8 (the canvas's PhoneInbox): the top bar holds only "‹ Mailboxes"; the
    // list's heading is the large title with the unread count under it; the search field and the
    // segments span the width; the rows run edge to edge; and a bottom bar says the list is current
    // and offers New message.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    const listBar = page.getByTestId('context-bar');
    await expect(listBar.getByRole('link', { name: 'Mailboxes', exact: true })).toBeVisible();
    await expect(listBar.getByRole('button')).toHaveCount(0);
    const largeTitle = page.getByRole('heading', { name: /^Inbox/, level: 2 });
    await expect(largeTitle).toBeVisible();
    expect(await largeTitle.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { fontSize: string } }).getComputedStyle(el).fontSize)).toBe('24px');
    await expect(page.getByRole('button', { name: 'Compose' })).toHaveCount(0);
    const search = page.getByRole('search').filter({ has: page.getByRole('searchbox', { name: 'Search mail' }) });
    expect((await search.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
    const segments = page.getByRole('radiogroup', { name: 'Show in Inbox' });
    expect((await segments.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
    for (const box of await segments.getByRole('radio').all()) {
      expect((await box.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const firstRow = await page.getByRole('option').first().boundingBox();
    expect(firstRow?.x ?? 99).toBeLessThanOrEqual(1);
    expect(firstRow?.width ?? 0).toBeGreaterThanOrEqual(389);
    const bottomBar = page.getByTestId('list-bar');
    await expect(bottomBar.getByRole('button', { name: 'New message' })).toBeVisible();
    await expect(bottomBar).toContainText('Updated just now');
    const bottomBox = await bottomBar.boundingBox();
    expect((bottomBox?.y ?? 0) + (bottomBox?.height ?? 0)).toBeGreaterThan(844 - 2);
    // assertMobileFriendly scrolls every row into view to probe it; start the list from its top
    // again, so the newest message (the one seeded above) is a rendered row, however long the Inbox.
    await page.goto('/');

    await page.getByRole('option', { name: new RegExp(msg.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await expect(page.getByRole('heading', { name: msg.subject, level: 2 })).toBeVisible();
    // Body first: the actions are a bottom bar, not rows of links above the body — @d3cloud/ui's
    // ActionBar since PST-T-15.8, a labelled group of plain buttons (D-083).
    const actionBar = page.getByRole('group', { name: 'Message actions' });
    await expect(actionBar).toHaveCount(1);
    await expect(actionBar.getByRole('button')).toHaveText(['Archive', 'Delete', 'Move', 'Reply', 'More']);
    const bar = await actionBar.boundingBox();
    expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeGreaterThan(844 - 2);
    await assertMobileFriendly(page, `/mail/${msg.mailboxId}/${msg.id} (open message)`);
    // The context bar stays put while the thread scrolls under it.
    await page.getByTestId('reader-scroll').evaluate((el) => {
      (el as unknown as { scrollTop: number }).scrollTop = 10_000;
    });
    expect((await page.getByTestId('context-bar').boundingBox())?.y).toBe(0);
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Inbox', exact: true })).toBeInViewport();

    // ⋯ holds the rest, each row a 44 px target.
    await actionBar.getByRole('button', { name: 'More actions' }).click();
    const more = page.getByRole('menu');
    await expect(more.getByRole('menuitem')).toHaveText(['Reply all', 'Forward', 'Snooze…', 'Mark unread', 'Star', 'Inspect message']);
    await assertMobileFriendly(page, `/mail/${msg.mailboxId}/${msg.id} (⋯ open)`);
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();

    // The root of the stack (App.tsx's /mail/*): the mailboxes, Calendar, Contacts and the account
    // menu — where the list's Back goes.
    await page.getByTestId('context-bar').getByRole('link', { name: 'Inbox', exact: true }).click();
    await page.getByTestId('context-bar').getByRole('link', { name: 'Mailboxes', exact: true }).click();
    // /mail is the stack's root: the mailbox list alone (MailView draws no message list there).
    await expect(page).toHaveURL(/\/mail$/);
    await expect(page.getByRole('navigation', { name: 'Mailboxes' }).getByRole('link', { name: /^Inbox/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Places' }).getByRole('link')).toHaveText(['Calendar', 'Contacts']);
    await assertMobileFriendly(page, '/mail (mailbox list)');

    await page.goto('/?compose=new');
    const sheet = page.getByRole('region', { name: 'New message' });
    await expect(sheet).toBeVisible();
    await assertMobileFriendly(page, '/?compose=new (composer)');
    // PST-T-15.8 (the canvas's PhoneCompose): a full-height sheet whose bar is Cancel, the title and a
    // round Send; the split button is not drawn, and Send later… is in ⋯ More instead.
    await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'New message', level: 2 })).toBeVisible();
    const send = sheet.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toHaveCount(1);
    const sendBox = await send.boundingBox();
    expect(sendBox?.y ?? 844).toBeLessThan(60);
    expect((sendBox?.x ?? 0) + (sendBox?.width ?? 0)).toBeGreaterThan(390 - 16);
    await expect(sheet.getByRole('button', { name: 'More send options' })).toHaveCount(0);
    const sheetBox = await sheet.boundingBox();
    expect(Math.abs(sheetBox?.y ?? 99)).toBeLessThanOrEqual(1);
    expect(sheetBox?.height ?? 0).toBeGreaterThan(844 - 2);
    await sheet.getByRole('button', { name: 'More options' }).click();
    await expect(page.getByRole('menuitem', { name: 'Send later…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Remind me if no reply…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    // Cancel is the close that keeps the draft: back to the list, no composer.
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).not.toHaveURL(/compose=/);
    await expect(page.getByRole('region', { name: 'New message' })).toHaveCount(0);

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

  test('Settings: account, browser sessions, devices, device setup, addresses, import, rules, templates, keys', async ({ page }) => {
    const t = tag();

    await api.post('/api/app-passwords', { headers: CSRF, data: { label: `Phone Mail ${t}`, scopes: ['imap', 'smtp'] } }).catch(() => undefined);
    await page.goto('/settings/security/devices');
    await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/security/devices');

    await api.post('/api/aliases', { headers: CSRF, data: { site: `shop-${t}.example` } }).catch(() => undefined);
    await page.goto('/settings/addresses');
    await expect(page.getByRole('heading', { name: 'Addresses', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/addresses');

    await page.goto('/settings/account');
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/account');

    await page.goto('/settings/security/sessions');
    await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/security/sessions');

    await page.goto('/settings/import');
    await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/import');

    await page.goto('/settings/security');
    await expect(page.getByRole('heading', { name: 'Security & devices', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/security');

    // PST-T-14.8: Settings pushes like the mailboxes — '/settings' is its index on a phone, each
    // screen's context bar goes Back to it, and the index goes Back to Mailboxes.
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByTestId('context-bar').getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Security & devices' })).toBeVisible();
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Mailboxes', exact: true })).toBeVisible();
    await assertMobileFriendly(page, '/settings (index)');

    await page.goto('/settings/rules');
    await expect(page.getByRole('heading', { name: 'Rules & sorting', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Add rule' }).click();
    // Another test (or an earlier run against this database) may have left a rule here already —
    // "Add rule" always appends, so the newest one is always last.
    await page.getByRole('textbox', { name: 'Text' }).last().fill(`billing-${t}@shop.example`);
    // PST-T-16.9: one Destination picker of real places, not a free-text Folder field.
    await page.getByRole('combobox', { name: 'Destination' }).last().click();
    await page.getByRole('option', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Save and turn on' }).click();
    await expect(page.getByText('now runs on new mail')).toBeVisible();
    await assertMobileFriendly(page, '/settings/rules');

    await api.post('/api/templates', { headers: CSRF, data: { shortcut: `ty${t}`, name: `Thank you ${t}`, body: 'Thanks for reaching out.' } }).catch(() => undefined);
    await page.goto('/settings/templates');
    await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/templates');

    // Keys (PST-T-12.2): one generated own key as the seeded data; a rerun against the same
    // database may already have one, which is fine.
    const state = (await (await api.get('/api/auth/state')).json()) as { account?: { address: string | null } };
    const own = state.account?.address;
    if (own !== null && own !== undefined) await api.post('/api/keys/generate', { headers: CSRF, data: { address: own } }).catch(() => undefined);
    await page.goto('/settings/keys');
    await expect(page.getByRole('heading', { name: 'Encryption keys', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/settings/keys');
  });

  test('Admin console: sign-in sessions, health, jobs, queue, suppressions, deliverability, live SMTP', async ({ page }) => {
    const t = tag();

    // The Admin console's index on a phone, pushed from Settings.
    await page.goto('/admin');
    await expect(page.getByRole('navigation', { name: 'Admin console' }).getByRole('link', { name: 'Health' })).toBeVisible();
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await assertMobileFriendly(page, '/admin (index)');

    await page.goto('/admin/sessions');
    await expect(page.getByRole('heading', { name: 'Sign-in sessions', level: 1 })).toBeVisible();
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
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

    // PST-T-11.10: a hard-bounce entry, so the list has a row with its Remove button to hit-test.
    const seededSuppression = await api.post('/api/admin/suppressions/dev-seed-bounce', { headers: CSRF, data: { address: `gone-${t}@mobile.test` } });
    if (seededSuppression.status() === 404) throw new Error('the stack has no dev-seed-bounce route: start the api with POSTROOM_E2E_SEED=1');
    await page.goto('/admin/suppressions');
    await expect(page.getByRole('heading', { name: 'Suppressions', level: 1 })).toBeVisible();
    await expect(page.getByText(`gone-${t}@mobile.test`)).toBeVisible();
    await assertMobileFriendly(page, '/admin/suppressions');

    await page.goto('/admin/deliverability');
    await expect(page.getByRole('heading', { name: 'Deliverability', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/deliverability');

    // No e2e seed route exists for SMTP transcripts (they are written by the smtp-in/submission
    // daemons themselves, which this stack does not run) and @postroom/e2e has no database
    // dependency to insert one directly — so this screen is exercised in its real "no transcripts
    // yet" empty state, which is itself a state the mobile layout must handle without overflow.
    await page.goto('/admin/smtp');
    await expect(page.getByRole('heading', { name: 'Live SMTP', level: 1 })).toBeVisible();
    await assertMobileFriendly(page, '/admin/smtp');
  });
  test('push navigation slides in from the right, reverses on Back, and does not move under reduced motion', async ({ page }) => {
    const t = tag();
    const [m] = await seedMail(api, [{ subject: `Push ${t}`, text: 'Slide.' }]);
    if (m === undefined) throw new Error('seed returned nothing');
    // The suite runs with reduced motion (playwright.config.ts); this test is about the motion.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const animationOf = (selector: string) =>
      page.locator(selector).first().evaluate((el) => {
        const w = globalThis as unknown as { getComputedStyle(e: unknown): { animationName: string; animationDuration: string } };
        const style = w.getComputedStyle(el);
        return `${style.animationName} ${style.animationDuration}`;
      });

    await page.goto(`/mail/${m.mailboxId}`);
    await page.getByRole('option', { name: new RegExp(`Push ${t}`) }).click();
    await expect(page.getByRole('heading', { name: `Push ${t}`, level: 2 })).toBeVisible();
    await expect(page.locator('.pr-push--level')).toHaveAttribute('data-push', 'forward');
    expect(await animationOf('.pr-push--level')).toBe('pr-push-in 0.28s');

    await page.getByTestId('context-bar').getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
    await expect(page.locator('.pr-push--level')).toHaveAttribute('data-push', 'back');
    expect(await animationOf('.pr-push--level')).toBe('pr-pop-in 0.28s');

    // Settings pushes too, from the root.
    await page.getByTestId('context-bar').getByRole('link', { name: 'Mailboxes', exact: true }).click();
    await page.locator('button.d3-acct').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('.pr-push').first()).toHaveAttribute('data-push', 'forward');

    // Reduced motion: no slide at all, and the screens still arrive (nothing waits on animationend).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/mail/${m.mailboxId}`);
    await page.getByRole('option', { name: new RegExp(`Push ${t}`) }).click();
    await expect(page.getByRole('heading', { name: `Push ${t}`, level: 2 })).toBeVisible();
    expect((await animationOf('.pr-push--level')).split(' ')[0]).toBe('none');
    await page.getByTestId('context-bar').getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
  });

  test('HTML mail is fitted to the width: no clipping inside the frame, no sideways page scroll', async ({ page }) => {
    // PST-T-14.8: the frame spans the pane, and the usercontent document's narrow-frame rule
    // (apps/api/src/usercontent/index.ts's NARROW_FIT_STYLE) fits the sender's 600 px layout inside it.
    const t = tag();
    // A sender's fixed 600 px newsletter layout: a table, a banner cell and a fixed-width block.
    const html =
      `<table width="600" cellpadding="0" cellspacing="0"><tr><td width="600" style="background:#5b3fd6;color:#fff;font-size:28px;padding:16px">Self-Hosted Weekly ${t}: Immich 2.0, Caddy vs Traefik, and a $90 NAS</td></tr>` +
      `<tr><td style="padding:16px"><div style="width:560px">Stable at last: the mobile apps got a rework, sync is fast, and there is finally an official backup guide.</div></td></tr></table>`;
    const [m] = await seedMail(api, [{ subject: `Newsletter ${t}`, text: null, html }]);
    if (m === undefined) throw new Error('seed returned nothing');
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    const frame = page.getByTestId('message-html');
    await expect(frame).toBeVisible();
    const box = await frame.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await assertMobileFriendly(page, `/mail/${m.mailboxId}/${m.id} (HTML newsletter)`);
    const inner = page.frameLocator('[data-testid="message-html"]');
    await expect(inner.getByText(`Self-Hosted Weekly ${t}`)).toBeVisible();
    const widths = await inner.locator('html').evaluate((el) => {
      const root = el as unknown as { scrollWidth: number; clientWidth: number };
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(widths.scrollWidth, 'the message is wider than its frame: its right edge is clipped').toBeLessThanOrEqual(widths.clientWidth);
  });
});

// PST-T-16.13 (PST-DA-031, PST-REQ-155): the Outbound queue below 640px is a list of cards, and
// every action is reachable without sideways scroll. Self-contained: later tasks edit this file too.
test.describe('Outbound queue as cards (PST-T-16.13)', () => {
  test.beforeAll(async () => {
    if (cookies.length === 0) {
      operator = await ensureOperator(api);
      cookies = await signInCookies(api, operator);
    }
  });

  test('rows are DataList cards with an Actions menu and a details drawer, and the page never scrolls sideways', async ({ page }) => {
    const t = tag();
    const domain = `cards-${t}.test`;
    const seeded = await api.post('/api/admin/queue/dev-seed-deferred', { headers: CSRF, data: { domain } });
    if (seeded.status() === 404) throw new Error('the stack has no dev-seed-deferred route: start the api with POSTROOM_E2E_SEED=1');

    await page.goto(`/admin/queue?domain=${domain}`);
    await expect(page.getByRole('heading', { name: 'Outbound queue', level: 1 })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    const list = page.getByRole('list', { name: 'Outbound queue' });
    await expect(list).toBeVisible();
    const card = list.getByRole('listitem').filter({ hasText: `first@${domain}` });
    await expect(card).toBeVisible();
    await assertMobileFriendly(page, '/admin/queue (cards)');

    // Every action, with the menu open, sits inside the viewport.
    await card.getByRole('button', { name: /^Actions for / }).click();
    for (const name of ['Retry now', 'Force SES', 'Bounce', 'Delete']) {
      const item = page.getByRole('menuitem', { name });
      await expect(item).toBeVisible();
      const box = await item.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), `${name} runs past the right edge`).toBeLessThanOrEqual(390);
      expect(box?.x ?? -1, `${name} starts left of the screen`).toBeGreaterThanOrEqual(0);
    }
    await page.keyboard.press('Escape');

    // The evidence is a sheet over the whole phone.
    await card.getByRole('button', { name: `Delivery details for first@${domain}` }).click();
    const drawer = page.getByRole('dialog', { name: 'Delivery details' });
    await expect(drawer.getByTestId('queue-last-response')).toContainText('greylisted (seeded for e2e)');
    await assertMobileFriendly(page, '/admin/queue (details drawer)');
  });
});

// PST-T-17.1 (PST-REQ-155, PST-REQ-194): Health, the Outbound queue and Deliverability are lists of
// cards on a phone — not a table clipped at the right edge. On each: the page never scrolls sideways,
// nothing inside main reaches past the viewport, and every row action is on screen. Self-contained,
// like the queue suite above: it seeds its own queue row and the DMARC/TLS fixtures.
const reportFixtures = join(import.meta.dirname, '..', '..', 'packages', 'reports', 'test', 'fixtures');
function reportFixture(suffix: string, contentType: string): { filename: string; contentType: string; contentBase64: string } {
  const filename = readdirSync(reportFixtures).find((f) => f.endsWith(suffix));
  if (filename === undefined) throw new Error(`no fixture ending ${suffix}`);
  return { filename, contentType, contentBase64: readFileSync(join(reportFixtures, filename)).toString('base64') };
}

interface OverflowElement {
  tagName: string;
  className: unknown;
  parentElement: OverflowElement | null;
  getBoundingClientRect(): { right: number; width: number };
}
interface OverflowWindow {
  innerWidth: number;
  document: { scrollingElement: { scrollWidth: number } | null; querySelectorAll(selector: string): OverflowElement[] };
  getComputedStyle(el: OverflowElement): { overflowX: string; display: string; visibility: string };
}

test.describe('Health, Outbound queue and Deliverability as cards (PST-T-17.1)', () => {
  test.beforeAll(async () => {
    if (cookies.length === 0) {
      operator = await ensureOperator(api);
      cookies = await signInCookies(api, operator);
    }
  });

  test('nothing inside main overflows sideways, and every row action is visible', async ({ page }) => {
    const t = tag();
    const domain = `canvas-${t}.test`;
    const queued = await api.post('/api/admin/queue/dev-seed-deferred', { headers: CSRF, data: { domain } });
    if (queued.status() === 404) throw new Error('the stack has no dev-seed-deferred route: start the api with POSTROOM_E2E_SEED=1');
    const reports = await api.post('/api/admin/deliverability/dev/seed', {
      headers: CSRF,
      data: {
        messages: [
          { from: 'noreply-dmarc-support@google.com', subject: 'Report domain: d3cloud.io Submitter: google.com Report-ID: 4817259360124789153', attachments: [reportFixture('.zip', 'application/zip')] },
          { from: 'noreply-smtp-tls-reporting@google.com', subject: 'Report Domain: d3cloud.io Submitter: google.com Report-ID: <2026.09.24T00.00.00Z+d3cloud.io@google.com>', attachments: [reportFixture('.json.gz', 'application/tlsrpt+gzip')] },
        ],
      },
    });
    if (reports.status() === 404) throw new Error('the stack has no deliverability dev seed route: start the api with POSTROOM_E2E_SEED=1');
    await expect
      .poll(async () => ((await (await api.get('/api/admin/deliverability?days=3650')).json()) as { dmarc: { totals: { reports: number } } }).dmarc.totals.reports, {
        timeout: 60_000,
        message: 'the reports never appeared — is the worker running against this stack?',
      })
      .toBeGreaterThan(0);

    const screens: { path: string; h1: string; list: string; actions: number }[] = [
      { path: '/admin/health', h1: 'Health', list: 'Services', actions: 0 },
      { path: `/admin/queue?domain=${domain}`, h1: 'Outbound queue', list: 'Outbound queue', actions: 1 },
      { path: '/admin/deliverability?days=3650', h1: 'Deliverability', list: 'DMARC results by sending source', actions: 0 },
    ];
    for (const screen of screens) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { name: screen.h1, level: 1 })).toBeVisible();
      await expect(page.getByRole('list', { name: screen.list })).toBeVisible();
      // A phone gets cards: no table anywhere in main.
      await expect(page.locator('main table')).toHaveCount(0);

      const overflow = await page.evaluate(() => {
        const w = globalThis as unknown as OverflowWindow;
        // Text cut off behind its own ellipsis reports its full width, but nothing of it shows past the
        // box that clips it: an element counts only when no clipping ancestor stops inside the viewport.
        const clipped = (el: OverflowElement): boolean => {
          for (let p = el.parentElement; p !== null; p = p.parentElement) {
            if (w.getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= w.innerWidth) return true;
          }
          return false;
        };
        const offenders = [...w.document.querySelectorAll('main *')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = w.getComputedStyle(el);
            return rect.width > 0 && style.display !== 'none' && style.visibility !== 'hidden' && rect.right > w.innerWidth + 0.5 && !clipped(el);
          })
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${String(Math.round(el.getBoundingClientRect().right))}`);
        return { scrollWidth: w.document.scrollingElement?.scrollWidth ?? 0, innerWidth: w.innerWidth, offenders };
      });
      expect(overflow.scrollWidth, `${screen.path}: the page scrolls sideways`).toBeLessThanOrEqual(overflow.innerWidth);
      expect(overflow.offenders, `${screen.path}: elements in main past the right edge`).toEqual([]);

      // Every row action — the queue's ⋯ menu, Health's next step — is on screen, whole.
      const actions = page.locator('main .d3-dlrow__actions').locator('button, a');
      expect(await actions.count(), `${screen.path}: row actions`).toBeGreaterThanOrEqual(screen.actions);
      for (const action of await actions.all()) {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeVisible();
        const box = await action.boundingBox();
        expect(box, `${screen.path}: a row action has no box`).not.toBeNull();
        expect(box?.x ?? -1, `${screen.path}: a row action starts left of the screen`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${screen.path}: a row action runs past the right edge`).toBeLessThanOrEqual(overflow.innerWidth);
      }
      await assertMobileFriendly(page, `${screen.path} (cards)`);
    }
  });
});

// PST-T-16.15 (PST-DA-066, PST-DA-035, PST-REQ-190, PST-REQ-155): triage by swipe on a phone. A row
// dragged left past 40% of its width archives through the triage path (so the Undo toast appears and
// Undo restores it); dragged right it toggles read/unread; a short drag snaps back; reduced motion
// still commits without the slide; axe is clean with the swipe surfaces drawn and mid-drag. The
// gesture is driven as Pointer Events with pointerType "touch" dispatched on the row (Playwright has
// no drag-by-finger), which is exactly what a touch screen delivers to the handlers.
test.describe('Swipe triage (PST-T-16.15)', () => {
  test.beforeAll(async () => {
    if (cookies.length === 0) {
      operator = await ensureOperator(api);
      cookies = await signInCookies(api, operator);
    }
  });

  const rowFor = (page: Page, subject: string): Locator =>
    page.getByRole('listbox', { name: 'Messages in Inbox' }).getByRole('option', { name: new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  const toasts = (page: Page): Locator => page.getByRole('region', { name: 'Notifications' });

  /**
   * One touch drag across a row: `fraction` of the row's width (negative: leftwards), in six moves,
   * with `dy` of vertical drift. `release: false` stops mid-drag (no pointerup) for a look at the
   * revealed surface; `finish()` then lets go.
   */
  async function drag(row: Locator, fraction: number, options: { dy?: number; release?: boolean } = {}): Promise<void> {
    await row.evaluate(
      (el, input) => {
        const g = globalThis as unknown as { PointerEvent: new (type: string, init: Record<string, unknown>) => unknown };
        const node = el as unknown as {
          getBoundingClientRect(): { left: number; top: number; width: number; height: number };
          dispatchEvent(e: unknown): boolean;
        };
        const r = node.getBoundingClientRect();
        const x0 = r.left + r.width * (input.fraction < 0 ? 0.85 : 0.15);
        const y0 = r.top + r.height / 2;
        const fire = (type: string, x: number, y: number): void => {
          node.dispatchEvent(
            new g.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }),
          );
        };
        fire('pointerdown', x0, y0);
        for (let i = 1; i <= 6; i++) fire('pointermove', x0 + (input.fraction * r.width * i) / 6, y0 + (input.dy * i) / 6);
        if (input.release) fire('pointerup', x0 + input.fraction * r.width, y0 + input.dy);
      },
      { fraction, dy: options.dy ?? 0, release: options.release ?? true },
    );
  }

  /** Lets go of a drag left open by `release: false`, back where it started (a cancel). */
  async function cancelDrag(row: Locator): Promise<void> {
    await row.evaluate((el) => {
      const g = globalThis as unknown as { PointerEvent: new (type: string, init: Record<string, unknown>) => unknown };
      (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new g.PointerEvent('pointercancel', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true }));
    });
  }

  async function seedOne(label: string): Promise<{ id: string; mailboxId: string; subject: string }> {
    const t = tag();
    const [m] = await seedMail(api, [{ subject: `${label} ${t}`, from: `Grace Hopper <grace.${t}@example.org>`, text: `Swipe me ${t}.` }]);
    if (m === undefined) throw new Error('seed returned nothing');
    return m;
  }

  async function archivedSubjects(): Promise<string[]> {
    const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; specialUse: string | null }[] };
    const archive = mailboxes.find((b) => b.specialUse === 'archive');
    if (archive === undefined) throw new Error('no Archive mailbox');
    const res = await api.get(`/api/mailboxes/${archive.id}/messages?limit=200`);
    return ((await res.json()) as { messages: { subject: string }[] }).messages.map((m) => m.subject);
  }

  test('a left swipe past 40% archives the row, shows the Undo toast, and Undo restores it', async ({ page }) => {
    const m = await seedOne('Swipe archive');
    await page.goto('/');
    const row = rowFor(page, m.subject);
    await expect(row).toBeVisible();

    await drag(row, -0.6);
    await expect(row).toHaveCount(0);
    await expect(toasts(page)).toContainText(`Moved to Archive · ${m.subject}`);
    await expect.poll(async () => (await archivedSubjects()).includes(m.subject)).toBe(true);
    // It did not open: a swipe is not a tap.
    await expect(page).toHaveURL(/\/mail\/inbox\/?$|\/$/);

    await toasts(page).getByRole('button', { name: 'Undo' }).click();
    await expect(rowFor(page, m.subject)).toHaveCount(1);
    await expect.poll(async () => (await archivedSubjects()).includes(m.subject)).toBe(false);
  });

  test('a short drag snaps back and does nothing; a vertical drag is left to the list', async ({ page }) => {
    const m = await seedOne('Swipe short');
    await page.goto('/');
    const row = rowFor(page, m.subject);
    await expect(row).toBeVisible();

    await drag(row, -0.2);
    // Vertical: more down than across from the first move, though its sideways part alone (half the
    // row) would be past the 40% that archives — the list's scroll, not the row's swipe.
    const width = (await row.boundingBox())?.width ?? 0;
    expect(width).toBeGreaterThan(0);
    await drag(row, -0.5, { dy: width * 0.75 });
    await expect(row).toHaveCount(1);
    await expect(row).not.toHaveAttribute('data-swipe', /.+/);
    await expect(toasts(page)).not.toContainText(m.subject);
    expect(await archivedSubjects()).not.toContain(m.subject);
  });

  test('a right swipe past 40% toggles read/unread', async ({ page }) => {
    const m = await seedOne('Swipe read');
    await page.goto('/');
    const row = rowFor(page, m.subject);
    await expect(row).toHaveClass(/pr-mrow--unread/);

    await drag(row, 0.6);
    await expect(row).not.toHaveClass(/pr-mrow--unread/);
    await drag(row, 0.6);
    await expect(row).toHaveClass(/pr-mrow--unread/);
  });

  test('the swipe surfaces are decorative: axe is clean at rest and mid-drag, and the row gains no focus stop', async ({ page }) => {
    const m = await seedOne('Swipe axe');
    await page.goto('/');
    const row = rowFor(page, m.subject);
    await expect(row).toBeVisible();
    await expect(row.locator('button, a, [tabindex]')).toHaveCount(0);

    const check = async (label: string): Promise<void> => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('[role="listbox"]').analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), label).toEqual([]);
    };
    await check('at rest');
    await drag(row, -0.25, { release: false });
    await expect(row).toHaveAttribute('data-swipe', 'reveal-archive');
    await check('revealing Archive');
    await cancelDrag(row);
    await expect(row).not.toHaveAttribute('data-swipe', /.+/);
    await drag(row, 0.25, { release: false });
    await expect(row).toHaveAttribute('data-swipe', 'reveal-read');
    await check('revealing Read');
    await cancelDrag(row);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('the row does not slide, and the action still commits', async ({ page }) => {
      const m = await seedOne('Swipe reduced');
      await page.goto('/');
      const row = rowFor(page, m.subject);
      await expect(row).toBeVisible();

      await drag(row, -0.6, { release: false });
      await expect(row).toHaveAttribute('data-swipe', 'commit-archive');
      const moved = await row.locator('.pr-mrow__inner').evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { translate: string } }).getComputedStyle(el).translate);
      expect(moved === 'none' || moved === '0px' || moved === '0px 0px').toBe(true);
      await cancelDrag(row);

      await drag(row, -0.6);
      await expect(row).toHaveCount(0);
      await expect(toasts(page)).toContainText(`Moved to Archive · ${m.subject}`);
      await toasts(page).getByRole('button', { name: 'Undo' }).click();
      await expect(rowFor(page, m.subject)).toHaveCount(1);
    });
  });
});

// PST-T-16.18 (PST-DA-047, PST-REQ-155, PST-REQ-077): an 844×390 phone is wider than the tablet edge
// (768) but too short for two panes, so SPLIT_QUERY's (min-height: 500px) keeps it on the push
// layout, and its touch pointer is `coarse`, which is what the 44px rules are keyed to.
test.describe(LANDSCAPE_SUITE, () => {
  test.beforeAll(async () => {
    if (cookies.length === 0) {
      operator = await ensureOperator(api);
      cookies = await signInCookies(api, operator);
    }
  });

  test('the Inbox and an open message are the push layout with 44px targets and no sideways scroll', async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 844, height: 390 });
    const t = tag();
    const [msg] = await seedMail(api, [{ subject: `Landscape ${t}`, text: `A body line.\n\n${'x'.repeat(120)}` }]);
    if (msg === undefined) throw new Error('seed returned nothing');

    await page.goto('/');
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeVisible();
    // Push, not split: the stack's own bars, no hamburger drawer, no reading pane beside the list.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(page.getByTestId('context-bar').getByRole('link', { name: 'Mailboxes', exact: true })).toBeVisible();
    await expect(page.getByTestId('list-bar').getByRole('button', { name: 'New message' })).toBeVisible();
    for (const radio of await page.getByRole('radiogroup', { name: 'Show in Inbox' }).getByRole('radio').all()) {
      expect((await radio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await assertMobileFriendly(page, '/ (landscape inbox)');

    await page.goto('/');
    await page.getByRole('option', { name: new RegExp(`Landscape ${t}`) }).click();
    await expect(page.getByRole('heading', { name: msg.subject, level: 2 })).toBeVisible();
    // Opening a message replaces the list (a push), so the list is not beside it.
    await expect(page.getByRole('listbox', { name: 'Messages in Inbox' })).toBeHidden();
    await expect(page.getByRole('group', { name: 'Message actions' })).toBeVisible();
    await assertMobileFriendly(page, `/mail/${msg.mailboxId}/${msg.id} (landscape open message)`);
  });

  test('other screens keep 44px targets and never scroll the page sideways', async ({ page }) => {
    for (const [path, heading] of [
      ['/settings/account', 'Account'],
      ['/settings/security/sessions', 'Security & devices'],
      ['/calendar', 'Calendar'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await assertMobileFriendly(page, `${path} (landscape)`);
    }
  });
});
