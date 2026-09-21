// The app platform, driven end to end the way an app author actually meets it.
//
// The claim this probe exists to defend is NOT "the RPCs work" - a SQL smoke
// test proves that far more cheaply. It is the claim that broke the feature that
// was already here: that a message posted by something which is not a browser
// renders in the channel as a NAMED APP. That failed before because
// js/core/messages.js tested m.bot_id, which is not a column on messages, so the
// test was permanently false and nameOf(null) painted the literal word
// "someone". Nobody had ever looked, because nobody had ever managed to post.
//
// So the assertions are made against rendered text in a real browser, on the
// three paths that hydrate a message differently:
//   - realtime, arriving in an open channel
//   - a cold load of the channel from scratch
//   - a heal read after a forced gap
// and a fourth thing worth as much as all three: that the heal read no longer
// asks for the two phantom columns, which used to make every heal fail its
// select and silently retry with '*'.
//
// Needs the local tree on PROBE_BASE (probe-all.mjs boots :4177) and the demo
// account, plus DB access through scripts/db-query.mjs to mint a token.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Serve the tree here rather than depending on a port somebody else booted, the
// way every other probe in this directory does. Depending on :4177 made this
// probe pass when run by hand and fail inside probe-all, which is the worst of
// both worlds.
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
console.log(`probe-apps: serving ${ROOT} on ${BASE}`);
const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';
const FN = 'https://ybddogqphinruyunnuwx.supabase.co/functions/v1/dek-app';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const sql = (q) => {
  const out = execFileSync('node', ['scripts/db-query.mjs', q], { encoding: 'utf8' });
  return JSON.parse(out);
};

// ---------------------------------------------------------------- fixture
// Built and torn down here rather than left in the database, so a failing run
// does not leave a live token behind.
const APP_NAME = 'Probe Dispatch';
let appId = null, token = null, channel = null, workspace = null;

function setup() {
  const [row] = sql(`
    select o.id org, w.id ws, c.id ch, c.name::text chname,
           (select om.user_id from public.org_members om
             where om.org_id = o.id and om.org_role = 'admin' limit 1) admin
      from public.organizations o
      join public.workspaces w on w.org_id = o.id
      join public.channels c on c.workspace_id = w.id and c.archived_at is null
     where exists (select 1 from public.workspace_members m
                    join auth.users u on u.id = m.user_id
                   where m.workspace_id = w.id and u.email = '${EMAIL}')
     order by o.created_at, c.created_at limit 1;`);
  if (!row) throw new Error(`no workspace found containing ${EMAIL}`);

  const claim = `(select set_config('request.jwt.claims',
      json_build_object('sub','${row.admin}','role','authenticated')::text, true)) s`;

  const [a] = sql(`select public.create_app('${row.org}', '${APP_NAME}', 'probe fixture') v from ${claim};`);
  appId = a.v.id;
  const [i] = sql(`select public.install_app('${appId}', '${row.ws}', 1|8|16, 'listed',
                     array['${row.ch}'::uuid]) v from ${claim};`);
  const [t] = sql(`select public.create_app_token('${i.v.install_id}', 'probe') v from ${claim};`);
  token = t.v.token;

  channel = row.chname; workspace = row.ws;
}

function teardown() {
  if (!appId) return;
  try {
    // Order matters: apps.profile_id references profiles ON DELETE RESTRICT while
    // profiles.app_id references apps ON DELETE CASCADE, so deleting either end
    // first fails. Break the cycle by nulling profiles.app_id, then unwind.
    sql(`do $$
         declare p uuid := (select profile_id from public.apps where id = '${appId}');
         begin
           delete from public.tasks           where created_by = p;
           delete from public.messages        where author_id  = p;
           delete from public.app_installs    where app_id = '${appId}';
           delete from private.app_secrets    where app_id = '${appId}';
           update public.profiles set app_id = null where id = p;
           delete from public.apps            where id = '${appId}';
           delete from public.workspace_members where user_id = p;
           delete from auth.users             where id = p;
         end $$;
         select (select count(*) from public.apps where id = '${appId}') left_behind;`);
  } catch (e) { console.log(`warn  teardown incomplete - ${e.message}`); }
}

async function post(text) {
  const r = await fetch(`${FN}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  return { status: r.status, body: await r.json() };
}

// ------------------------------------------------------------------- run
setup();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Every network request the page makes, so the heal read's column list can be
// read off the wire rather than off the source.
const reads = [];
page.on('request', (r) => { if (r.url().includes('/rest/v1/messages')) reads.push(r.url()); });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('#pwSignIn');
  await page.waitForTimeout(5000);
  for (let i = 0; i < 4; i++) {
    const dlg = page.locator('.modal, [role="dialog"]').last();
    if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    } else break;
  }

  const open = await page.evaluate(async ([ws, chname]) => {
    const { store } = await import('./js/store.js');
    const wsmod = await import('./js/core/workspace.js');
    if (store.ws?.id !== ws) await wsmod.switchWorkspace(ws);
    await new Promise((r) => setTimeout(r, 2500));
    const ch = (store.channels || []).find((c) => String(c.name) === chname);
    if (!ch) return { ok: false, why: 'channel not in store' };
    const chan = await import('./js/core/channels.js');
    await chan.openChannel(ch);   // the object, not the id: subscribeChannel reads c.id
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, id: ch.id };
  }, [workspace, channel]);
  check('probe can open the target channel', open.ok, open.why || `#${channel}`);
  if (!open.ok) throw new Error(open.why);

  // ---- 1. realtime -------------------------------------------------------
  const live = await post('probe realtime leg');
  check('POST /messages accepted', live.status === 200, `HTTP ${live.status}`);
  // Poll rather than sleep a fixed amount: a fixed wait either flakes or is
  // always the worst case, and this is the assertion the phase is judged on.
  for (let i = 0; i < 20; i++) {
    const seen = await page.evaluate((mid) => !!document.querySelector(`[data-id="${mid}"]`),
      live.body.message_id);
    if (seen) break;
    await page.waitForTimeout(1000);
  }

  const nameOf = async (id) => page.evaluate((mid) => {
    let row = document.querySelector(`[data-id="${mid}"]`);
    if (!row) return null;
    // A row grouped under one from the same author has no header of its own; it
    // inherits the one above. Read that, which is what the eye does too.
    let head = row;
    while (head && !head.querySelector('.who') && head.classList.contains('grouped')) {
      head = head.previousElementSibling;
      if (head && head.dataset.author !== row.dataset.author) { head = null; break; }
    }
    const who = head?.querySelector('.who');
    return {
      who: who ? who.textContent.trim() : null,
      pill: !!head?.querySelector('.pill-bot'),
      grouped: head !== row,
    };
  }, id);

  const r1 = await nameOf(live.body.message_id);
  check('realtime: the message renders with the app name',
    r1 && r1.who === APP_NAME, r1 ? `got "${r1.who}"` : 'row not found');
  check('realtime: it never renders as "someone"', !r1 || r1.who !== 'someone', r1?.who);
  check('realtime: the APP pill is painted', !!r1?.pill);

  // ---- 2. cold load ------------------------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  const r2 = await nameOf(live.body.message_id);
  check('cold load: the message renders with the app name',
    r2 && r2.who === APP_NAME, r2 ? `got "${r2.who}"` : 'row not found');
  check('cold load: the APP pill survives a reload', !!r2?.pill);
  // This leg failed two runs in three before the bootstrap started announcing
  // its member list. Pin the signal itself, so a regression says what broke.
  {
    const emits = await page.evaluate(async () => {
      const { bus } = await import('./js/store.js');
      let n = 0;
      bus.on('profiles', () => { n += 1; });
      const { switchWorkspace } = await import('./js/core/workspace.js');
      const { store } = await import('./js/store.js');
      await switchWorkspace(store.spaces.find((x) => x.id === store.ws.id) || store.ws);
      await new Promise((r) => setTimeout(r, 3000));
      return n;
    });
    check('cold load: loading a Space announces its member list', emits > 0,
      `${emits} 'profiles' emits`);
  }

  // ---- 3. heal read ------------------------------------------------------
  // Post while the socket is down, then bring it back: the gap is closed by the
  // heal path, which is the third and least-exercised hydration route.
  reads.length = 0;
  await page.evaluate(() => import('./js/sb.js').then(({ sb }) => sb.realtime.disconnect()));
  const healed = await post('probe heal leg');
  await page.waitForTimeout(1500);
  await page.evaluate(() => import('./js/sb.js').then(({ sb }) => sb.realtime.connect()));
  for (let i = 0; i < 25; i++) {
    const seen = await page.evaluate((mid) => !!document.querySelector(`[data-id="${mid}"]`),
      healed.body.message_id);
    if (seen) break;
    await page.waitForTimeout(1000);
  }

  const r3 = await nameOf(healed.body.message_id);
  check('heal read: the recovered message renders with the app name',
    r3 && r3.who === APP_NAME, r3 ? `got "${r3.who}"` : 'row not found');

  const asked = reads.join('\n');
  check('heal read no longer asks for the phantom bot_id column', !/bot_id/.test(asked));
  check('heal read no longer asks for the phantom webhook_id column', !/webhook_id/.test(asked));
  // The invariant, rather than the symptom. probe-projections proves the client
  // SENDS the list; only this can prove the list is true, because a projected
  // read naming a column that does not exist fails silently and retries with
  // '*'. Three names had been wrong here for the life of the feature.
  {
    const src = readFileSync('js/core/channels.js', 'utf8');
    const names = [...(/const HEAL_COLUMNS = \[([\s\S]*?)\];/.exec(src)?.[1] || '')
      .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const real = new Set(sql(`select column_name from information_schema.columns
                               where table_schema = 'public' and table_name = 'messages';`)
      .map((r) => r.column_name));
    const phantom = names.filter((n) => !real.has(n));
    check('every column in HEAL_COLUMNS is a real column on public.messages',
      names.length > 0 && phantom.length === 0,
      phantom.length ? 'phantom: ' + phantom.join(', ') : `${names.length} columns, all real`);
  }

  const stars = reads.filter((u) => /select=\*/.test(u));
  check('heal read did not fall back to select *', stars.length === 0,
    stars.map((u) => u.split('?')[1]?.slice(0, 90)).join(' | '));

  // ---- 4. the token is what the console says it is -----------------------
  const who = await (await fetch(`${FN}/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  check('whoami names the app', who?.app?.name === APP_NAME, who?.app?.name);
  check('whoami lists only the granted channel',
    who?.channels?.length === 1 && who.channels[0].name === channel,
    JSON.stringify(who?.channels));

  // last_used_at is the column the console leans on to answer "is this thing
  // still running", so it has to actually move.
  const [t] = sql(`select max(t.last_used_at) is not null as used
                     from public.app_tokens t join public.app_installs i on i.id = t.install_id
                    where i.app_id = '${appId}';`);
  check('the console can see that the token was used', t.used === true);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  await browser.close();
  teardown();
  server.close();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
