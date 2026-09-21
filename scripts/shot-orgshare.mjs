// Look at the invite sheet with actual eyes, on the local tree, before it goes
// anywhere. Every previous judgement of this surface was made by reading the
// markup, which is how it stayed a three-field form for so long.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = 'shots/orgshare';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function session(width, height, theme) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const log = [];
  page.on('console', (m) => { if (m.type() === 'error') log.push(m.text()); });
  page.on('pageerror', (e) => log.push('PAGEERROR ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((t) => {
    try { localStorage.setItem('theme', t); } catch { /* ignore */ }
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  await page.fill('input[type="email"]', 'demo@dek.app');
  await page.fill('input[type="password"]', 'dek-demo-2026');
  await page.click('#pwSignIn');
  await page.waitForTimeout(5000);

  // Dismiss whatever onboarding is standing in front of the app.
  for (let i = 0; i < 4; i++) {
    const dlg = page.locator('.modal, [role="dialog"]').last();
    if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    } else break;
  }
  await page.waitForTimeout(800);
  return { page, log };
}

for (const [name, w, h, theme] of [
  ['desktop-dark', 1280, 860, 'dark'],
  ['desktop-light', 1280, 860, 'light'],
  ['phone-dark', 390, 844, 'dark'],
]) {
  const { page, log } = await session(w, h, theme);
  await page.screenshot({ path: `${OUT}/${name}-00-shell.png` });

  // Open the sheet the way a person would: through the rail's + chooser.
  const opened = await page.evaluate(async () => {
    const mod = await import('./js/features/orgshare.js');
    const store = (await import('./js/store.js')).store;
    const org = (store.orgs || [])[0];
    if (!org) return { ok: false, why: 'no orgs in store' };
    await mod.openShareSheet(org.org_id);
    return { ok: true, org: org.name, role: org.org_role };
  }).catch((e) => ({ ok: false, why: String(e).slice(0, 200) }));

  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}-01-share.png` });

  // And with both folds open, which is the dense state.
  await page.evaluate(() => document.querySelectorAll('.oshare-fold').forEach((d) => { d.open = true; }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}-02-share-open.png`, fullPage: true });

  const facts = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qr = q('.oshare-qr svg');
    return {
      sheetPresent: !!q('.oshare'),
      qrPresent: !!qr,
      qrBox: qr ? { w: qr.getBoundingClientRect().width, h: qr.getBoundingClientRect().height } : null,
      qrModules: qr ? qr.querySelectorAll('rect').length : 0,
      link: q('.oshare-url')?.value || null,
      chips: [...document.querySelectorAll('.oshare-chip span')].map((n) => n.textContent),
      copyLabel: q('.oshare-copy span')?.textContent || null,
      note: q('.oshare-note')?.textContent?.trim().replace(/\s+/g, ' ') || null,
      error: q('.oshare-err')?.textContent || null,
      // Does anything push the dialog wider than the viewport?
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

  console.log(`\n== ${name} ==`);
  console.log('open:', JSON.stringify(opened));
  console.log('facts:', JSON.stringify(facts, null, 1));
  if (log.length) console.log('console errors:', log.slice(0, 6));
  await page.close();
}

await browser.close();
console.log(`\nshots in ${OUT}/`);
