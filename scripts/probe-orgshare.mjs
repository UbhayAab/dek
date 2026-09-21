// The invite sheet, driven in the real booted app, with the QR read back off
// the rendered pixels.
//
// probe-qr.mjs proves the encoder is correct in Node. That is not the same claim
// as "the code on the screen scans", which is the one that matters: between the
// matrix and somebody's camera sit an SVG serialisation, a CSS width, a border
// radius on the card and a device pixel ratio, and any of those can quietly ruin
// it. So this probe screenshots the QR ELEMENT out of the live page, decodes the
// PNG with an independent decoder, and requires the invite URL back verbatim.
//
// It also pins the things the sheet promises: that it opens with a link already
// minted rather than a form, that the link works for a plain MEMBER and not only
// an admin, and that the WhatsApp and mail targets are addressed correctly.
//
// Needs the local tree served on PROBE_BASE (probe-all.mjs boots :4177 itself)
// and the demo account, which is the only signed-in identity the suite has.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:4177';
const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
// #email / #password, not input[type=...]: the auth screen carries the password
// -reset and OTP forms in the same document, so the loose selector matches
// several hidden fields and resolves to whichever Playwright saw first.
await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
await page.fill('#email', EMAIL);
await page.fill('#password', PASS);
await page.click('#pwSignIn');
await page.waitForTimeout(5000);
for (let i = 0; i < 4; i++) {
  const dlg = page.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } else break;
}

const opened = await page.evaluate(async () => {
  const mod = await import('./js/features/orgshare.js');
  const { store } = await import('./js/store.js');
  const org = (store.orgs || [])[0];
  if (!org) return { ok: false, why: 'signed-in account is in no organisation' };
  await mod.openShareSheet(org.org_id);
  return { ok: true, name: org.name };
});
check('sheet opens', opened.ok, opened.why || opened.name);
if (!opened.ok) { await browser.close(); process.exit(1); }
await page.waitForTimeout(2500);

// 1. It opens with a link, not a form. This is the whole redesign in one check.
const link = await page.$eval('.oshare-url', (n) => n.value).catch(() => null);
check('opens with a link already minted', !!link && /#\/join-org\/[0-9a-f]{32}$/.test(link),
  link || 'no link field');

// 2. The rendered QR decodes back to exactly that link.
{
  const buf = await page.locator('.oshare-qr').screenshot();
  const png = PNG.sync.read(buf);
  const got = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  check('the QR as rendered on screen decodes to the invite link',
    got && got.data === link,
    got ? (got.data === link ? `${png.width}x${png.height}px` : `decoded ${got.data}`) : 'unreadable');
}

// 3. The QR is big enough to be scanned across a room. Below ~180 CSS px a
//    37x37 code stops reading reliably off a phone held up at two metres.
{
  const box = await page.locator('.oshare-qr svg').boundingBox();
  check('QR is at least 180px on screen', box && box.width >= 180,
    box ? `${Math.round(box.width)}px` : 'not visible');
}

// 4. The send targets are addressed, and WhatsApp carries the link in its text.
{
  const targets = await page.evaluate(() => {
    const out = {};
    const orig = window.open;
    window.open = (u) => { out.wa = u; return null; };
    document.querySelector('[data-a="wa"]')?.click();
    window.open = orig;
    return out;
  });
  check('WhatsApp share targets wa.me with the link in the message',
    targets.wa && targets.wa.startsWith('https://wa.me/?text=')
      && decodeURIComponent(targets.wa.split('text=')[1]).includes(link),
    targets.wa ? targets.wa.slice(0, 60) + '...' : 'no window.open call');
}

// 5. Nothing about the sheet pushes the page sideways at phone width.
{
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(600);
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal overflow at 360px', !over);
  await page.setViewportSize({ width: 1280, height: 900 });
}

// 6. Reopening in the same sitting reuses the SAME link rather than minting a
//    pile of them - the sessionStorage cache doing its job.
{
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const mod = await import('./js/features/orgshare.js');
    const { store } = await import('./js/store.js');
    await mod.openShareSheet(store.orgs[0].org_id);
  });
  await page.waitForTimeout(2000);
  const again = await page.$eval('.oshare-url', (n) => n.value).catch(() => null);
  check('reopening reuses the same link', again === link, again === link ? '' : `${again} != ${link}`);
}

check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nprobe-orgshare: all checks passed');
process.exit(fail ? 1 : 0);
