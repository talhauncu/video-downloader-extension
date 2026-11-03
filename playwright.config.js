import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  // Each spec launches its own browser with the extension; the projects only split the specs.
  projects: [
    { name: 'chromium', testDir: './test/e2e' },
    { name: 'firefox', testDir: './test/e2e-firefox' },
  ],
});
