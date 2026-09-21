import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'demo@dek.app');
await p.fill('input[type="password"]', 'dek-demo-2026');
await p.click('#pwSignIn');
await p.waitForTimeout(5000);
for (let i = 0; i < 2; i++) {
  const d = p.locator('.modal,[role=dialog]').last();
  if (await d.count() && await d.isVisible().catch(() => false)) { await p.keyboard.press('Escape'); await p.waitForTimeout(400); }
}
await p.locator('#channels .chan').first().click().catch(() => {});
await p.waitForTimeout(1500);
await p.screenshot({ path: 'shots/reskin-desktop-light.png' });
await p.locator('#composerBar').screenshot({ path: 'shots/reskin-composer.png' }).catch(() => {});
await p.click('#messages', { position: { x: 8, y: 8 } }).catch(() => {});
await p.keyboard.press('Shift+T');
await p.waitForTimeout(900);
await p.screenshot({ path: 'shots/reskin-desktop-dark.png' });
await p.keyboard.press('Shift+T');
await p.waitForTimeout(500);
const m = await b.newPage({ viewport: { width: 390, height: 844 } });
await m.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await m.fill('input[type="email"]', 'demo@dek.app');
await m.fill('input[type="password"]', 'dek-demo-2026');
await m.click('#pwSignIn');
await m.waitForTimeout(5000);
for (let i = 0; i < 2; i++) {
  const d = m.locator('.modal,[role=dialog]').last();
  if (await d.count() && await d.isVisible().catch(() => false)) { await m.keyboard.press('Escape'); await m.waitForTimeout(400); }
}
await m.screenshot({ path: 'shots/reskin-mobile.png' });
console.log('RESKIN SHOTS DONE');
await b.close();
