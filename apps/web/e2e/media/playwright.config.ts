// Media and calls end to end: npx playwright test -c e2e/media/playwright.config.ts
// (from apps/web). Its own dev server on 5176. Headless Chromium with fake camera
// and microphone, the permission prompts auto-accepted, all audio muted: silent.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..', '..');
const PORT = 5176;

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: resolve(here, '.results'),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
    },
    // No traces: they would record the sign-in arguments.
    trace: 'off',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: web,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
