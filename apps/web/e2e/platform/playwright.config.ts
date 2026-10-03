// Platform end-to-end tests against the live project (QA world from
// tools/seed-qa.mjs). Headless and muted. Run from apps/web:
//   npx playwright test -c e2e/platform/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  testIgnore: /sw\.spec\.ts$/,   // needs the built app: sw.config.ts
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    launchOptions: { args: ['--mute-audio'] },
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev',
    cwd: join(here, '..', '..'),
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
