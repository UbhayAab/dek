// Smoke test of a DEPLOYED build (preview or production) against the live backend,
// with QA accounts only. No local server: SMOKE_URL picks the site.
//   SMOKE_URL=https://rebuild.dek-7o4.pages.dev npx playwright test -c e2e/smoke/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  outputDir: join(tmpdir(), 'dek-smoke-results'),
  reporter: [['list']],
  use: {
    baseURL: process.env.SMOKE_URL ?? 'https://rebuild.dek-7o4.pages.dev',
    headless: true,
    launchOptions: { args: ['--mute-audio'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
