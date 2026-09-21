// v5: verify polish batch - composer tools, channel-born screen, proper dark shot.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dek-7o4.pages.dev';
mkdirSync('shots/v5', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `shots/v5/${n}.png` });

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

// 1. Composer tools present?
await page.locator('#composerBar').screenshot({ path: 'shots/v5/composer-tools.png' }).catch(() => {});

// 2. Create a brand-new channel -> channel-born screen
await page.locator('#channels .sb-add, button:has-text("Add channel")').first().click().catch(() => {});
await page.waitForTimeout(800);
const dlg = page.locator('.modal, [role="dialog"]').last();
const nameInput = dlg.locator('input').first();
if (await nameInput.count()) {
  await nameInput.fill('design-review');
  await shot(page, 'new-channel-dialog');
  await dlg.locator('button:has-text("Create"), button:has-text("Add")').last().click();
  await page.waitForTimeout(2500);
}
await shot(page, 'channel-born');

// 3. Dark theme done RIGHT: blur the composer first
await page.locator('#composer').blur().catch(() => {});
await page.click('#messages', { position: { x: 10, y: 10 } }).catch(() => {});
await page.keyboard.press('Shift+T');
await page.waitForTimeout(1000);
await shot(page, 'dark-channel');
await page.keyboard.press('Shift+T');
await page.waitForTimeout(600);

// 4. Mobile composer with full tool tray
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
await mob.locator('#composerBar').screenshot({ path: 'shots/v5/mobile-composer-tools.png' }).catch(() => {});
await shot(mob, 'mobile-final');

await browser.close();
console.log('V5 DONE');
