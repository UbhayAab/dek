// End to end proof that the Cloudflare realtime layer carries real traffic,
// against the live Worker and the live Supabase project.
//
// "It deployed" and "it works" are different claims. This signs in as a real
// user, opens BOTH sockets, publishes the way Postgres will, and asserts the
// frames arrive - then asserts that the things which must be refused are.
//
//   PUBLISH_KEY=$(cat <keyfile>) node realtime/test-e2e.mjs
const WORKER = process.env.DEK_WORKER || 'https://dek-realtime.ubhayvatsaanand.workers.dev';
const SUPA = 'https://ybddogqphinruyunnuwx.supabase.co';
const ANON = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';
const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

// Fail loudly rather than run with no key. An earlier version fell back to ''
// on any read error, and the publish legs then failed with "forbidden" and
// looked like a broken Worker rather than a missing argument. A test that can
// silently test nothing is worse than no test.
const KEY = (process.env.PUBLISH_KEY || '').trim();
if (!KEY) {
  console.error('SETUP: PUBLISH_KEY is not set. Run with:');
  console.error('  PUBLISH_KEY=$(cat <keyfile>) node realtime/test-e2e.mjs');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = (url) => new Promise((res) => {
  const s = new WebSocket(url);
  const got = [];
  const t = setTimeout(() => res({ ok: false, got, sock: s }), 15000);
  s.onopen = () => { clearTimeout(t); res({ ok: true, got, sock: s }); };
  s.onerror = () => { clearTimeout(t); res({ ok: false, got, sock: s }); };
  s.onmessage = (e) => got.push(String(e.data));
});
const found = (got, tag) => got
  .map((g) => { try { return JSON.parse(g); } catch { return null; } })
  .find((f) => f && f.payload && f.payload.probe === tag);

const post = (path, body) => fetch(`${WORKER}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dek-key': KEY },
  body: JSON.stringify(body),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

// ---- 1. a real session --------------------------------------------------
const auth = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
}).then((r) => r.json());
if (!auth.access_token) { console.error('SETUP: could not sign in:', auth); process.exit(2); }
const token = auth.access_token;
const uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
console.log(`signed in as ${EMAIL} (${uid.slice(0, 8)}...)`);

// ---- 2. a workspace and channel this user can actually see --------------
const spaces = await fetch(`${SUPA}/rest/v1/workspaces?select=id,name&limit=5`, {
  headers: { apikey: ANON, Authorization: `Bearer ${token}` },
}).then((r) => r.json());
let ws = null; let chan = null;
for (const s of spaces || []) {
  const cs = await fetch(`${SUPA}/rest/v1/channels?workspace_id=eq.${s.id}&select=id,name&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  if (Array.isArray(cs) && cs.length) { ws = s; chan = cs[0]; break; }
}
if (!chan) { console.error('SETUP: no visible channel'); process.exit(2); }
console.log(`using workspace ${ws.name} / #${chan.name}`);

// ---- 3. both sockets ----------------------------------------------------
const WSU = WORKER.replace(/^http/, 'ws');
const space = await open(`${WSU}/connect?ws=${ws.id}&token=${encodeURIComponent(token)}`);
check('the SPACE socket opens', space.ok);
const inbox = await open(`${WSU}/connect/inbox?token=${encodeURIComponent(token)}`);
check('the INBOX socket opens', inbox.ok);
if (!space.ok || !inbox.ok) { console.log(`\n${failures} failed`); process.exit(1); }

// ---- 4. publish to each -------------------------------------------------
const p1 = await post('/publish', {
  room: `ws:${ws.id}`, topic: chan.id, event: 'msg', payload: { probe: 'space' },
});
check('publish to the space room is accepted', p1.ok === true, JSON.stringify(p1));
check('the space room reports delivering', p1.sent >= 1, `sent=${p1.sent}`);

const p2 = await post('/publish', {
  room: `u:${uid}`, topic: uid, event: 'mention', payload: { probe: 'inbox' },
});
check('publish to the personal inbox is accepted', p2.ok === true, JSON.stringify(p2));
check('the inbox reports delivering', p2.sent >= 1, `sent=${p2.sent}`);

await sleep(1500);
check('the space frame arrived on the SPACE socket', !!found(space.got, 'space'));
check('the inbox frame arrived on the INBOX socket', !!found(inbox.got, 'inbox'));
// Separate Durable Objects. Traffic must not cross between them.
check('space traffic did NOT leak into the inbox', !found(inbox.got, 'space'));
check('inbox traffic did NOT leak into the space', !found(space.got, 'inbox'));

// ---- 5. the batch path Postgres will use --------------------------------
const b = await post('/publish/batch', {
  sends: [
    { room: `ws:${ws.id}`, topic: chan.id, event: 'msg', payload: { probe: 'batch-space' } },
    { room: `u:${uid}`, topic: uid, event: 'mention', payload: { probe: 'batch-inbox' } },
  ],
});
check('a batch publish is accepted', b.ok === true, JSON.stringify(b).slice(0, 90));
await sleep(1500);
check('both halves of the batch arrived',
  !!found(space.got, 'batch-space') && !!found(inbox.got, 'batch-inbox'));

// ---- 6. revocation ------------------------------------------------------
const k = await post('/kick', { room: `ws:${ws.id}`, user: uid });
check("kick closes that user's sockets in that room", k.ok === true && k.closed >= 1,
  JSON.stringify(k));

// ---- 7. the refusals ----------------------------------------------------
const noKey = await fetch(`${WORKER}/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ room: `ws:${ws.id}`, topic: chan.id }),
}).then((r) => r.status);
check('publish without the key is refused', noKey === 403, `status ${noKey}`);

const badTok = await fetch(`${WORKER}/connect?ws=${ws.id}&token=not.a.jwt`).then((r) => r.status);
check('a forged token cannot open a space socket', badTok === 401, `status ${badTok}`);

const badInbox = await fetch(`${WORKER}/connect/inbox?token=not.a.jwt`).then((r) => r.status);
check('a forged token cannot open an inbox socket', badInbox === 401, `status ${badInbox}`);

const fakeWs = '00000000-0000-0000-0000-000000000000';
const noAccess = await fetch(`${WORKER}/connect?ws=${fakeWs}&token=${encodeURIComponent(token)}`)
  .then((r) => r.status);
check('a workspace the user cannot see is refused', noAccess === 403, `status ${noAccess}`);

try { space.sock.close(); inbox.sock.close(); } catch { /* kick may have closed one */ }
console.log(failures ? `\n${failures} failed` : '\nE2E CLEAN');
process.exit(failures ? 1 : 0);
