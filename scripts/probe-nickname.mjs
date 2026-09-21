// A name you give somebody, that only you see - and a channel list that is only
// channels.
//
// Asked for as: "I want to change someone's name just for myself. Like put a
// skull emoji after Utkarsh's name, and I see it but he does not."
// And: "in the channel view I can see DMs - why? We already have a DM tab. And
// why is 'Your profile, change password' in the channel tab."
//
// The privacy half is proven in SQL (two sessions, two different answers from
// my_nicknames). What this proves is the half only a browser can: that the name
// actually reaches what is drawn, including the initials on the avatar, and that
// it survives a reload, which means it came from the database rather than from
// the Map the test just wrote.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';
const NICK = 'Utkarsh \u{1F480}';

let fail = 0;
const check = (n, c, d = '') => {
  if (!c) fail++;
  console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ` - ${d}` : ''}`);
};
const sql = (q) => JSON.parse(execFileSync('node', ['scripts/db-query.mjs', q], { encoding: 'utf8' }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (e, b) => {
    if (e) { try { res.writeHead(404).end('nope'); } catch {} return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.PROBE_BASE || `http://127.0.0.1:${server.address().port}`;
console.log(`probe-nickname: serving ${ROOT} on ${BASE}`);

const [me] = sql(`select p.id from public.profiles p join auth.users u on u.id = p.id
                  where u.email = '${EMAIL}';`);
const cleanup = () => sql(`delete from public.user_nicknames where viewer_id = '${me.id}'; select 1;`);
cleanup();

const signIn = async (page) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('#pwSignIn');
  await page.waitForTimeout(7000);
  for (let i = 0; i < 4; i++) {
    const d = page.locator('.modal,[role="dialog"]').last();
    if (await d.count() && await d.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    } else break;
  }
};

const browser = await chromium.launch();
try {
  // ---- the nickname reaches what is actually drawn ----------------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    const target = await page.evaluate(async () => {
      const { store } = await import('./js/store.js');
      const other = [...store.profiles.values()].find((p) => p.id !== store.me && !p.is_app);
      return other ? { id: other.id, real: other.display_name || other.username } : null;
    });
    check('found somebody to rename', !!target, target ? target.real : 'nobody');

    if (target) {
      const after = await page.evaluate(async ([id, nick]) => {
        const { api } = await import('./js/api.js');
        const { store, bus, nameOf } = await import('./js/store.js');
        const { avatarHtml } = await import('./js/core/messages.js');
        await api.setNickname(id, nick);
        store.nicknames.set(id, nick);
        bus.emit('profiles');
        await new Promise((r) => setTimeout(r, 900));
        return { name: nameOf(id), avatar: avatarHtml(id) };
      }, [target.id, NICK]);
      check('nameOf returns the nickname', after.name === NICK, after.name);
      // Initials come off the same name or the circle disagrees with the label.
      check('the avatar initials follow it', /U/.test(after.avatar),
        (after.avatar.match(/>([^<]{1,4})</) || [])[1] || '?');

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(7000);
      const reloaded = await page.evaluate(async (id) => {
        const { store, nameOf } = await import('./js/store.js');
        return { name: nameOf(id), size: store.nicknames.size };
      }, target.id);
      check('it survives a reload', reloaded.name === NICK, reloaded.name);
      check('so it came from the server, not this test', reloaded.size >= 1,
        `${reloaded.size} stored`);

      const cleared = await page.evaluate(async ([id]) => {
        const { api } = await import('./js/api.js');
        const { store, nameOf } = await import('./js/store.js');
        await api.setNickname(id, '');
        store.nicknames.delete(id);
        return nameOf(id);
      }, [target.id]);
      check('clearing restores their own name', cleared === target.real, cleared);
    }
    await page.close();
  }

  // ---- a phone drawer is only channels ----------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await signIn(page);
    const d = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('#sidebarScroll h3 span')].map((n) => n.textContent.trim()),
      tabbarShown: getComputedStyle(document.getElementById('tabbar')).display !== 'none',
      dmRows: document.querySelectorAll('#channels [data-dm]').length,
      newDm: !!document.querySelector('#channels [data-newdm]'),
      youRows: document.querySelectorAll('[data-pnav]').length,
      channelRows: document.querySelectorAll('#channels [data-ch]').length,
    }));
    check('the phone really is showing the DM tab', d.tabbarShown === true);
    check('phone drawer: no Direct messages heading',
      !d.heads.includes('Direct messages'), d.heads.join(' / '));
    check('phone drawer: no DM rows, no New message', d.dmRows === 0 && !d.newDm);
    check('phone drawer: no You group', d.youRows === 0, `${d.youRows} rows`);
    check('phone drawer: still lists channels', d.channelRows > 0, `${d.channelRows} channels`);
    await page.close();
  }

  // ---- a desktop has no tab bar, so the drawer keeps them ---------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    const d = await page.evaluate(() => ({
      tabbarShown: getComputedStyle(document.getElementById('tabbar')).display !== 'none',
      heads: [...document.querySelectorAll('#sidebarScroll h3 span')].map((n) => n.textContent.trim()),
      youRows: document.querySelectorAll('[data-pnav]').length,
    }));
    check('the desktop really has no tab bar', d.tabbarShown === false);
    check('desktop keeps Direct messages, its only route to them',
      d.heads.includes('Direct messages'), d.heads.join(' / '));
    check('desktop keeps the You group', d.youRows === 2, `${d.youRows} rows`);
    await page.close();
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  await browser.close();
  server.close();
  cleanup();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
