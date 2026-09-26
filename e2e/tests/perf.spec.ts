// PST-T-11.3 (PST-REQ-157): "the webmail shall render the first page of a 50,000-message mailbox
// within 1 second on the Zima." This is the browser-level proof, against the operator's own INBOX.
//
// POST /api/admin/dev/seed (the e2e stack's only mail-delivery door) accepts at most 50 messages a
// call and files each one under a row lock — the right shape for a handful of fixtures, not 50,000.
// So this spec shells out to scripts/perf-seed.mjs instead, the same set-based bulk loader the
// doneWhen names, pointed at DATABASE_URL (the e2e stack's database — see docker-compose.e2e.yml
// and this repo's docs/perf.md for how to run this spec on its own). `--force` because the shared
// e2e operator's INBOX may already hold a handful of fixtures from other specs.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ensureOperator, signInCookies, type Operator } from './support.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const PERF_SEED_SCRIPT = fileURLToPath(new URL('../../scripts/perf-seed.mjs', import.meta.url));
const COUNT = 50_000;

let operator: Operator;
let cookies: Awaited<ReturnType<typeof signInCookies>> = [];

test.beforeAll(async ({ playwright }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  const api = await playwright.request.newContext(baseURL === undefined ? {} : { baseURL });
  operator = await ensureOperator(api);
  cookies = await signInCookies(api, operator);
  await api.dispose();

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error("set DATABASE_URL to the e2e stack's database before running perf.spec.ts (see docs/perf.md)");
  }
  execFileSync(process.execPath, [PERF_SEED_SCRIPT, '--account', operator.login, '--count', String(COUNT), '--force'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test('opens the 50k INBOX and the first message row is visible within 1s of navigation', async ({ page }) => {
  const start = Date.now();
  await page.goto('/');
  const list = page.getByRole('listbox', { name: 'Messages in Inbox' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeVisible();
  const elapsedMs = Date.now() - start;
  console.log(`perf.spec: first row visible ${elapsedMs}ms after navigation start`);
  expect(elapsedMs).toBeLessThan(1000);
});
