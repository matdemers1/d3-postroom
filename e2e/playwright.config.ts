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
    // Reduced motion by default: axe measures colour contrast on whatever frame it lands on, and a
    // badge or sheet caught mid-fade reads as low contrast (a false positive, not the design). Specs
    // that assert motion itself opt back in with page.emulateMedia({ reducedMotion: 'no-preference' }).
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    // PST-T-16.18: a phone on its side. 844 wide clears the tablet edge, 390 tall does not clear the
    // split's (min-height: 500px), so it stays on the push layout; touch makes the pointer coarse.
    // Only mobile.spec runs here: its own landscape suite, since the rest assert portrait geometry.
    { name: 'landscape', testMatch: /mobile\.spec\.ts$/, use: { ...devices['Pixel 7 landscape'], viewport: { width: 844, height: 390 } } },
  ],
});
