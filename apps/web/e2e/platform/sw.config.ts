// Service worker tests need the built app (the dev server has no sw.js). Build
// first (vite build && node scripts/build-sw.mjs), then from apps/web:
//   npx playwright test -c e2e/platform/sw.config.ts
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /sw\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4179',
    headless: true,
    // Full Chromium in new headless mode: the headless shell refuses the
    // notification permission and crashes on a push it cannot show.
    channel: 'chromium',
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4179 --strictPort',
    cwd: join(here, '..', '..'),
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
