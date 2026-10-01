// PST-T-16.2's test clause, proved in a real browser (the unit environment has no DOM, so
// apps/web/test/unit/pane-boundary.test.ts can only read the source). Each test provokes a real
// throw in the shipped bundle and asserts what the person sees:
//
//   - the reading pane: GET /api/messages/:id/body is answered with a body whose `attachments` holds
//     a null, so AttachmentList throws while rendering. The pane says it stopped working; the
//     message list beside it stays on screen and still opens another message.
//   - the command palette: on /settings/account (no MailView, so Shell's PlacePalette owns ⌘K),
//     GET /api/search is answered with `messages: [null]`; opening the palette and typing makes the
//     Messages group throw. A compact "stopped working" fallback appears and the page stays.
//   - SignIn: nothing the network can send makes SignIn's own render throw (it reads only booleans
//     from AuthState), so the throw is provoked in the one thing it does on mount that can fail —
//     the effect that cleans `?signin_error=` out of the URL with history.replaceState. A browser
//     whose replaceState throws (patched in before the app loads) is a real failure of that effect,
//     and the root boundary shows its alert instead of an empty #root. Try again recovers.
//   - the Inspect drawer: the computed animation of the open drawer is the drawer's ease-out on
//     --motion-drawer, not the modal's overshooting spring.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeededMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

/** A boundary's fallback (PaneBoundary): the Alert titled "<name> stopped working". */
const stopped = (page: Page, name: string) => page.locator('.pr-pane-error').filter({ hasText: `${name} stopped working`.trim() });

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

async function seedTwo(t: string): Promise<[SeededMessage, SeededMessage]> {
  const messages = await seedMail(api, [
    { subject: `Boundary other ${t}`, from: `Other <other-${t}@example.org>`, text: 'The other message.' },
    { subject: `Boundary broken ${t}`, from: `Broken <broken-${t}@example.org>`, text: 'This one is served a malformed body.' },
  ]);
  const [other, broken] = messages;
  if (other === undefined || broken === undefined) throw new Error('seed returned too few messages');
  return [other, broken];
}

test.describe('with a session', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(cookies);
  });

  test('a throw inside ReadingPane still renders the message list', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone shows the list or the reader, never both: the split is the desktop layout');
    const t = tag();
    const [other, broken] = await seedTwo(t);

    // Valid JSON for the body endpoint, but `attachments` holds a null: AttachmentList reads
    // `a.disposition` on it while rendering the reading pane.
    await page.route(`**/api/messages/${broken.id}/body`, async (route) => {
      const real = await route.fetch();
      const body = (await real.json()) as Record<string, unknown>;
      await route.fulfill({ response: real, json: { ...body, attachments: [null] } });
    });

    await page.goto(`/mail/${broken.mailboxId}/${broken.id}`);

    await expect(stopped(page, 'The reading pane')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

    // The list beside it is still there and still usable.
    const list = page.getByRole('listbox', { name: 'Messages in Inbox' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option', { name: new RegExp(`Boundary broken ${t}`) })).toBeVisible();
    // The sidebar and the page are untouched too: nothing fell back to the root's alert.
    await expect(stopped(page, 'Postroom')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    // Opening another message recovers the reader (the boundary resets on the message).
    const next = list.getByRole('option', { name: new RegExp(`Boundary other ${t}`) });
    await next.click();
    await expect(next).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/${other.id}$`));
    // Opening another message is enough: the boundary is keyed on the message it renders, so it
    // resets onto the good one without Try again.
    await expect(page.getByRole('heading', { name: other.subject, level: 2 })).toBeVisible();
    await expect(stopped(page, '')).toHaveCount(0);
    await expect(list).toBeVisible();
  });

  test('a throw inside PlacePalette shows the stopped-working alert, not a blank page', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the palette is the keyboard chord ⌘K / Ctrl+K');

    // Valid JSON for the search endpoint, but a null where a message summary belongs: the palette's
    // Messages group reads `m.mailboxId` on it while rendering.
    await page.route('**/api/search?*', (route) => route.fulfill({ json: { results: [null], messages: [null], nextCursor: null, warnings: [] } }));

    await page.goto('/settings/account');
    await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();

    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await expect(input).toBeVisible();
    await input.fill('hello');

    const alert = stopped(page, 'The command palette');
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The compact fallback replaces only the palette: the settings page and its nav are still there.
    await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(stopped(page, 'Postroom')).toHaveCount(0);
    await expect(stopped(page, 'This page')).toHaveCount(0);
  });

  test('the open Inspect drawer is on the drawer motion, not the modal spring', async ({ browser, isMobile }) => {
    // e2e runs reduced-motion by default (the drawer then fades); this one asserts the real motion.
    const context = await browser.newContext({ reducedMotion: 'no-preference', viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
    try {
      await context.addCookies(cookies);
      const page = await context.newPage();
      const t = tag();
      const [, m] = await seedTwo(t);
      await page.goto(`/mail/${m.mailboxId}/${m.id}`);
      await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
      await page.getByRole('heading', { name: m.subject, level: 2 }).focus();
      await page.keyboard.press('i');
      const drawer = page.getByRole('dialog', { name: 'Inspect message' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId('inspect-body')).toBeVisible();

      const style = await drawer.evaluate((el) => {
        const s = (globalThis as unknown as { getComputedStyle(e: unknown): { animationName: string; animationTimingFunction: string; animationDuration: string } }).getComputedStyle(el);
        return { name: s.animationName, timing: s.animationTimingFunction, duration: s.animationDuration };
      });
      expect(style.name).toContain('pr-inspect-in');
      // Not the spring: no overshooting cubic-bezier (a control-point y above 1 or below 0) and no
      // linear() easing curve — the drawer's own is a plain ease-out.
      expect(style.timing).not.toContain('linear(');
      for (const match of style.timing.matchAll(/cubic-bezier\(([^)]*)\)/g)) {
        const ys = (match[1] ?? '').split(',').map((n: string) => Number(n.trim()));
        expect(Math.max(ys[1] ?? 0, ys[3] ?? 0), `overshoot in ${style.timing}`).toBeLessThanOrEqual(1);
        expect(Math.min(ys[1] ?? 0, ys[3] ?? 0), `undershoot in ${style.timing}`).toBeGreaterThanOrEqual(0);
      }
      expect(style.timing).toMatch(/^ease-out$|^cubic-bezier\(/);
      const ms = style.duration.endsWith('ms') ? parseFloat(style.duration) : parseFloat(style.duration) * 1000;
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(280);
    } finally {
      await context.close();
    }
  });
});

test('a throw inside SignIn shows the stopped-working alert instead of an empty #root', async ({ browser, isMobile }) => {
  // A fresh context: no session cookies, so /signin is the sign-in screen.
  const context = await browser.newContext({ viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  try {
    const page: Page = await context.newPage();
    // SignIn's mount effect cleans ?signin_error= out of the URL with history.replaceState('/signin').
    // Make that one call fail, as it would in a browser that refuses it; everything else (the
    // router's own replaceState calls) is left alone. The flag lets the test mend it for Try again.
    await page.addInitScript(() => {
      interface HistoryLike {
        prototype: { replaceState: (this: unknown, data: unknown, unused: string, url?: string | null) => void };
      }
      const g = globalThis as unknown as { __failCleanUrl: boolean; History: HistoryLike };
      g.__failCleanUrl = true;
      const original = g.History.prototype.replaceState;
      g.History.prototype.replaceState = function (this: unknown, data: unknown, unused: string, url?: string | null) {
        if (g.__failCleanUrl && url === '/signin') throw new Error('replaceState refused');
        original.call(this, data, unused, url);
      };
    });

    await page.goto('/signin?signin_error=denied');

    const alert = stopped(page, 'Postroom');
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(page.locator('#root')).not.toBeEmpty();
    // The sign-in form is what failed; it is not on screen.
    await expect(page.getByRole('textbox', { name: 'Address or username' })).toHaveCount(0);

    // Mend the browser, press Try again: the screen comes back and shows why the sign-in was refused.
    await page.evaluate(() => {
      (globalThis as unknown as { __failCleanUrl: boolean }).__failCleanUrl = false;
    });
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('textbox', { name: 'Address or username' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Sign-in failed' })).toContainText('denied');
  } finally {
    await context.close();
  }
});
