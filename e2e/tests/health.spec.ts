import { expect, test } from '@playwright/test';

test('the api answers /health with its revision', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { status: string; revision: string };
  expect(body.status).toBe('ok');
  expect(body.revision.length).toBeGreaterThan(0);
});
