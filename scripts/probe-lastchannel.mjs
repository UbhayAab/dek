// Coming back to a server should put you back in the room you were in.
//
// Reported as: "I was in some other channel, but as soon as I change server by
// mistake I again go to the default general again."
//
// The cause was one storage slot for the whole app. rememberLastChannel wrote
// {id, name, uid} to 'dak.lastChannel', so the memory belonged to whichever
// channel was opened last ANYWHERE. Leave #design-review in server A, open
// something in server B, come back to A, and the stored id is B's - not present
// in A's channel list, so the lookup fell through to default_channel_id and
// landed on #general. One slot cannot remember two rooms.
//
// This drives a real round trip through two real servers and requires the exact
// channel back, which is the only claim that matters.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sql = (q) => JSON.parse(execFileSync('node', ['scripts/db-query.mjs', q], { encoding: 'utf8' }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (err, body) => {
    if (err) { try { res.writeHead(404).end('nope'); } catch {} return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.PROBE_BASE || `http://127.0.0.1:${server.address().port}`;
console.log(`probe-lastchannel: serving ${ROOT} on ${BASE}`);

// This account is in exactly one server, so the round trip has no second room
// to travel to. Build one, run the trip, and take it away again - the same
// pattern probe-apps uses, so a failing run leaves nothing behind.
const [me] = sql(`select p.id, om.org_id from public.profiles p
                  join auth.users u on u.id = p.id
                  join public.org_members om on om.user_id = p.id and om.org_role = 'admin'
                 where u.email = '${EMAIL}' limit 1;`);
if (!me) throw new Error(`${EMAIL} does not administer any organisation`);

const claim = `(select set_config('request.jwt.claims',
   json_build_object('sub','${me.id}','role','authenticated')::text, true)) s`;

let fixtureWs = null;
function makeFixture() {
  const [row] = sql(`select public.org_create_server('${me.org_id}', 'Probe Server B') ws
                     from ${claim};`);
  fixtureWs = row.ws;
  // org_create_server makes #general; a second channel is what makes "went back
  // to the right room" distinguishable from "went back to the only room".
  sql(`select public.create_channel('${fixtureWs}', 'probe-room', 'text', null, false) from ${claim};`);
  return fixtureWs;
}
function dropFixture() {
  if (!fixtureWs) return;
  try {
    sql(`delete from public.messages where channel_id in
           (select id from public.channels where workspace_id = '${fixtureWs}');
         delete from public.channels where workspace_id = '${fixtureWs}';
         delete from public.workspace_members where workspace_id = '${fixtureWs}';
         delete from public.workspaces where id = '${fixtureWs}';
         select 1;`);
  } catch (e) { console.log(`warn  fixture not fully removed - ${e.message}`); }
}

makeFixture();

const spaces = sql(`
  select w.id ws, w.name wsname,
         (select json_agg(json_build_object('id', c.id, 'name', c.name::text) order by c.created_at)
            from public.channels c
           where c.workspace_id = w.id and c.kind = 'text' and c.archived_at is null) chans
    from public.workspaces w
    join public.workspace_members m on m.workspace_id = w.id
    join auth.users u on u.id = m.user_id
   where u.email = '${EMAIL}' and w.archived_at is null
   order by w.created_at;`)
  .map((r) => ({ ...r, chans: r.chans || [] }))
  .filter((r) => r.chans.length >= 2);

const browser = await chromium.launch();
try {
  if (spaces.length < 2) {
    check('the account is in two servers with two channels each', false,
      `found ${spaces.length}; cannot test a round trip`);
  } else {
    const [A, B] = spaces;
    // Deliberately NOT the first channel in either, and not one called general:
    // landing on those would pass by accident.
    const pick = (s) => s.chans.find((c) => c.name !== 'general') || s.chans[1];
    const chA = pick(A); const chB = pick(B);
    console.log(`      A = ${A.wsname} / #${chA.name}   B = ${B.wsname} / #${chB.name}`);

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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

    const go = async (wsId, chId) => page.evaluate(async ([w, c]) => {
      const { store } = await import('./js/store.js');
      const ws = await import('./js/core/workspace.js');
      const ch = await import('./js/core/channels.js');
      if (store.ws?.id !== w) { await ws.switchWorkspace(store.spaces.find((x) => x.id === w)); }
      await new Promise((r) => setTimeout(r, 2500));
      if (c) {
        const target = store.channels.find((x) => x.id === c);
        if (target) await ch.openChannel(target);
        await new Promise((r) => setTimeout(r, 1500));
      }
      return { ws: store.ws?.id, current: store.current?.id, name: String(store.current?.name || '') };
    }, [wsId, chId]);

    const inA = await go(A.ws, chA.id);
    check('opened the chosen channel in server A', inA.current === chA.id, '#' + inA.name);

    const inB = await go(B.ws, chB.id);
    check('opened the chosen channel in server B', inB.current === chB.id, '#' + inB.name);

    // The whole point: back to A with no channel named, the way tapping the
    // server tile does it.
    const backA = await go(A.ws, null);
    check('coming back to A returns to the channel you were in there',
      backA.current === chA.id, `wanted #${chA.name}, got #${backA.name}`);
    check('and NOT to its default channel', backA.name !== 'general', '#' + backA.name);

    const backB = await go(B.ws, null);
    check('coming back to B returns to ITS channel, not A\'s',
      backB.current === chB.id, `wanted #${chB.name}, got #${backB.name}`);

    // Both rooms remembered at once is the thing one slot could never do.
    const stored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('dak.lastChannel') || 'null'); }
      catch { return null; }
    });
    const n = stored?.byWs ? Object.keys(stored.byWs).length : 0;
    check('the memory holds one room PER server, not one in total', n >= 2,
      `${n} servers remembered`);
    await page.close();
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  await browser.close();
  server.close();
  dropFixture();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
