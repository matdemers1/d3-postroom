// PST-T-8.5's exit demo, as a suite (PST-REQ-136, PST-REQ-137): a weekly event made in the UI
// shows on the right days in the month and week views (and in the 390 px agenda), a contact added
// in the UI is listed, and both screens are axe-clean in light and dark. That a web edit reaches an
// iPhone is apps/api's integration test (the edit is a change in the DAV store's sync log).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, signInCookies, tag } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const CSRF = { 'x-postroom-csrf': '1' };

let api: APIRequestContext;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
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

const pad = (n: number): string => String(n).padStart(2, '0');
const day = (d: Date): string => `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The first Monday of a month some years out, so no other spec's events share its weeks. */
function firstMonday(): { monday: string; wednesday: string; days: string[] } {
  const year = 2031 + Math.floor(Math.random() * 40);
  const month = Math.floor(Math.random() * 12);
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (8 - first.getUTCDay()) % 7; // days to the first Monday
  const monday = new Date(Date.UTC(year, month, 1 + offset));
  const days = [0, 2, 7, 9, 14, 16].map((n) => day(new Date(monday.getTime() + n * 86_400_000)));
  return { monday: days[0] ?? '', wednesday: days[1] ?? '', days };
}

async function choose(page: Page, scope: ReturnType<Page['getByRole']>, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The data-day of the month-grid cell (or week column) holding each chip with this title. */
async function daysOf(page: Page, title: string): Promise<string[]> {
  const chips = page.getByRole('button', { name: new RegExp(`^${title},`) });
  // The e2e project has no DOM lib: describe the few element methods used, structurally.
  interface El {
    closest(selector: string): El | null;
    matches(selector: string): boolean;
    querySelector(selector: string): El | null;
    getAttribute(name: string): string | null;
  }
  return chips.evaluateAll((els: El[]): string[] =>
    els.map((el) => {
      const cell = el.closest('td, .pr-cal-week__col');
      const marker = cell?.matches('[data-day]') === true ? cell : cell?.querySelector('[data-day]');
      return marker?.getAttribute('data-day') ?? '';
    }),
  );
}

test('a weekly Mon/Wed event made in the UI lands on the right days, in month and week views', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the grid views are desktop; the 390 px agenda has its own test');
  const t = tag();
  const title = `Standup ${t}`;
  const { monday, wednesday, days } = firstMonday();

  await page.goto(`/calendar?view=month&date=${monday}`);
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New event' }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
  await dialog.getByLabel('Start date').fill(monday);
  await dialog.getByLabel('Start time').fill('09:00');
  await dialog.getByLabel('End date').fill(monday);
  await dialog.getByLabel('End time').fill('09:30');
  await choose(page, dialog, 'Repeat', 'Weekly');
  // The start's weekday (Monday) is ticked for you; add Wednesday.
  await expect(dialog.getByRole('checkbox', { name: 'Monday' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Wednesday' }).click();
  await choose(page, dialog, 'Series ends', 'After a number of times');
  await dialog.getByRole('spinbutton', { name: 'Times' }).fill('6');
  await expect(dialog.getByText('Every week on Mon, Wed, 6 times')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create event' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Added “${title}”.`)).toBeVisible();

  // Month view: exactly the six days — three Mondays and three Wednesdays.
  await expect(page.getByRole('button', { name: new RegExp(`^${title},`) })).toHaveCount(6);
  expect((await daysOf(page, title)).sort()).toEqual([...days].sort());

  // Week view of that week: Monday and Wednesday, nothing else.
  await page.getByRole('radio', { name: 'Week' }).or(page.getByRole('tab', { name: 'Week' })).or(page.getByRole('button', { name: 'Week', exact: true })).first().click();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.getByRole('button', { name: new RegExp(`^${title},`) })).toHaveCount(2);
  expect((await daysOf(page, title)).sort()).toEqual([monday, wednesday]);

  // Editing one instance moves only that one.
  await page.getByRole('button', { name: new RegExp(`^${title},`) }).nth(1).click();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await expect(edit.getByRole('textbox', { name: 'Title' })).toHaveValue(title);
  await edit.getByRole('textbox', { name: 'Title' }).fill(`${title} moved`);
  await edit.getByLabel('Start time').fill('11:00');
  await edit.getByLabel('End time').fill('11:30');
  await edit.getByRole('button', { name: 'Save event' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole('button', { name: new RegExp(`^${title} moved,`) })).toHaveCount(1);
  await expect(page.getByRole('button', { name: new RegExp(`^${title},`) })).toHaveCount(1);
  expect(await daysOf(page, `${title} moved`)).toEqual([wednesday]);

  // Keyboard: j moves to the next week, which still has its Monday and Wednesday.
  await page.locator('body').press('j');
  await expect(page.getByRole('button', { name: new RegExp(`^${title},`) })).toHaveCount(2);
});

test('at 390 px the calendar is an agenda list', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the agenda is the phone layout');
  const t = tag();
  const title = `Agenda ${t}`;
  const { monday } = firstMonday();
  const cals = (await (await api.get('/api/calendar/calendars')).json()) as { calendars: { id: string; canHoldEvents: boolean }[] };
  const calendarId = cals.calendars.find((c) => c.canHoldEvents)?.id ?? '';
  const made = await api.post(`/api/calendar/calendars/${calendarId}/events`, {
    headers: CSRF,
    data: { summary: title, start: `${monday}T09:00`, end: `${monday}T10:00`, timezone: 'UTC', recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'], count: 4 } },
  });
  expect(made.status()).toBe(201);
  await page.goto(`/calendar?view=month&date=${monday}`);
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(4);
  await expect(page.locator('table.pr-cal-month')).toHaveCount(0);
});

test('at 390 px an agenda time is two short lines, and the week strip jumps to a day (PST-T-16.11)', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the agenda and the week strip are the phone layout');
  const title = `Strip ${tag()}`;
  const { monday, wednesday } = firstMonday();
  const cals = (await (await api.get('/api/calendar/calendars')).json()) as { calendars: { id: string; canHoldEvents: boolean }[] };
  const calendarId = cals.calendars.find((c) => c.canHoldEvents)?.id ?? '';
  const made = await api.post(`/api/calendar/calendars/${calendarId}/events`, {
    headers: CSRF,
    data: { summary: title, start: `${monday}T09:00`, end: `${monday}T10:30`, timezone: 'UTC', recurrence: { freq: 'WEEKLY', byDay: ['MO', 'WE'], count: 4 } },
  });
  expect(made.status()).toBe(201);
  await page.goto(`/calendar?view=month&date=${monday}`);
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();

  // The time column is at most 4.5rem (72 px at the default root size) and each of its two lines
  // is one line tall: a wrapped line would be about twice as tall as the other.
  const time = page.locator('.pr-cal-agenda__event', { hasText: title }).first().locator('.pr-cal-agenda__time');
  const column = await time.boundingBox();
  expect(column?.width ?? Infinity).toBeLessThanOrEqual(72);
  const lines = time.locator('.pr-cal-agenda__line');
  await expect(lines).toHaveCount(2);
  const first = await lines.nth(0).boundingBox();
  const second = await lines.nth(1).boundingBox();
  expect(first?.width ?? Infinity).toBeLessThanOrEqual(72);
  expect(second?.width ?? Infinity).toBeLessThanOrEqual(72);
  expect(first?.height ?? Infinity).toBeLessThan(24);
  expect(second?.height ?? Infinity).toBeLessThan(24);
  expect(Math.abs((first?.height ?? 0) - (second?.height ?? 99))).toBeLessThan(2);
  expect(column?.height ?? Infinity).toBeLessThan(2 * 24 + 4);

  // One row of seven days, dots on the two with this event, and no horizontal scroll.
  const days = page.locator('.pr-cal-strip__day');
  await expect(days).toHaveCount(7);
  const tops = await days.evaluateAll((els: { getBoundingClientRect(): { top: number } }[]) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(page.locator(`.pr-cal-strip__day[data-events='true']`)).toHaveCount(2);
  await expect(page.locator(`.pr-cal-strip__day[data-day='${monday}']`)).toHaveAttribute('data-events', 'true');

  // A tap jumps to that day.
  await page.locator(`.pr-cal-strip__day[data-day='${wednesday}']`).click();
  await expect(page).toHaveURL(new RegExp(`view=day&date=${wednesday}`));
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(1);
  await expect(page.locator(`.pr-cal-strip__day[data-day='${wednesday}']`)).toHaveAttribute('aria-pressed', 'true');
});

test('month cells are quiet outside the month, chips lead with the title, and "N more" is a small button (PST-T-16.11)', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the month grid is desktop');
  const t = tag();
  // October has 31 days, so its grid always has days that belong to September or November.
  const year = 2031 + Math.floor(Math.random() * 40);
  const first = new Date(Date.UTC(year, 9, 1));
  const monday = day(new Date(Date.UTC(year, 9, 1 + ((8 - first.getUTCDay()) % 7))));
  const cals = (await (await api.get('/api/calendar/calendars')).json()) as { calendars: { id: string; canHoldEvents: boolean }[] };
  const calendarId = cals.calendars.find((c) => c.canHoldEvents)?.id ?? '';
  for (const n of [1, 2, 3, 4]) {
    const made = await api.post(`/api/calendar/calendars/${calendarId}/events`, {
      headers: CSRF,
      data: { summary: `Chip ${String(n)} ${t}`, start: `${monday}T${String(n + 10)}:00`, end: `${monday}T${String(n + 10)}:30`, timezone: 'UTC' },
    });
    expect(made.status()).toBe(201);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/calendar?view=month&date=${monday}`);
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  const grid = page.locator('table.pr-cal-month');
  await expect(grid).toBeVisible();

  // Out-of-month cells: no fill, and a day number fainter than an in-month one.
  const outside = grid.locator("td[data-outside='true']").first();
  const inside = grid.locator('td:not([data-outside])').first();
  await expect(outside).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const faint = await outside.evaluate((node: { ownerDocument: { createElement(tag: string): { style: { color: string }; remove(): void }; body: { append(el: unknown): void } } }) => {
    const probe = node.ownerDocument.createElement('span');
    probe.style.color = 'var(--color-fg-faint)';
    node.ownerDocument.body.append(probe);
    const color = (globalThis as unknown as { getComputedStyle(el: unknown): { color: string } }).getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(outside.locator('.pr-cal-daynum')).toHaveCSS('color', faint);
  await expect(inside.locator('.pr-cal-daynum')).not.toHaveCSS('color', faint);

  // Chips lead with the title, and the time follows it while the cell is wide enough.
  const chip = page.locator('.pr-cal-chip', { hasText: t }).first();
  await expect(chip.locator('> span').first()).toHaveClass(/pr-cal-chip__title/);
  await expect(chip.locator('.pr-cal-chip__time')).toBeVisible();

  // "N more" is a small design-system Button, not bare text: four events show two chips and "2 more".
  const more = page.getByRole('button', { name: '2 more' });
  await expect(more).toHaveClass(/d3-btn/);
  expect((await more.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(32);

  // Narrow the cells (still above the phone breakpoint) and the time is dropped, the title kept.
  // Still a month grid (the grid needs 768px, PST-T-16.18), but cells narrower than the 7rem at which
  // a chip drops its time.
  await page.setViewportSize({ width: 780, height: 1000 });
  await expect(chip.locator('.pr-cal-chip__time')).toBeHidden();
  await expect(chip.locator('.pr-cal-chip__title')).toBeVisible();
});

test('closing an event editor with unsaved changes asks before discarding (PST-T-16.22)', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor modal is exercised on desktop');
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New event' }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create event' })).toBeVisible();
  // The zone is in words, and a one-off event has no Repeat helper echoing "Does not repeat".
  await expect(dialog.getByText(/^Times are in .+\.$/)).not.toContainText('/');
  // The Repeat select shows it once. Inside a <form> the select also renders a hidden native <select>
  // (aria-hidden, for form submission) whose <option> carries the same words, so that one is not
  // counted; any other element saying it — a helper echoing the choice — is.
  const repeat = dialog.getByRole('combobox', { name: 'Repeat' });
  await expect(repeat).toContainText('Does not repeat');
  await expect(repeat).not.toHaveAccessibleDescription(/Does not repeat/);
  await expect(dialog.getByText('Does not repeat', { exact: true }).and(dialog.locator(':not(option)'))).toHaveCount(1);

  // Untouched: Cancel closes at once.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Edited: closing asks first. Keep editing returns to the form with the edit intact.
  await page.getByRole('button', { name: 'New event' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Title' }).fill(`Unsaved ${tag()}`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard changes to this event?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(/^Unsaved /);

  // Discard closes the editor.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Discard' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeHidden();
});

test('a contact added in the UI is listed', async ({ page, isMobile }) => {
  const t = tag();
  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New contact' }).click();
  await expect(page).toHaveURL(/\/contacts\/new$/);
  await page.getByRole('textbox', { name: 'First name' }).fill('Ada');
  await page.getByRole('textbox', { name: 'Last name' }).fill(`Lovelace ${t}`);
  await page.getByRole('textbox', { name: 'Email 1' }).fill(`ada.${t}@example.org`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Contact added.')).toBeVisible();
  await expect(page.getByRole('heading', { name: `Ada Lovelace ${t}` })).toBeVisible();
  if (isMobile) await page.getByRole('link', { name: 'All contacts' }).click();
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill(t);
  await expect(page.getByRole('link', { name: `Ada Lovelace ${t}` })).toBeVisible();

  // The same card is what a CardDAV client syncs: the API lists it with its address.
  const listed = (await (await api.get(`/api/contacts?q=${t}`)).json()) as { contacts: { displayName: string; emails: string[] }[] };
  expect(listed.contacts).toEqual([expect.objectContaining({ displayName: `Ada Lovelace ${t}`, emails: [`ada.${t}@example.org`] })]);
});

test('calendar and contacts have no axe violations, in light and dark', async ({ page, isMobile }) => {
  const { monday } = firstMonday();
  const views = isMobile ? [`/calendar?view=month&date=${monday}`] : [`/calendar?view=month&date=${monday}`, `/calendar?view=week&date=${monday}`, `/calendar?view=day&date=${monday}`];
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    for (const url of [...views, '/contacts']) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${theme} ${url} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    }
    if (!isMobile) {
      await page.goto(`/calendar?view=month&date=${monday}`);
      await page.getByRole('button', { name: 'New event' }).click();
      await expect(page.getByRole('dialog', { name: 'New event' })).toBeVisible();
      await page.getByRole('dialog').getByRole('combobox', { name: 'Repeat' }).click();
      await page.getByRole('option', { name: 'Weekly', exact: true }).click();
      // The select's list animates closed; axe it once it has gone, not mid-fade.
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'Monday' })).toBeVisible();
      const dialog = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(dialog.violations.map((v) => `${theme} event dialog ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
    }
  }
});
