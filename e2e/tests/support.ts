// Shared state for the auth specs. The suite runs once per Playwright project (desktop, then mobile)
// against ONE stack with ONE fresh database, and setup can happen only once — so the operator's
// credentials, and the last TOTP step used, are kept in a file beside the OS temp dir, keyed by the
// stack's URL. A code is never reused: the server burns every accepted step.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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
  const opener = page.getByRole('button', { name: 'Open navigation' });
  if (await opener.isVisible()) await opener.click();
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
