// Real uploads against the project, the way a browser does them: real auth users
// (admin API), PostgREST rpc and Storage uploads with the user's own token, the
// deployed media-finalize Edge Function, signed URLs. Not a rolled-back transaction:
// what it creates is committed, and after() removes all of it again, every Storage
// object included. Owner: [media]. PRD DEK10, DEK11, DEKA05, DEKA11.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { need, pgConfig } from '../../tools/lib/env.mjs';
import * as files from './_media-files.mjs';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PK, SUPABASE_SECRET_KEY: SK, DEK_INTERNAL_SECRET: INTERNAL } =
  need('SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'DEK_INTERNAL_SECRET');
const FN = `${SUPABASE_URL}/functions/v1/media-finalize`;
const RUN = `media-live-${randomUUID().slice(0, 8)}`;
const MB = 1024 * 1024;
const admin = createClient(SUPABASE_URL, SK, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new pg.Client({ ...pgConfig(), application_name: 'dek-media-live-test' });
const paths = new Set();
const w = {};

async function person(key) {
  const email = `${RUN}-${key}@dek-test.invalid`;
  const password = `Pw-${randomBytes(12).toString('base64url')}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: `Live ${key}` } });
  if (error) throw error;
  const client = createClient(SUPABASE_URL, PK, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e } = await client.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { id: data.user.id, client, token: s.session.access_token };
}

// Orgs of this test (or of a run that crashed), their Storage objects, then the rows.
async function removeOrgs(where, params) {
  const orgs = (await db.query(`select id from dek.orgs where ${where}`, params)).rows.map((r) => r.id);
  if (!orgs.length) return;
  const objs = (await db.query('select object_path, thumb_path from dek.attachments where org_id = any($1)', [orgs]))
    .rows.flatMap((r) => [r.object_path, r.thumb_path]).filter(Boolean);
  for (let i = 0; i < objs.length; i += 100) await admin.storage.from('media').remove(objs.slice(i, i + 100));
  await db.query('delete from dek.orgs where id = any($1)', [orgs]);
}

async function removeUsers(where, params) {
  const ids = (await db.query(`select id from auth.users where ${where}`, params)).rows.map((r) => r.id);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  if (ids.length) {
    await db.query('delete from dek.rate_buckets where user_id = any($1)', [ids]);
    await db.query('delete from dek.profiles where id = any($1)', [ids]);
  }
}

before(async () => {
  await db.connect();
  await removeOrgs("slug like 'media-live-%' and created_at < now() - interval '10 minutes'", []);
  await removeUsers("email like 'media-live-%@dek-test.invalid' and created_at < now() - interval '10 minutes'", []);
  w.alice = await person('alice');
  w.bob = await person('bob');
  w.eve = await person('eve');
  w.nobody = await person('nobody');   // signed up, in no organization
  const q = async (sql, params) => (await db.query(sql, params)).rows[0];
  w.org = (await q("insert into dek.orgs (slug, name) values ($1, 'Media Live') returning id", [RUN])).id;
  w.other = (await q("insert into dek.orgs (slug, name) values ($1, 'Media Live Other') returning id", [`${RUN}-x`])).id;
  await db.query(`insert into dek.org_members (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
    [w.org, w.alice.id, w.bob.id, w.other, w.eve.id]);
  const server = (await q("insert into dek.servers (org_id, name) values ($1, 'Team') returning id", [w.org])).id;
  await db.query("insert into dek.server_members (server_id, user_id, org_id) values ($1, $2, $4), ($1, $3, $4)",
    [server, w.alice.id, w.bob.id, w.org]);
  w.channel = (await q("insert into dek.channels (org_id, server_id, kind, name) values ($1, $2, 'text', 'general') returning id",
    [w.org, server])).id;
  await db.query('insert into dek.channel_members (channel_id, user_id, org_id) values ($1, $2, $4), ($1, $3, $4)',
    [w.channel, w.alice.id, w.bob.id, w.org]);
});

after(async () => {
  try {
    if (paths.size) await admin.storage.from('media').remove([...paths]);
    await removeOrgs('slug like $1', [`${RUN}%`]);
    await removeUsers('email like $1', [`${RUN}-%@dek-test.invalid`]);
    const left = (await db.query("select count(*)::int n from storage.objects where bucket_id = 'media' and name = any($1)", [[...paths]])).rows[0].n;
    assert.equal(left, 0, 'every object this run uploaded is gone');
  } finally {
    await db.end();
  }
});

async function rpc(who, fn, args) {
  const { data, error } = await who.client.schema('api').rpc(fn, args);
  if (error) throw Object.assign(new Error(`${error.message}: ${error.hint}`), { code: error.message });
  return data;
}
const begin = (who, name, mime, size, thumb = false) =>
  rpc(who, 'begin_upload', { p_channel: w.channel, p_file_name: name, p_mime: mime, p_size: size, p_with_thumb: thumb });
async function put(who, path, bytes, contentType) {
  paths.add(path);
  const { error } = await who.client.storage.from('media').upload(path, bytes, { contentType, upsert: false });
  return error;
}
async function finalize(token, body) {
  const r = await fetch(FN, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, apikey: PK, 'Content-Type': 'application/json' } });
  return { status: r.status, body: await r.json() };
}
const stored = async (path) =>
  (await db.query("select metadata from storage.objects where bucket_id = 'media' and name = $1", [path])).rows[0] ?? null;
const att = async (id) => (await db.query('select * from dek.attachments where id = $1', [id])).rows[0];
// Media links come only from the media-sign function (0900, 0907, 0909): 15 minutes,
// after the access check. Direct Storage signing is refused for everyone.
const MS = FN.replace('media-finalize', 'media-sign');
const signed = async (who, path) => {
  const r = await fetch(MS, { method: 'POST', body: JSON.stringify({ paths: [path] }),
    headers: { Authorization: `Bearer ${who.token}`, apikey: PK, 'Content-Type': 'application/json' } });
  const url = r.ok ? (await r.json()).urls?.[path] : null;
  return url ? { data: { signedUrl: url }, error: null } : { data: null, error: new Error(`no link (${r.status})`) };
};
const directSigned = (who, path) => who.client.storage.from('media').createSignedUrl(path, 900);

test('a JPEG with a 90 KB header block and a thumbnail: ready, readable by the channel, not by the other tenant (DEK10, DEK11, DEKA05)', async () => {
  const jpg = files.jpeg(320, 240, { padding: 90000 });
  const thumb = files.png(16, 12);
  const r = await begin(w.alice, 'Holiday photo.jpg', 'image/jpeg', jpg.length, true);
  assert.equal(await put(w.alice, r.path, jpg, 'image/jpeg'), null, 'the reserver uploads straight to Storage');
  assert.equal(await put(w.alice, r.thumb_path, thumb, 'image/png'), null);
  assert.ok((await signed(w.alice, r.path)).error, 'pending: no URL for anyone, not even the uploader');

  const f = await finalize(w.alice.token, { attachment_id: r.attachment_id });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const a = f.body.attachment;
  assert.equal(a.status, 'ready');
  assert.equal(a.mime_type, 'image/jpeg');
  assert.equal(a.size_bytes, jpg.length);
  assert.deepEqual([a.width, a.height], [320, 240], 'frame header found past the first 64 KB');
  assert.equal(a.thumb_path, r.thumb_path);
  assert.equal(a.file_name, 'Holiday photo.jpg');
  assert.equal((await finalize(w.alice.token, { attachment_id: r.attachment_id })).status, 200, 'a retry is fine');

  const s = await signed(w.bob, r.path);
  assert.equal(s.error, null, 'a channel member gets a 15 minute URL from media-sign');
  assert.ok((await directSigned(w.bob, r.path)).error, 'but cannot mint one through Storage directly');
  assert.ok((await directSigned(w.alice, r.path)).error, 'nor can the uploader');
  const got = Buffer.from(await (await fetch(s.data.signedUrl)).arrayBuffer());
  assert.ok(got.equals(jpg), 'and gets exactly the bytes');
  assert.equal((await signed(w.bob, r.thumb_path)).error, null);

  assert.ok((await signed(w.eve, r.path)).error, 'the other tenant guessing the path gets no URL (DEKA05)');
  assert.ok((await w.eve.client.storage.from('media').download(r.path)).error, 'nor the bytes with her own token');
  assert.ok((await signed(w.eve, r.thumb_path)).error, 'nor the thumbnail');
  assert.ok(await put(w.alice, r.path, files.png(), 'image/png'), 'nobody overwrites a ready file');
  const upsert = await w.alice.client.storage.from('media').upload(r.path, files.png(), { contentType: 'image/png', upsert: true });
  assert.ok(upsert.error, 'not even with upsert');
  const again = Buffer.from(await (await fetch((await signed(w.bob, r.path)).data.signedUrl)).arrayBuffer());
  assert.ok(again.equals(jpg), 'the bytes are still the original');
});

test('a thumbnail that is not a picture is removed once the file is ready; the file itself is fine', async () => {
  const png = files.png(40, 30);
  const r = await begin(w.bob, 'scan.png', 'image/png', png.length, true);
  await put(w.bob, r.path, png, 'image/png');
  await put(w.bob, r.thumb_path, Buffer.from('<html><script>alert(1)</script></html>'), 'image/webp');
  const f = await finalize(w.bob.token, { attachment_id: r.attachment_id });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.attachment.status, 'ready');
  assert.equal(f.body.attachment.thumb_path, null, 'no thumbnail to show');
  assert.equal(await stored(r.thumb_path), null, 'and its bytes are gone');
  assert.equal((await att(r.attachment_id)).thumb_path, null);
});

test('turn: relay credentials for organization members; refused for people in no organization', async () => {
  const call = (token) => fetch(`${SUPABASE_URL}/functions/v1/turn`, { headers: { Authorization: `Bearer ${token}`, apikey: PK } });
  const ok = await call(w.alice.token);
  const j = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(j));
  assert.equal(typeof j.relay, 'boolean');
  if (j.relay) {
    assert.ok(j.iceServers.some((s) => s.urls.some((u) => /^turns?:/.test(u)) && s.username && s.credential), 'TURN urls with credentials');
    assert.ok(j.iceServers.every((s) => s.urls.every((u) => !/:53(\?|$)/.test(u))), 'no :53 alternates');
    assert.ok(j.ttl > 5 * 3600 && Date.parse(j.expires_at) > Date.now());
  } else {
    assert.ok(['not_configured', 'unavailable'].includes(j.reason));
  }
  assert.equal((await call(w.nobody.token)).status, 403, 'signed up but in no organization');
  assert.equal((await call(PK)).status, 401, 'the publishable key is not a person');
});

test('a PNG: ready with its real dimensions', async () => {
  const png = files.png(32, 24);
  const r = await begin(w.bob, 'chart.png', 'image/png', png.length);
  assert.equal(await put(w.bob, r.path, png, 'image/png'), null);
  const f = await finalize(w.bob.token, { attachment_id: r.attachment_id });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.status, 'ready');
  assert.deepEqual([f.body.attachment.mime_type, f.body.attachment.width, f.body.attachment.height, f.body.attachment.thumb_path],
    ['image/png', 32, 24, null]);
});

test('an empty upload is a clean rejection, never a stuck pending row', async () => {
  const r = await begin(w.alice, 'blank.txt', 'text/plain', 10);
  const refused = await put(w.alice, r.path, Buffer.alloc(0), 'text/plain');
  const f = await finalize(w.alice.token, { attachment_id: r.attachment_id });
  if (refused) {
    assert.deepEqual([f.status, f.body.error], [409, 'not_uploaded'], 'Storage refused the empty body');
    return;
  }
  assert.equal(f.status, 422, JSON.stringify(f.body));
  assert.deepEqual([f.body.status, f.body.reason, f.body.reject_reason], ['rejected', 'empty', 'empty']);
  assert.equal(await stored(r.path), null);
});

test('a voice note (WebM audio) gets its length from the header; a Word document and a CSV pass', async () => {
  const voice = files.webm({ durationMs: 4200 });
  const v = await begin(w.alice, 'voice-note.webm', 'audio/webm;codecs=opus', voice.length);
  await put(w.alice, v.path, voice, 'audio/webm');
  const fv = await finalize(w.alice.token, { attachment_id: v.attachment_id, duration_ms: 99999 });
  assert.equal(fv.status, 200, JSON.stringify(fv.body));
  assert.deepEqual([fv.body.attachment.mime_type, fv.body.attachment.duration_ms], ['audio/webm', 4200], 'the header wins over the hint');
  const doc = files.docx();
  const d = await begin(w.alice, 'Minutes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc.length);
  await put(w.alice, d.path, doc, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal((await finalize(w.alice.token, { attachment_id: d.attachment_id })).status, 200);
  const csv = Buffer.from('name,amount\nप्रिया,1200\n', 'utf8');
  const c = await begin(w.alice, 'donations.csv', 'application/vnd.ms-excel', csv.length);
  assert.equal(c.mime, 'text/csv', 'Windows calls CSV files Excel; the server knows better');
  await put(w.alice, c.path, csv, c.mime);
  const fc = await finalize(w.alice.token, { attachment_id: c.attachment_id });
  assert.equal(fc.status, 200, JSON.stringify(fc.body));
  assert.equal(fc.body.attachment.mime_type, 'text/csv');
});

test('a program renamed from .exe to .jpg is rejected and its bytes are removed (DEKA11)', async () => {
  const exe = files.exe();
  const r = await begin(w.alice, 'holiday.jpg', 'image/jpeg', exe.length);
  assert.equal(await put(w.alice, r.path, exe, 'image/jpeg'), null);
  assert.ok(await stored(r.path), 'the upload landed in Storage');
  const f = await finalize(w.alice.token, { attachment_id: r.attachment_id });
  assert.equal(f.status, 422, JSON.stringify(f.body));
  assert.equal(f.body.error, 'rejected');
  assert.equal(f.body.status, 'rejected', 'the client parser keys on status');
  assert.equal(f.body.reason, 'executable');
  assert.match(f.body.message, /program/i);
  assert.equal(await stored(r.path), null, 'gone from Storage');
  const a = await att(r.attachment_id);
  assert.deepEqual([a.status, a.reject_reason], ['rejected', 'executable']);
  assert.ok(a.purged_at, 'nothing left for the purge');
  assert.ok((await signed(w.alice, r.path)).error, 'never readable');
  assert.equal((await finalize(w.alice.token, { attachment_id: r.attachment_id })).status, 422, 'asking again, same answer');
  await assert.rejects(begin(w.alice, 'holiday.exe', 'application/x-msdownload', exe.length),
    (e) => e.code === 'invalid_input', 'and under its real name it is refused before any byte moves');
});

test('an upload Storage would serve as a web page is refused, even with harmless bytes', async () => {
  const txt = Buffer.from('hello\n');
  const r = await begin(w.alice, 'notes.txt', 'text/plain', txt.length);
  // 0900: the bucket's allow-list refuses text/html before a byte is stored
  assert.ok(await put(w.alice, r.path, txt, 'text/html'), 'Storage refuses the web page type');
  assert.equal(await stored(r.path), null);
  const f = await finalize(w.alice.token, { attachment_id: r.attachment_id });
  assert.deepEqual([f.status, f.body.error], [409, 'not_uploaded']);
});

test('oversize declared sizes are refused at begin_upload; nothing is reserved', async () => {
  await assert.rejects(begin(w.alice, 'huge.jpg', 'image/jpeg', 25 * MB + 1), (e) => e.code === 'invalid_input');
  await assert.rejects(begin(w.alice, 'huge.mp4', 'video/mp4', 100 * MB + 1), (e) => e.code === 'invalid_input');
  const n = (await db.query("select count(*)::int n from dek.attachments where org_id = $1 and file_name like 'huge.%'", [w.org])).rows[0].n;
  assert.equal(n, 0);
});

test('finalize: the signed-in uploader only; a missing upload stays pending; abort closes the path', async () => {
  const r = await begin(w.alice, 'later.pdf', 'application/pdf', 100);
  assert.equal((await finalize('not-a-token', { attachment_id: r.attachment_id })).status, 401);
  assert.equal((await finalize(PK, { attachment_id: r.attachment_id })).status, 401, 'the publishable key is not a person');
  assert.equal((await finalize(w.eve.token, { attachment_id: r.attachment_id })).status, 404, 'the other tenant');
  assert.equal((await finalize(w.bob.token, { attachment_id: r.attachment_id })).status, 404, 'a channel member who did not upload it');
  assert.equal((await finalize(w.alice.token, { attachment_id: 'nope' })).status, 400);
  const nu = await finalize(w.alice.token, { attachment_id: r.attachment_id });
  assert.deepEqual([nu.status, nu.body.error], [409, 'not_uploaded']);
  assert.equal((await att(r.attachment_id)).status, 'pending');
  assert.equal((await fetch(FN, { method: 'GET', headers: { Authorization: `Bearer ${w.alice.token}` } })).status, 405);
  assert.deepEqual(await rpc(w.alice, 'abort_upload', { p_attachment: r.attachment_id }), { aborted: true });
  assert.ok(await put(w.alice, r.path, files.pdf(), 'application/pdf'), 'an aborted reservation takes no bytes');
});

test('purge: deleted files leave Storage; the internal secret is required', async () => {
  const pdf = files.pdf();
  const r = await begin(w.bob, 'old minutes.pdf', 'application/pdf', pdf.length);
  await put(w.bob, r.path, pdf, 'application/pdf');
  assert.equal((await finalize(w.bob.token, { attachment_id: r.attachment_id })).status, 200);
  await db.query("update dek.attachments set status = 'deleted', deleted_at = now() where id = $1", [r.attachment_id]);
  const call = (secret) => fetch(FN, { method: 'POST', body: JSON.stringify({ action: 'purge' }),
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-dek-internal': secret } : {}) } });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('not-the-secret')).status, 401);
  const ok = await call(INTERNAL);
  const j = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(j));
  assert.ok(j.purged >= 1);
  assert.equal(await stored(r.path), null, 'the bytes are gone');
  assert.ok((await att(r.attachment_id)).purged_at);
});

test('the daily job reaches media-finalize through pg_net and the bytes go', async () => {
  const png = files.png(8, 8);
  const r = await begin(w.bob, 'scratch.png', 'image/png', png.length);
  await put(w.bob, r.path, png, 'image/png');
  assert.equal((await finalize(w.bob.token, { attachment_id: r.attachment_id })).status, 200);
  await db.query("update dek.attachments set status = 'deleted', deleted_at = now() where id = $1", [r.attachment_id]);
  await db.query('select dek.media_purge_tick()');   // what cron runs at 02:41 IST; pg_net sends after commit
  const deadline = Date.now() + 45000;
  while (await stored(r.path) && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 1000));
  assert.equal(await stored(r.path), null, 'removed by the function the job called');
  assert.ok((await att(r.attachment_id)).purged_at);
});
