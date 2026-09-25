import { defineConfig, devices } from '@playwright/test';

// Runs against a live stack (CI boots it with docker compose), never a dev server: the exit demo
// is a property of the deployed thing. POSTROOM_URL points at the api (which serves the web app).
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env['POSTROOM_URL'] ?? 'http://127.0.0.1:3300',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
