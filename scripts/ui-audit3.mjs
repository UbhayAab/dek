// v6: post-deploy verification - composer tools + channel-born screen.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dek-7o4.pages.dev';
mkdirSync('shots/v6', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `shots/v6/${n}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', 'demo@dek.app');
await page.fill('input[type="password"]', 'dek-demo-2026');
await page.click('#pwSignIn');
await page.waitForTimeout(4500);
for (let i = 0; i < 3; i++) {
  const dlg = page.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } else break;
}
await page.locator('#channels .chan').first().click().catch(() => {});
await page.waitForTimeout(1200);

// Clear whatever text the previous runs left in the composer
const composer = page.locator('#composer');
await composer.fill('');
await page.locator('#composerBar').screenshot({ path: 'shots/v6/composer-tools.png' }).catch(() => {});
const toolCount = await page.locator('#composerTools button').count();
console.log('composer tools:', toolCount);

// Add channel via the row (it is a .chan row with + Add channel text)
await page.locator('#channels .chan', { hasText: 'Add channel' }).first().click().catch(() => {});
await page.waitForTimeout(900);
const dlg = page.locator('.modal, [role="dialog"]').last();
if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
  await dlg.locator('input').first().fill('design-review');
  await shot(page, 'dialog');
  await dlg.locator('button').last().click();
  await page.waitForTimeout(2800);
}
await shot(page, 'channel-born');

// Dark, composer blurred
await page.locator('body').click({ position: { x: 640, y: 300 } }).catch(() => {});
await page.keyboard.press('Shift+T');
await page.waitForTimeout(1100);
await shot(page, 'dark-channel-born');
await page.keyboard.press('Shift+T');
await page.waitForTimeout(500);

// Mobile composer tools
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.fill('input[type="email"]', 'demo@dek.app');
await mob.fill('input[type="password"]', 'dek-demo-2026');
await mob.click('#pwSignIn');
await mob.waitForTimeout(4500);
for (let i = 0; i < 2; i++) {
  const d = mob.locator('.modal, [role="dialog"]').last();
  if (await d.count() && await d.isVisible().catch(() => false)) { await mob.keyboard.press('Escape'); await mob.waitForTimeout(500); }
}
await mob.locator('#composerBar').screenshot({ path: 'shots/v6/mobile-composer-tools.png' }).catch(() => {});
const mt = await mob.locator('#composerTools button').count();
console.log('mobile tools:', mt);

await browser.close();
console.log('V6 DONE');
