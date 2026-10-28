// Browser tests for the admin and settings screens. Run from apps/web:
//   npx playwright test -c e2e/admin/playwright.config.ts
// Headless Chromium with sound muted; the dev server is this suite's own
// (npx vite --port 5175 --strictPort). Screenshots land in e2e/admin/screenshots
// (git ignored), stored sessions in test-results/admin-e2e (deleted at the end).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 3,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../../test-results/admin-e2e-report.json' }]],
  outputDir: '../../test-results/admin-playwright',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: {
    command: 'npx vite --port 5175 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:5175/e2e/admin/harness.html',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
