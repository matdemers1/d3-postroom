// PST-DA-044: the Keys screen's "Your keys" and "Contacts' keys" tables, empty, used to show a
// doubled caption (the Section's own title, plus the Table's own visible caption saying the same
// thing) and a full column header floating over nothing, with no way forward. Empty now means one
// caption (the Section heading), no table header, and — for "Your keys" — a Generate action.
//
// "Your keys" cannot be reliably forced empty here: DELETE /api/keys/:id refuses an owner: 'own'
// row with 409 ("revoked, never deleted") by design (mail already encrypted to it must still open),
// so once any spec generates one for the shared e2e account it stays for the life of the database.
// This asserts the empty case when the account happens to hold none yet, and otherwise still checks
// the populated list never doubles its caption (the same fix, the other branch). PST-T-15.6: the
// keys are rows of a DataList in the 680px settings column now, not a seven-column table — so there
// is no table and no column header in either branch, and the list is named by an aria-label rather
// than a second visible caption.
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, signInCookies } from './support.js';

const CSRF = { 'x-postroom-csrf': '1' };

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

test('empty is one caption, no table header, and Generate reaches the form', async ({ page }) => {
  const { keys } = (await (await api.get('/api/keys')).json()) as { keys: { id: string; owner: 'own' | 'contact' }[] };
  // Contacts' keys are genuinely deletable — force that table empty.
  for (const k of keys.filter((row) => row.owner === 'contact')) await api.delete(`/api/keys/${k.id}`, { headers: CSRF });
  const ownKeysExist = keys.some((row) => row.owner === 'own');

  await page.goto('/settings/keys');
  await expect(page.getByRole('heading', { name: 'Keys', level: 1 })).toBeVisible();

  // "Contacts' keys" is always forced empty: one caption (the Section heading), no header, an
  // EmptyState with no doubled Table caption.
  await expect(page.getByText('Contacts’ keys', { exact: true })).toHaveCount(1);
  await expect(page.getByText('No contacts’ keys yet')).toBeVisible();

  if (!ownKeysExist) {
    // The genuinely-empty case: one "Your keys" text (the Section heading), no header, an
    // EmptyState with a Generate action that reaches the generate form.
    await expect(page.getByText('Your keys', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByText('No keys of your own yet')).toBeVisible();

    const addressField = page.getByRole('textbox', { name: 'Address', exact: true });
    await page.getByRole('button', { name: 'Generate a key' }).click();
    await expect(addressField).toBeFocused();
    // Prefilled from the mail context with the account's own address — a key can be made only for
    // one of the account's own addresses.
    await expect(addressField).not.toHaveValue('');
    await page.getByRole('button', { name: 'Generate key' }).click();
  }

  // Either freshly generated above, or already there from an earlier spec: "Your keys" now has a
  // row, in a list named by aria-label — one visible "Your keys" (the Section heading), no table.
  const ownList = page.getByRole('list', { name: 'Your keys' });
  await expect(ownList).toBeVisible();
  await expect(ownList.getByRole('listitem').first()).toBeVisible();
  await expect(page.getByText('Your keys', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('columnheader')).toHaveCount(0);
});
  expect(captionArea, 'the Table caption is captionHidden (visually hidden), not a second on-screen "Your keys"').toBeLessThan(4);
});
