// Visual audit capture v4 - every surface, desktop + mobile, for the UI overhaul.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dek-7o4.pages.dev';
mkdirSync('shots/v4', { recursive: true });
const shot = (p, n, opts = {}) => p.screenshot({ path: `shots/v4/${n}.png`, ...opts });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE, { waitUntil: 'networkidle' });
await shot(page, 'auth-desktop');
await page.fill('input[type="email"]', 'demo@dek.app');
await page.fill('input[type="password"]', 'dek-demo-2026');
await page.click('#pwSignIn');
await page.waitForTimeout(4500);
for (let i = 0; i < 3; i++) {
  const dlg = page.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } else break;
}
await page.locator('#channels .chan').first().click().catch(() => {});
await page.waitForTimeout(1500);
await shot(page, 'desktop-channel');

// Seed a few messages so the channel looks lived-in
const composer = page.locator('#composer');
const seeded = await composer.getAttribute('data-seeded').catch(() => null);
if (await composer.isEnabled().catch(() => false)) {
  const msgs = [
    'Morning all. Depot 3 dispatch list is attached below.',
    'Noted. Sending the count sheet in a bit.',
    'Who is handling the Nashik pickup today?',
  ];
  for (const m of msgs) {
    const t = await composer.textContent();
    await composer.fill(m);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(800);
}
await shot(page, 'desktop-channel-lived');

// Composer close-up
await page.locator('#composerBar').screenshot({ path: 'shots/v4/composer.png' }).catch(() => {});
// Channel bar close-up
await page.locator('#channelbar').screenshot({ path: 'shots/v4/channelbar.png' }).catch(() => {});
// Sidebar close-up
await page.locator('#sidebar').screenshot({ path: 'shots/v4/sidebar.png' }).catch(() => {});

// Panels: threads, tasks
for (const [cmd, name] of [['/tasks', 'panel-tasks']]) {
  await composer.fill(cmd);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// DM dialog
await page.keyboard.press('Control+Shift+k').catch(() => {});
await page.waitForTimeout(800);
await shot(page, 'dm-dialog');
await page.keyboard.press('Escape');

// Dark theme same channel
await page.keyboard.press('Shift+T');
await page.waitForTimeout(800);
await shot(page, 'desktop-channel-dark');
await page.keyboard.press('Shift+T');
await page.waitForTimeout(400);

// Mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.fill('input[type="email"]', 'demo@dek.app');
await mob.fill('input[type="password"]', 'dek-demo-2026');
await mob.click('#pwSignIn');
await mob.waitForTimeout(4500);
for (let i = 0; i < 2; i++) {
  const dlg = mob.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) { await mob.keyboard.press('Escape'); await mob.waitForTimeout(500); }
}
await shot(mob, 'mobile-channel');
await mob.locator('#navToggle').click().catch(() => {});
await mob.waitForTimeout(600);
await shot(mob, 'mobile-drawer');
await mob.locator('#navToggle').click().catch(() => {});
await mob.waitForTimeout(400);
await mob.locator('#composer').fill('Voice-note and attach tools live in this tray').catch(() => {});
await shot(mob, 'mobile-composer');

await browser.close();
console.log('CAPTURE DONE');
