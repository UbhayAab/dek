import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'demo@dek.app');
await p.fill('input[type="password"]', 'dek-demo-2026');
await p.click('#pwSignIn');
await p.waitForTimeout(4500);
const tools = await p.evaluate(() =>
  [...document.querySelectorAll('#composerTools button, #composerTools [data-tool]')].map((b) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { title: b.title || b.getAttribute('aria-label') || b.textContent.slice(0, 12), w: Math.round(r.width), display: cs.display, vis: cs.visibility };
  }),
);
console.log(JSON.stringify(tools, null, 1));
await b.close();
