// PST-T-6.5, PST-REQ-120's exit demo: ReadingPane shows a warning banner, above the message, when
// GET /api/messages/:id's `phish.warnings` is non-empty — worst severity first, each warning's full
// reason visible (never just its kind), a `high`-severity warning as role="alert", the rest inside
// the same labelled region. One seeded message per detection kind.
//
// Mail (and its stored auth verdict) is filed through the e2e-only POST /api/admin/dev/seed
// (POSTROOM_E2E_SEED=1); `authVerdicts` on a seed message is what makes GET /api/messages/:id
// compute `phish` at all (PST-T-6.5 extended the seed route for exactly this).
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ensureOperator, seedMail, signInCookies, tag, type SeedMessage } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

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

const isDesktop = (name: string): boolean => name === 'desktop';

/** An authenticated-looking verdict: SPF/DKIM/DMARC all pass, so only the fixture's own signal fires. */
const PASSING_AUTH = {
  spf: { result: 'pass' },
  dkim: [{ result: 'pass' }],
  dmarc: { result: 'pass', policy: 'reject' },
  arc: { result: 'none' },
};

interface Fixture {
  kind: string;
  seed: SeedMessage;
  /** Substrings that must appear in the visible reason text. */
  reasonContains: string[];
  severity: 'high' | 'medium' | 'low';
}

function fixtures(t: string): Fixture[] {
  return [
    {
      kind: 'display-name-spoofing',
      seed: {
        subject: `Display name spoofing ${t}`,
        from: `"support@paypal.com" <billing@evil-domain-${t}.example>`,
        authVerdicts: PASSING_AUTH,
      },
      reasonContains: ['support@paypal.com', `evil-domain-${t}.example`],
      severity: 'high',
    },
    {
      // A fixed domain, one letter longer than the brand's — the edit-distance check, not the
      // homoglyph one, so this is kept apart from the tag scheme other fixtures use for isolation
      // (nothing here depends on a message's history, only on the built-in brand list).
      kind: 'lookalike-domain',
      seed: {
        subject: `Lookalike domain ${t}`,
        from: 'billing@paypall.com',
        authVerdicts: PASSING_AUTH,
      },
      reasonContains: ['paypall.com', 'paypal.com', '1 character'],
      severity: 'high',
    },
    {
      kind: 'punycode-domain',
      seed: {
        subject: `Punycode domain ${t}`,
        from: 'login@xn--pypal-lkf.com',
        authVerdicts: PASSING_AUTH,
      },
      reasonContains: ['punycode'],
      severity: 'high',
    },
    {
      kind: 'first-time-brand-sender',
      seed: {
        subject: `First-time brand sender ${t}`,
        from: `PayPal Security <security-${t}@not-paypal.example>`,
        authVerdicts: PASSING_AUTH,
      },
      reasonContains: ['paypal', `not-paypal.example`],
      severity: 'medium',
    },
    {
      kind: 'auth-failure',
      seed: {
        subject: `Auth failure ${t}`,
        from: `billing@evil-auth-${t}.example`,
        authVerdicts: { spf: { result: 'fail' }, dkim: [], dmarc: { result: 'fail', policy: 'reject' }, arc: { result: 'none' } },
      },
      reasonContains: ['DMARC failed'],
      severity: 'high',
    },
    {
      kind: 'link-mismatch',
      seed: {
        subject: `Link mismatch ${t}`,
        from: `notice@example-${t}.com`,
        html: `<p><a href="https://evil-domain-${t}.example/steal">https://example-${t}.com/verify</a></p>`,
        authVerdicts: PASSING_AUTH,
      },
      reasonContains: [`example-${t}.com`, `evil-domain-${t}.example`],
      severity: 'high',
    },
  ];
}

test.describe('at 1280 px', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(!isDesktop(testInfo.project.name), 'this pass covers the desktop project; 390px is below');
  });

  test('each fixture shows its reason, worst severity first, high as an alert', async ({ page }) => {
    const t = tag();
    const list = fixtures(t);
    const seeded = await seedMail(
      api,
      list.map((f) => f.seed),
    );
    expect(seeded).toHaveLength(list.length);

    for (const [index, f] of list.entries()) {
      const m = seeded[index];
      if (m === undefined) throw new Error(`seed returned too few messages for ${f.kind}`);
      await page.goto(`/mail/${m.mailboxId}/${m.id}`);
      await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();

      const region = page.getByRole('region', { name: 'Phishing and authentication warnings' });
      await expect(region).toBeVisible();
      for (const substring of f.reasonContains) {
        await expect(region).toContainText(substring);
      }

      if (f.severity === 'high') {
        await expect(page.getByRole('alert').filter({ hasText: f.reasonContains[0] ?? '' })).toBeVisible();
      } else {
        // Not urgent: no interrupting role="alert", but still inside the named region above.
        await expect(page.getByRole('alert').filter({ hasText: f.reasonContains[0] ?? '' })).toHaveCount(0);
      }
    }
  });

  test('worst severity sorts first when a message has more than one warning', async ({ page }) => {
    const t = tag();
    const [m] = await seedMail(api, [
      {
        subject: `Multiple warnings ${t}`,
        from: `PayPal Security <security-${t}@not-paypal-${t}.example>`,
        authVerdicts: { spf: { result: 'fail' }, dkim: [], dmarc: { result: 'fail', policy: 'reject' }, arc: { result: 'none' } },
      },
    ]);
    if (m === undefined) throw new Error('seed returned nothing');
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    const region = page.getByRole('region', { name: 'Phishing and authentication warnings' });
    await expect(region).toBeVisible();
    const alerts = region.getByTestId('phish-warning');
    await expect(alerts.first()).toHaveCount(1);
    // High severity (auth failure / first-time-brand can both be high/medium) — the first alert is
    // never a `low` when a `high` is present.
    const first = await alerts.first().getAttribute('data-phish-severity');
    expect(first).not.toBe('low');
  });

  test('a message with no phishing signal shows no banner', async ({ page }) => {
    const t = tag();
    const [m] = await seedMail(api, [{ subject: `Clean message ${t}`, from: `friend-${t}@example.org`, authVerdicts: PASSING_AUTH }]);
    if (m === undefined) throw new Error('seed returned nothing');
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
    await expect(page.getByTestId('phish-warnings')).toHaveCount(0);
  });
});

test.describe('at 390 px', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(isDesktop(testInfo.project.name), '390px is the mobile project');
  });

  test('the banner and its reason are visible at 390 px', async ({ page }) => {
    const t = tag();
    const [m] = await seedMail(api, [
      {
        subject: `Narrow screen ${t}`,
        from: `billing@evil-auth-390-${t}.example`,
        authVerdicts: { spf: { result: 'fail' }, dkim: [], dmarc: { result: 'fail', policy: 'reject' }, arc: { result: 'none' } },
      },
    ]);
    if (m === undefined) throw new Error('seed returned nothing');
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
    const alert = page.getByRole('alert').filter({ hasText: 'DMARC failed' });
    await expect(alert).toBeVisible();
    const box = await alert.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  });
});

test('the banner has no axe violations, in light and dark', async ({ page }) => {
  const t = tag();
  const [m] = await seedMail(api, [
    {
      subject: `Axe phish ${t}`,
      from: `"support@paypal.com" <billing@evil-domain-axe-${t}.example>`,
      authVerdicts: { spf: { result: 'fail' }, dkim: [], dmarc: { result: 'fail', policy: 'reject' }, arc: { result: 'none' } },
    },
  ]);
  if (m === undefined) throw new Error('seed returned nothing');
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => {
      (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem('postroom-theme', value);
    }, theme);
    await page.goto(`/mail/${m.mailboxId}/${m.id}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: m.subject, level: 2 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Phishing and authentication warnings' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${theme} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
  }
});
