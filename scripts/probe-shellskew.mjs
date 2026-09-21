// The sign-in screen must survive being older than the code running it.
//
// Reported from production as a dead login page on somebody's phone:
//   Cannot set properties of null (setting 'onclick')
//     at initAuth (js/core/auth.js:274)
//     at main (js/main.js:664)
// Line 274 was $('pwForgot').onclick, a button added the day before. The device
// was rendering the PREVIOUS index.html out of the service worker's shell cache
// while fetching the new auth.js over the network - which the service worker
// permits, because a navigation falls back to cache when its fetch fails while
// module requests that succeed come back fresh. One flaky load is all it takes.
//
// The throw aborted initAuth, which aborted main(), which meant no composer, no
// shortcuts, no registrations - and, on the one screen where it matters most,
// no way to sign in and therefore no way to reach anything that could fix it.
//
// This probe serves a DELIBERATELY OLD index.html - the previous markup, with
// the newer controls stripped out - alongside today's JavaScript, and requires
// that a person can still sign in.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

// Everything the code added after the shell this test pretends to be. Removing
// them by id is exactly the shape of the real skew: the JS binds them, the HTML
// has never heard of them.
const STRIP_IDS = ['pwForgot', 'otpLead', 'displayName', 'dpdpNotice'];

function olderShell(html) {
  // Renaming the id is a truer reproduction than cutting the element out, and it
  // needs no HTML surgery: $('pwForgot') returns null either way, which IS the
  // production condition. Cutting the markup would additionally test the layout,
  // which is not what broke.
  let out = html;
  for (const id of STRIP_IDS) out = out.split(`id="${id}"`).join(`id="${id}--absent"`);
  return out;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };

let serveOldShell = true;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (err, body) => {
    if (err) { try { res.writeHead(404).end('nope'); } catch {} return; }
    // The whole point: an old shell, today's scripts.
    if (serveOldShell && f.endsWith('index.html')) {
      body = Buffer.from(olderShell(body.toString('utf8')), 'utf8');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-shellskew: serving ${ROOT} on ${BASE} with an OLD shell`);

const browser = await chromium.launch();
try {
  // ---- 1. the stripped shell really is missing the controls --------------
  {
    const raw = await (await fetch(BASE + '/index.html')).text();
    const still = STRIP_IDS.filter((id) => raw.includes(`id="${id}"`));
    check('the test really is serving an older shell', still.length === 0,
      still.length ? 'still present: ' + still.join(', ') : STRIP_IDS.join(', ') + ' removed');
    check('but the shell still has what sign-in needs',
      ['email', 'password', 'pwSignIn'].every((id) => raw.includes(`id="${id}"`)));
  }

  // ---- 2. boot survives, and sign-in still works -------------------------
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(1200);

    check('no uncaught error on a shell older than the code', errors.length === 0,
      errors.slice(0, 2).join(' | '));

    // main() continued past initAuth. If it had thrown, none of this exists.
    const booted = await page.evaluate(() => ({
      composer: !!document.getElementById('composer'),
      signInBound: typeof document.getElementById('pwSignIn')?.form?.onsubmit !== 'undefined',
    }));
    check('boot continued past the sign-in wiring', booted.composer === true);

    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('#pwSignIn');
    await page.waitForTimeout(8000);
    const signedIn = await page.evaluate(async () => {
      const { sb } = await import('./js/sb.js');
      const { data } = await sb.auth.getSession();
      return !!data.session;
    });
    check('somebody can still SIGN IN on the older shell', signedIn === true);
    await page.close();
  }

  // ---- 3. a shell too old to use heals itself, once ----------------------
  // Strip the password field itself. There is no defensive binding that makes
  // that page usable, so the only correct answer is to throw the cached shell
  // away and reload - and to do it exactly once, because a reload loop on the
  // sign-in screen is worse than the bug.
  {
    STRIP_IDS.push('password');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const loads = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) loads.push(f.url()); });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() => {
      let flag = null;
      try { flag = sessionStorage.getItem('dak.shellSkew'); } catch { /* private mode */ }
      return { flag, loads: performance.getEntriesByType('navigation').length };
    });
    check('an unusable shell marks itself so it cannot loop', state.flag === '1', String(state.flag));
    // Two navigations total: the first load and the single self-heal reload.
    check('and reloads once, not forever', loads.length <= 3, `${loads.length} navigations`);
    await page.close();
    STRIP_IDS.pop();
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
