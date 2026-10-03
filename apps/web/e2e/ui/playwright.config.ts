// UI journeys and geometry audits for the shell, conversation, views and search.
// Run from apps/web:  npx playwright test -c e2e/ui/playwright.config.ts
// Own dev server on 5174 (never the lead's 5173); headless and muted.
import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One worker: the QA accounts are shared and auth is rate limited.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  // Outside the shared test-results folder: other builders' runs clear it.
  outputDir: join(tmpdir(), 'dek-ui-e2e'),
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: {
    command: 'npx vite --port 5174 --strictPort --host 127.0.0.1',
    cwd: '../..',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    { name: 'phone-light', use: { ...phone, colorScheme: 'light' } },
    { name: 'phone-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
  ],
});
