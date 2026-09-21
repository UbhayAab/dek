// Look at the Apps console. Every blind judgement of a screen in this repo has
// been wrong, so this one gets measured and photographed before it ships.
import { chromium } from 'playwright';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:4177';
const b = await chromium.launch();
for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForSelector('#email', { state: 'visible', timeout: 60000 });
  await p.fill('#email', 'demo@dek.app'); await p.fill('#password', 'dek-demo-2026');
  await p.click('#pwSignIn'); await p.waitForTimeout(7000);
  for (let i = 0; i < 4; i++) {
    const d = p.locator('.modal,[role="dialog"]').last();
    if (await d.count() && await d.isVisible().catch(() => false)) { await p.keyboard.press('Escape'); await p.waitForTimeout(400); } else break;
  }
  const r = await p.evaluate(async () => {
    const { store, bus } = await import('./js/store.js');
    const org = (store.orgs || []).find((o) => o.org_role === 'admin');
    if (!org) return { ok: false, why: 'demo account admins no org' };
    bus.emit('orgadmin:open', { orgId: org.org_id });
    await new Promise((r2) => setTimeout(r2, 2500));
    document.querySelector('[data-sec="apps"]')?.click();
    await new Promise((r2) => setTimeout(r2, 2500));
    const main = document.querySelector('#apMain');
    const doc = document.documentElement;
    return {
      ok: !!main,
      hasAppsTab: !!document.querySelector('[data-sec="apps"]'),
      h2: [...document.querySelectorAll('.ap-h2')].map((n) => n.textContent.trim()).slice(0, 4),
      mainW: main?.getBoundingClientRect().width,
      scrollW: doc.scrollWidth, clientW: doc.clientWidth,
      emptyText: main?.querySelector('.empty')?.textContent.trim().slice(0, 60) || null,
      rows: main?.querySelectorAll('[data-app]').length ?? 0,
    };
  });
  console.log(tag, JSON.stringify(r));
  console.log(tag, 'errors:', errs.slice(0, 2).join(' | ') || 'none');
  console.log(tag, 'h-overflow:', r.scrollW > r.clientW ? `YES ${r.scrollW}>${r.clientW}` : 'no');
  await p.screenshot({ path: `C:/Users/abhay/AppData/Local/Temp/claude/C--Users-abhay-Desktop/98be7254-9e53-41bc-aeb1-db700f3e1159/scratchpad/apps-${tag}.png`, fullPage: true });
  await p.close();
}
await b.close();
