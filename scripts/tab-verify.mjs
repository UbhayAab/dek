import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'demo@dek.app');
await p.fill('input[type="password"]', 'dek-demo-2026');
await p.click('#pwSignIn');
await p.waitForTimeout(8000);
const info = await p.evaluate(() => {
  const n = document.querySelector('#tabbar');
  return { kids: n ? n.children.length : -1, h: n ? n.getBoundingClientRect().height : -1 };
});
console.log('TABBAR:', JSON.stringify(info));
await p.screenshot({ path: 'shots/70-mobile-tabbar-fixed.png' });
// tap Activity tab for real
await p.locator('#tabbar .tab').nth(2).click();
await p.waitForTimeout(1200);
await p.screenshot({ path: 'shots/71-mobile-activity.png' });
console.log('DONE');
await b.close();
