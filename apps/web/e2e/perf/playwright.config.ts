// Performance runs against a deployed build (see perf.spec.ts). Chromium only (CDP
// throttling), one worker so runs do not compete for the CPU.
import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  retries: 0,
  workers: 1,
  outputDir: join(tmpdir(), 'dek-perf-results'),
  reporter: [['list']],
  use: {
    baseURL: process.env.PERF_URL ?? 'https://dek-7o4.pages.dev',
    headless: true,
    launchOptions: { args: ['--mute-audio'] },
  },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
});
