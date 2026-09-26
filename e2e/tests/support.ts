// Shared state for the auth specs. The suite runs once per Playwright project (desktop, then mobile)
// against ONE stack with ONE fresh database, and setup can happen only once — so the operator's
// credentials, and the last TOTP step used, are kept in a file beside the OS temp dir, keyed by the
// stack's URL. A code is never reused: the server burns every accepted step.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

export interface Operator {
  displayName: string;
  login: string;
  password: string;
  secret: string;
  lastStep: number;
}

const baseUrl = process.env['POSTROOM_URL'] ?? 'http://127.0.0.1:3300';
const file = join(tmpdir(), `postroom-e2e-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}.json`);

export const OPERATOR_DEFAULTS = {
  displayName: 'E2E Operator',
  login: 'operator',
  password: 'e2e operator password 4912',
};

export function loadOperator(): Operator | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Operator;
}

export function saveOperator(operator: Operator): void {
  writeFileSync(file, JSON.stringify(operator), { mode: 0o600 });
}

const PERIOD_MS = 30_000;

/** A code for a step newer than any used before, waiting for the clock if it has to. */
export async function freshCode(operator: Operator): Promise<string> {
  for (;;) {
    const current = Math.floor(Date.now() / PERIOD_MS);
    const step = Math.max(operator.lastStep + 1, current);
    if (step <= current + 1) {
      operator.lastStep = step;
      saveOperator(operator);
      const totp = new TOTP({ secret: Secret.fromBase32(operator.secret), digits: 6, period: 30, algorithm: 'SHA1' });
      return totp.generate({ timestamp: step * PERIOD_MS + 1_000 });
    }
    await new Promise((resolve) => setTimeout(resolve, (current + 1) * PERIOD_MS - Date.now() + 250));
  }
}

/** Below `lg` the sidebar is a drawer behind "Open navigation". */
export async function openNav(page: Page): Promise<void> {
  // A link inside the drawer closes it with an exit animation, and until that ends the top bar is
  // still aria-hidden — so the opener is not found by role, and a check made then wrongly concludes
  // there is no drawer (the wide layout). Wait for a closing drawer to go before asking.
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  if ((await drawer.getAttribute('data-state', { timeout: 100 }).catch(() => null)) === 'open') return;
  await drawer.waitFor({ state: 'detached' });
  const opener = page.getByRole('button', { name: 'Open navigation' });
  if (!(await opener.isVisible())) return;
  await opener.click();
  await drawer.waitFor();
}

export async function signInWithPassword(page: Page, operator: Operator): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Login' }).fill(operator.login);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill(await freshCode(operator));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('heading', { name: 'Mail', level: 1 }).waitFor();
}

const CSRF = { 'x-postroom-csrf': '1' };

/**
 * The operator, creating it over the API when this stack is fresh — so a spec can run on its own,
 * not only after auth.spec.ts has walked the setup screens.
 */
export async function ensureOperator(request: APIRequestContext): Promise<Operator> {
  const state = (await (await request.get('/api/auth/state')).json()) as { setupRequired: boolean };
  if (!state.setupRequired) {
    const operator = loadOperator();
    if (operator === null) throw new Error('this stack already has an operator, but none is recorded here: use a fresh database');
    return operator;
  }
  const setupToken = process.env['E2E_SETUP_TOKEN'];
  const token = setupToken === undefined || setupToken === '' ? {} : { setupToken };
  const begin = await request.post('/api/auth/setup/begin', { headers: CSRF, data: { ...token, ...OPERATOR_DEFAULTS } });
  if (!begin.ok()) throw new Error(`setup/begin answered ${String(begin.status())}`);
  const { enrolToken, secret } = (await begin.json()) as { enrolToken: string; secret: string };
  const operator: Operator = { ...OPERATOR_DEFAULTS, secret, lastStep: 0 };
  saveOperator(operator);
  const complete = await request.post('/api/auth/setup/complete', { headers: CSRF, data: { ...token, enrolToken, code: await freshCode(operator) } });
  if (!complete.ok()) throw new Error(`setup/complete answered ${String(complete.status())}`);
  return operator;
}

/**
 * Signs in over the API (password + TOTP) and returns the session cookies, so a suite signs in
 * once and every test starts already inside the app instead of burning a TOTP step each.
 */
export async function signInCookies(request: APIRequestContext, operator: Operator): Promise<Awaited<ReturnType<BrowserContext['cookies']>>> {
  const first = await request.post('/api/auth/signin', { headers: CSRF, data: { login: operator.login, password: operator.password } });
  if (!first.ok()) throw new Error(`signin answered ${String(first.status())}`);
  const { challenge } = (await first.json()) as { challenge: string };
  const second = await request.post('/api/auth/signin/totp', { headers: CSRF, data: { challenge, code: await freshCode(operator) } });
  if (!second.ok()) throw new Error(`signin/totp answered ${String(second.status())}`);
  return (await request.storageState()).cookies;
}

export interface SeedMessage {
  subject: string;
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  text?: string | null;
  html?: string;
  attachment?: { filename: string; contentType?: string; content: string };
  mailbox?: 'inbox' | 'archive' | 'trash' | 'sent' | 'drafts' | 'junk';
  flags?: ('\\Seen' | '\\Flagged' | '\\Answered')[];
  /** Creates this message's MessageVerdict.auth (PST-T-6.5, PST-REQ-120): spf/dkim/dmarc/arc, the
   * same shape smtp-in stores. Its presence is what makes GET /api/messages/:id compute `phish`. */
  authVerdicts?: Record<string, unknown>;
}

export interface SeededMessage {
  id: string;
  mailboxId: string;
  uid: number;
  subject: string;
  messageIdHeader: string;
}

/**
 * Files synthetic mail into the signed-in operator's mailboxes through the e2e-only
 * POST /api/admin/dev/seed (mounted only with POSTROOM_E2E_SEED=1). `request` must carry the
 * operator's session. Messages are filed in order, so the last one is the newest.
 */
export async function seedMail(request: APIRequestContext, messages: SeedMessage[]): Promise<SeededMessage[]> {
  const res = await request.post('/api/admin/dev/seed', { headers: CSRF, data: { messages } });
  if (res.status() === 404) throw new Error('the stack has no seeding route: start the api with POSTROOM_E2E_SEED=1');
  if (!res.ok()) throw new Error(`seed answered ${String(res.status())}: ${await res.text()}`);
  return ((await res.json()) as { messages: SeededMessage[] }).messages;
}

/** A short random tag, so a test finds its own messages in a mailbox other tests also fill. */
export const tag = (): string => Math.random().toString(36).slice(2, 8);
