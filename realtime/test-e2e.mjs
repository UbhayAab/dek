// End to end proof that the Cloudflare realtime layer actually carries a
// message, against the live Worker and the live Supabase project.
//
// This exists because "it deployed" and "it works" are different claims. It
// signs in as a real user, opens a real socket, publishes through the same
// path Postgres will use, and asserts the frame arrives - and separately
// asserts that the things which must be refused are refused.
//
//   node realtime/test-e2e.mjs
//
// Env: DEK_EMAIL, DEK_PASS, PUBLISH_KEY (or it reads the key file written at
// deploy time).

const WORKER = process.env.DEK_WORKER || 'https://dek-realtime.ubhayvatsaanand.workers.dev';
const SUPA = 'https://ybddogqphinruyunnuwx.supabase.co';
const ANON = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';
const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';
// Fail loudly rather than run with no key. The first version fell back to ''
// on any read error, and on Windows node resolves '/tmp' to C:	mp while the
// shell that wrote the file means something else entirely - so the publish
// legs failed with "forbidden" and looked like a broken Worker rather than a
// missing argument. A test that can silently test nothing is worse than none.
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

// ---- 2. a workspace and a channel this user can actually see ------------
const spaces = await fetch(`${SUPA}/rest/v1/workspaces?select=id,name&limit=5`, {
  headers: { apikey: ANON, Authorization: `Bearer ${token}` },
}).then((r) => r.json());
if (!Array.isArray(spaces) || !spaces.length) { console.error('SETUP: no visible workspace'); process.exit(2); }

let ws = null; let chan = null;
for (const s of spaces) {
  const cs = await fetch(`${SUPA}/rest/v1/channels?workspace_id=eq.${s.id}&select=id,name&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  if (Array.isArray(cs) && cs.length) { ws = s; chan = cs[0]; break; }
}
if (!chan) { console.error('SETUP: no visible channel'); process.exit(2); }
console.log(`using workspace ${ws.name} / #${chan.name}`);

// ---- 3. the socket ------------------------------------------------------
const url = `${WORKER.replace(/^http/, 'ws')}/connect?ws=${ws.id}&token=${encodeURIComponent(token)}`;
const sock = new WebSocket(url);
const got = [];
const opened = await new Promise((res) => {
  const t = setTimeout(() => res(false), 15000);
  sock.onopen = () => { clearTimeout(t); res(true); };
  sock.onerror = () => { clearTimeout(t); res(false); };
  sock.onmessage = (e) => got.push(String(e.data));
});
check('an authorized user can open a socket', opened);
if (!opened) { console.log(`\n${failures} failed`); process.exit(1); }

// ---- 4. publish, the way Postgres will ----------------------------------
const pub = await fetch(`${WORKER}/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dek-key': KEY },
  body: JSON.stringify({
    workspace: ws.id, topic: chan.id, event: 'msg',
    payload: { probe: 'e2e', at: Date.now() },
  }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));
check('publish is accepted with the key', pub.ok === true, JSON.stringify(pub));
check('it reports delivering to the open socket', pub.sent >= 1, `sent=${pub.sent}`);

await new Promise((r) => setTimeout(r, 1500));
const frame = got.map((g) => { try { return JSON.parse(g); } catch { return null; } })
  .find((f) => f && f.payload && f.payload.probe === 'e2e');
check('the frame actually arrived on the socket', !!frame,
  frame ? `topic=${frame.topic} event=${frame.event}` : `got ${got.length} frames`);
check('it arrived on the right topic', frame?.topic === chan.id);

// ---- 5. the refusals ----------------------------------------------------
const noKey = await fetch(`${WORKER}/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspace: ws.id, topic: chan.id }),
}).then((r) => r.status);
check('publish without the key is refused', noKey === 403, `status ${noKey}`);

// No Upgrade header: undici refuses to send one. The Worker now answers the
// authorization question before it looks at the upgrade, so a plain GET gets
// the real verdict - 401 for a forged token, 403 for no access, 426 only when
// the caller WOULD have been allowed.
const badTok = await fetch(`${WORKER}/connect?ws=${ws.id}&token=not.a.jwt`)
  .then((r) => r.status);
check('a forged token cannot open a socket', badTok === 401, `status ${badTok}`);

// A real token, but for a workspace this user is not in, must yield nothing.
const fakeWs = '00000000-0000-0000-0000-000000000000';
const noAccess = await fetch(`${WORKER}/connect?ws=${fakeWs}&token=${encodeURIComponent(token)}`)
  .then((r) => r.status);
check('a workspace the user cannot see is refused', noAccess === 403, `status ${noAccess}`);

sock.close();
console.log(failures ? `\n${failures} failed` : '\nE2E CLEAN');
process.exit(failures ? 1 : 0);
