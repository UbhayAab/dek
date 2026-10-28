// Browser helpers: a context per QA user (phone with touch, or desktop; light or
// dark), the harness route, waiting until the screen settled, and screenshots
// that always go through the geometry audit.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { auditGeometry } from './geometry';
import { authFile, SHOTS_DIR, type QaUser } from './qa';

export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } as const;
export const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } as const;

export interface Opened {
  context: BrowserContext;
  page: Page;
}

export async function openAs(browser: Browser, user: QaUser | null, opts: { phone?: boolean; dark?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({
    ...(opts.phone ? PHONE : DESKTOP),
    colorScheme: opts.dark ? 'dark' : 'light',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ...(user ? { storageState: authFile(user) } : {}),
  });
  const page = await context.newPage();
  return { context, page };
}

export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector('.ap-loading, .dk-skeleton, .dk-spinner, .dk-btn[aria-busy="true"]'),
    null,
    { timeout: 20_000 },
  ).catch(() => undefined);
  await page.waitForTimeout(300);
}

export async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(`/e2e/admin/harness.html?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(() => window.dekHarness?.ready === true, null, { timeout: 30_000 });
  await settle(page);
}

// Screenshot plus geometry audit. Returns the violations (the caller collects them
// and fails the test when any exist) and warnings for other builders' parts.
export async function shoot(page: Page, name: string): Promise<{ problems: string[]; warnings: string[] }> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await settle(page);
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: false });
  const audit = await auditGeometry(page);
  return { problems: audit.problems.map((p) => `${name}: ${p}`), warnings: audit.warnings.map((p) => `${name}: ${p}`) };
}
