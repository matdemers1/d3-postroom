// PST-T-15.11 (PST-REQ-195, PST-ADR-013): attachments in the composer. Attach files (the canvas's
// paperclip) opens a multi-file picker; each file uploads with progress and shows as a chip under
// the body; the draft keeps it — saved, closed and opened again from Drafts, the chip is back; Send
// carries it as a MIME attachment, so the Sent copy lists it and its download is the same bytes. A
// file past the limit (GET /api/compose/limits) is refused in the browser, before any request. The
// composer with a chip is axe-clean in both themes. On a phone the same Attach sits in the sheet's
// bar and the chip's controls are 44 px targets.
//
// Like compose.spec.ts: sending needs DKIM keys (asked for through the e2e-only
// POST /api/compose/dev/dkim-keys), the example.org recipient is un-suppressed first, and what this
// suite sends is cancelled on the outbound queue straight away, so no bounce lands in the shared Inbox.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { clearSuppressions, ensureOperator, signInCookies, tag } from './support.js';

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
  if (outbound.length > 0) await cancelOutbound(outbound);
  await api.dispose();
});

test.beforeEach(async ({ context }) => {
  await clearSuppressions(api);
  await context.addCookies(cookies);
  // A send goes at once: the undo window is its own spec's subject.
  await context.addInitScript({ content: "window.localStorage.setItem('postroom.undoSeconds', '0');" });
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => (globalThis as unknown as { document: { getAnimations: () => { playState: string }[] } }).document.getAnimations().every((a) => a.playState !== 'running'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function mailboxIds(): Promise<Record<string, string>> {
  const { mailboxes } = (await (await api.get('/api/mailboxes')).json()) as { mailboxes: { id: string; specialUse: string | null }[] };
  const out: Record<string, string> = {};
  for (const m of mailboxes) if (m.specialUse !== null) out[m.specialUse] = m.id;
  return out;
}

async function messagesIn(mailboxId: string): Promise<{ id: string; subject: string | null }[]> {
  const res = await api.get(`/api/mailboxes/${mailboxId}/messages?limit=200`);
  return ((await res.json()) as { messages: { id: string; subject: string | null }[] }).messages;
}

async function remember(subject: string): Promise<void> {
  const res = await api.get('/api/messages/outbound?limit=100');
  const body = (await res.json()) as { messages: { id: string; subject: string | null }[] };
  const found = body.messages.find((m) => m.subject === subject);
  if (found !== undefined) {
    outbound.push(found.id);
    await cancelOutbound([found.id]);
  }
}

/** Attach files through the paperclip: the button opens the picker, the picker is given the files. */
async function attach(page: Page, composer: Locator, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await composer.getByRole('button', { name: 'Attach files', exact: true }).click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles(files);
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the three-pane composer; the phone sheet has its own test below');

  test('doneWhen: attach → the draft keeps it → reopen shows the chip → Send → the Sent copy has it, byte for byte; axe-clean with a chip in both themes', async ({ page, context }) => {
    const t = tag();
    const subject = `Campsite map ${t}`;
    const filename = `site map ${t}.txt`;
    const bytes = Buffer.from(`Loop B, site 22 — ${t}\nwater at the north end\n`, 'utf8');

    await page.goto('/?compose=new');
    const fresh = page.getByRole('region', { name: 'New message' });
    await expect(fresh).toBeVisible();
    await fresh.getByRole('combobox', { name: 'To' }).fill('alice@example.org');
    await fresh.getByRole('combobox', { name: 'To' }).press('Enter');
    await fresh.getByRole('textbox', { name: 'Subject' }).fill(subject);
    await fresh.getByRole('textbox', { name: 'Message' }).fill(`The map is attached ${t}.`);

    // The upload is a raw body with the name in X-Postroom-Filename, answered 201 with the upload.
    const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/compose/uploads') && r.request().method() === 'POST');
    await attach(page, fresh, [{ name: filename, mimeType: 'text/plain', buffer: bytes }]);
    const answer = await uploaded;
    expect(answer.status()).toBe(201);
    expect(answer.request().headers()['x-postroom-filename']).toBe(encodeURIComponent(filename));
    expect(answer.request().headers()['x-postroom-csrf']).toBe('1');

    const chips = fresh.getByRole('list', { name: 'Attachments' });
    const chip = chips.getByRole('listitem').filter({ hasText: filename });
    await expect(chip).toHaveAttribute('data-state', 'done');
    await expect(chip).toContainText(`${String(bytes.length)} B`);
    await expect(chip.getByRole('button', { name: `Remove ${filename}` })).toBeVisible();
    await expect(fresh.getByTestId('compose-attachment-announce')).toHaveText(`${filename} attached.`);
    await expectNoAxeViolations(page, 'composer with a chip (light)');

    // The draft keeps it: autosaved, then closed (Close keeps the draft).
    await expect(fresh.getByTestId('compose-status')).toContainText('Draft saved', { timeout: 15_000 });
    await expect(page).toHaveURL(/\?compose=draft&id=[0-9a-f-]{36}$/);
    await fresh.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(fresh).toBeHidden();
    const ids = await mailboxIds();
    let draftId = '';
    await expect
      .poll(async () => {
        draftId = (await messagesIn(ids['drafts'] ?? '')).find((m) => m.subject === subject)?.id ?? '';
        return draftId;
      })
      .not.toBe('');
    const saved = (await (await api.get(`/api/compose/drafts/${draftId}`)).json()) as { attachments?: { filename: string; size: number }[] };
    expect(saved.attachments?.map((a) => [a.filename, a.size])).toEqual([[filename, bytes.length]]);

    // Reopened from Drafts — in the dark theme this time — the chip is back, and still axe-clean.
    await context.addInitScript({ content: "window.localStorage.setItem('postroom-theme', 'dark');" });
    await page.goto(`/?compose=draft&id=${draftId}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const resumed = page.getByRole('region', { name: 'New message' });
    await expect(resumed.getByRole('textbox', { name: 'Subject' })).toHaveValue(subject);
    const back = resumed.getByRole('list', { name: 'Attachments' }).getByRole('listitem').filter({ hasText: filename });
    await expect(back).toHaveAttribute('data-state', 'done');
    await expectNoAxeViolations(page, 'resumed draft with a chip (dark)');

    // Send: it goes as a MIME attachment of the message.
    await resumed.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(resumed).toBeHidden();
    await remember(subject);
    await expect.poll(async () => (await messagesIn(ids['drafts'] ?? '')).some((m) => m.subject === subject)).toBe(false);

    // The Sent copy lists it, and its download is the same bytes.
    let sentId = '';
    await expect
      .poll(async () => {
        sentId = (await messagesIn(ids['sent'] ?? '')).find((m) => m.subject === subject)?.id ?? '';
        return sentId;
      })
      .not.toBe('');
    await page.goto(`/mail/${ids['sent'] ?? ''}/${sentId}`);
    await expect(page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
    const card = page.getByTestId('attachment').filter({ hasText: filename });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('aria-label', new RegExp(`^Download ${escape(filename)}, `));
    const href = await card.getAttribute('href');
    expect(href).toMatch(/^\/api\/messages\/[0-9a-f-]{36}\/attachments\//);
    const download = await api.get(href ?? '');
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(bytes)).toBe(true);
    const raw = await (await api.get(`/api/messages/${sentId}/raw`)).text();
    expect(raw).toMatch(/Content-Disposition: attachment/i);
  });

  test('a file past the limit is refused in the browser, before any upload; Remove takes a chip away', async ({ page }) => {
    const limits = (await (await api.get('/api/compose/limits')).json()) as { maxAttachmentBytes: number; maxAttachments: number };
    expect(limits.maxAttachmentBytes).toBeGreaterThan(0);
    let uploads = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/compose/uploads') && r.method() === 'POST') uploads += 1;
    });

    await page.goto('/?compose=new');
    const fresh = page.getByRole('region', { name: 'New message' });
    await expect(fresh).toBeVisible();
    await attach(page, fresh, [{ name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(limits.maxAttachmentBytes + 1) }]);
    // A polite status (a warning Alert), naming the file, the reason and the limit.
    const refusal = fresh.getByRole('status').filter({ hasText: 'too-big.bin' });
    await expect(refusal).toContainText('more than the');
    await expect(refusal).toContainText('so it was not attached');
    await expect(fresh.getByRole('list', { name: 'Attachments' })).toHaveCount(0);
    expect(uploads).toBe(0);

    // A small one attaches; Remove takes it away again, and focus goes back to Attach files.
    await attach(page, fresh, [{ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('small') }]);
    const chip = fresh.getByRole('list', { name: 'Attachments' }).getByRole('listitem').filter({ hasText: 'small.txt' });
    await expect(chip).toHaveAttribute('data-state', 'done');
    expect(uploads).toBe(1);
    const remove = chip.getByRole('button', { name: 'Remove small.txt' });
    const box = await remove.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    await remove.click();
    await expect(fresh.getByRole('list', { name: 'Attachments' })).toHaveCount(0);
    await expect(fresh.getByRole('button', { name: 'Attach files', exact: true })).toBeFocused();

    // Tidy up: to Trash, if it was saved at all.
    await fresh.getByRole('button', { name: 'Discard draft' }).click();
    await expect(fresh).toBeHidden();
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'the phone sheet');

  test('the sheet has Attach files in its bar; a chip spans the width with 44 px controls; axe-clean', async ({ page }) => {
    await page.goto('/?compose=new');
    const sheet = page.getByRole('region', { name: 'New message' });
    await expect(sheet).toBeVisible();
    const attachButton = sheet.getByRole('button', { name: 'Attach files', exact: true });
    await expect(attachButton).toBeVisible();
    const attachBox = await attachButton.boundingBox();
    expect(attachBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(attachBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await attach(page, sheet, [{ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') }]);
    const chip = sheet.getByRole('list', { name: 'Attachments' }).getByRole('listitem').filter({ hasText: 'receipt.pdf' });
    await expect(chip).toHaveAttribute('data-state', 'done');
    const chipBox = await chip.boundingBox();
    expect(chipBox?.width ?? 0).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
    const removeBox = await chip.getByRole('button', { name: 'Remove receipt.pdf' }).boundingBox();
    expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoAxeViolations(page, 'phone sheet with a chip');

    await chip.getByRole('button', { name: 'Remove receipt.pdf' }).click();
    await expect(sheet.getByRole('list', { name: 'Attachments' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Discard draft' }).click();
    await expect(sheet).toBeHidden();
  });
});
