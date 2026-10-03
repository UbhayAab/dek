// Media uploads: api.begin_upload, api.abort_upload, the svc_* functions media-finalize
// uses, the Storage policies on reserved paths, and the daily purge trigger. Owner: [media].
// PRD DEK10, DEK11, DEKA05, DEKA11. Real bytes and the Edge Function: media-live.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError, DekError } from './_harness.mjs';

const MB = 1024 * 1024;

const begin = (db, uid, channel, name = 'photo.jpg', mime = 'image/jpeg', size = 1000, thumb = false) =>
  db.call(uid, 'begin_upload', { p_channel: channel, p_file_name: name, p_mime: mime, p_size: size, p_with_thumb: thumb });

// Call api.<fn> the way the Edge Function does: role service_role.
let spn = 0;
async function svc(db, fn, args = {}) {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => args[k]);
  const sp = `media_svc_${++spn}`;
  await db.c.query(`savepoint ${sp}`);
  try {
    await db.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    await db.c.query('set local role service_role');
    const res = await db.c.query(`select api.${fn}(${named}) as result`, values);
    await db.c.query('reset role');
    await db.c.query(`release savepoint ${sp}`);
    return res.rows[0]?.result;
  } catch (e) {
    await db.c.query(`rollback to savepoint ${sp}`);
    await db.c.query('reset role');
    throw new DekError(e.message, e.hint, e.code);
  }
}

// A Storage object row as the Storage server would leave it after an upload. The
// test transaction rolls it back; no bytes exist anywhere.
const fakeObject = (db, name, size, mimetype = 'image/jpeg') =>
  db.q("insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)",
    [name, JSON.stringify({ size, mimetype })]);

const row = (db, id) => db.one('select * from dek.attachments where id = $1', [id]);
// Tests that reserve many files settle each one, so the cap of 20 in flight stays out of the way.
const settle = (db, id) => db.q("update dek.attachments set status = 'rejected', reject_reason = 'test' where id = $1", [id]);

test('begin_upload: reserves a pending attachment at org/channel/attachment/safe name', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await begin(db, f.alice, f.general, 'Team photo.JPG', 'image/jpeg', 123456, true);
  assert.equal(r.bucket, 'media');
  assert.match(r.attachment_id, /^[0-9a-f-]{36}$/);
  assert.equal(r.path, `${f.org}/${f.general}/${r.attachment_id}/Team_photo.jpg`);
  assert.equal(r.thumb_path, `${f.org}/${f.general}/${r.attachment_id}/thumb.webp`);
  assert.equal(r.max_bytes, 25 * MB);
  assert.equal(r.mime, 'image/jpeg');
  const a = await row(db, r.attachment_id);
  assert.equal(a.status, 'pending');
  assert.equal(a.uploader_id, f.alice);
  assert.equal(a.org_id, f.org);
  assert.equal(a.channel_id, f.general);
  assert.equal(a.file_name, 'Team photo.JPG', 'the original name is kept for people');
  assert.equal(a.object_path, r.path);
  assert.equal(Number(a.size_bytes), 123456);
  assert.equal(a.message_id, null);

  // a thumbnail is only reserved for images and video
  const pdf = await begin(db, f.alice, f.general, 'notes.pdf', 'application/pdf', 1000, true);
  assert.equal(pdf.thumb_path, null);
  const vid = await begin(db, f.alice, f.general, 'clip.mp4', 'video/mp4', 50 * MB, true);
  assert.equal(vid.max_bytes, 100 * MB);
  assert.ok(vid.thumb_path.endsWith('/thumb.webp'));

  // a guest posts in the private channel she was added to; DMs work too
  const g = await begin(db, f.guest, f.grants, 'budget.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 2000);
  assert.ok(g.path.startsWith(`${f.org}/${f.grants}/`));
  await begin(db, f.bob, f.dmAliceBob, 'voice-note.webm', 'audio/webm;codecs=opus', 40000);
}));

test('begin_upload: names are sanitised for the path and kept for people', () => tx(async (db) => {
  const f = await db.fixture();
  const cases = [
    ['Report Q3 (final) v2.PDF', 'application/pdf', 'Report_Q3_final_v2.pdf', 'Report Q3 (final) v2.PDF'],
    ['\u0930\u093f\u092a\u094b\u0930\u094d\u091f.pdf', 'application/pdf', 'file.pdf', '\u0930\u093f\u092a\u094b\u0930\u094d\u091f.pdf'],
    ['../../etc/passwd.txt', 'text/plain', 'passwd.txt', 'passwd.txt'],
    ['C:\\fakepath\\scan.png', 'image/png', 'scan.png', 'scan.png'],
    ['thumb.webp', 'image/webp', 'image.webp', 'thumb.webp'],
    ['  .hidden.csv ', 'text/csv', 'hidden.csv', '.hidden.csv'],
    ['bill\u202Egnp.pdf', 'application/pdf', 'billgnp.pdf', 'billgnp.pdf'],
  ];
  for (const [name, mime, safe, display] of cases) {
    const r = await begin(db, f.alice, f.general, name, mime, 10);
    assert.equal(r.path.split('/')[3], safe, `safe name for ${JSON.stringify(name)}`);
    assert.equal((await row(db, r.attachment_id)).file_name, display, `display name for ${JSON.stringify(name)}`);
  }
  const long = await begin(db, f.alice, f.general, `${'a'.repeat(300)}.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10);
  const safe = long.path.split('/')[3];
  assert.equal(safe.length, 120);
  assert.ok(safe.endsWith('.docx'));
  const a = await row(db, long.attachment_id);
  assert.equal(a.file_name.length, 200);
  assert.ok(a.file_name.endsWith('.docx'));
  for (const r of await db.q('select object_path from dek.attachments where uploader_id = $1', [f.alice])) {
    assert.match(r.object_path.split('/')[3], /^[A-Za-z0-9._-]{1,120}$/);
  }
  await expectError(begin(db, f.alice, f.general, '   ', 'text/plain', 10), 'invalid_input');
}));

test('begin_upload: the allow-list, aliases and type inference', () => tx(async (db) => {
  const f = await db.fixture();
  const ok = [
    ['a.jpg', 'image/jpg', 'image/jpeg'], ['a.png', 'IMAGE/PNG', 'image/png'], ['a.gif', 'image/gif', 'image/gif'],
    ['a.webp', 'image/webp', 'image/webp'], ['a.heic', 'image/heic', 'image/heic'], ['a.avif', 'image/avif', 'image/avif'],
    ['a.mp4', 'video/mp4', 'video/mp4'], ['a.webm', 'video/webm', 'video/webm'], ['a.mov', 'video/quicktime', 'video/quicktime'],
    ['a.mp3', 'audio/mp3', 'audio/mpeg'], ['a.m4a', 'audio/x-m4a', 'audio/mp4'], ['a.ogg', 'audio/ogg', 'audio/ogg'],
    ['a.wav', 'audio/x-wav', 'audio/wav'], ['a.aac', 'audio/aac', 'audio/aac'], ['a.pdf', 'application/pdf', 'application/pdf'],
    ['a.txt', 'text/plain; charset=utf-8', 'text/plain'], ['a.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['a.doc', 'application/msword', 'application/msword'], ['a.zip', 'application/x-zip-compressed', 'application/zip'],
    ['a.odt', 'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.text'],
    ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    // the browser could not name it: the extension decides
    ['a.heic', '', 'image/heic'], ['a.m4a', 'application/octet-stream', 'audio/mp4'],
  ];
  for (const [name, mime, want] of ok) {
    const r = await begin(db, f.alice, f.general, name, mime, 10);
    assert.equal(r.mime, want, `${name} ${mime}`);
    assert.equal((await row(db, r.attachment_id)).mime_type, want);
    await settle(db, r.attachment_id);
  }
  for (const [name, mime] of [['a.bmp', 'image/bmp'], ['a.tiff', 'image/tiff'], ['a.mkv', 'video/x-matroska'],
    ['a.rar', 'application/vnd.rar'], ['a.7z', 'application/x-7z-compressed'], ['a.json', 'application/json'],
    ['a.bin', 'application/octet-stream'], ['a', ''], ['a.rtf', 'application/rtf']]) {
    await expectError(begin(db, f.alice, f.general, name, mime, 10), 'invalid_input');
  }
}));

test('begin_upload: programs, scripts and web pages are refused by extension and by type', () => tx(async (db) => {
  const f = await db.fixture();
  const refused = [
    ['setup.exe', 'image/jpeg'], ['photo.jpg.exe', 'image/jpeg'], ['run.bat', 'text/plain'], ['x.ps1', 'text/plain'],
    ['install.msi', 'application/zip'], ['app.apk', 'application/zip'], ['lib.jar', 'application/zip'],
    ['page.html', 'text/plain'], ['logo.svg', 'image/png'], ['budget.xlsm', 'application/vnd.ms-excel'],
    ['macro.docm', 'application/msword'], ['script.js', 'text/plain'], ['tool.sh', 'text/plain'],
    ['disk.iso', 'application/zip'], ['link.lnk', 'application/pdf'],
    ['innocent.png', 'application/x-msdownload'], ['innocent.txt', 'text/html'], ['innocent.png', 'image/svg+xml'],
    ['innocent.txt', 'application/javascript'], ['innocent.zip', 'application/java-archive'],
    ['innocent.xlsx', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    // Windows drops trailing dots and spaces when it saves the download
    ['run.bat.', 'text/plain'], ['run.bat. . ', 'text/plain'], ['notes.txt:evil.exe', 'text/plain'],
    ['setup.appref-ms', 'application/zip'], ['deploy.application', 'application/zip'],
  ];
  for (const [name, mime] of refused) {
    const e = await expectError(begin(db, f.alice, f.general, name, mime, 10), 'invalid_input');
    assert.match(e.hint, /programs|not|Dek takes/i, `${name} ${mime}`);
  }
  const n = await db.one('select count(*)::int n from dek.attachments where uploader_id = $1', [f.alice]);
  assert.equal(n.n, 0, 'nothing was reserved');
}));

test('begin_upload: 100 MB for video, 25 MB for everything else, no empty files', () => tx(async (db) => {
  const f = await db.fixture();
  await begin(db, f.alice, f.general, 'v.mp4', 'video/mp4', 100 * MB);
  await expectError(begin(db, f.alice, f.general, 'v.mp4', 'video/mp4', 100 * MB + 1), 'invalid_input');
  await begin(db, f.alice, f.general, 'i.jpg', 'image/jpeg', 25 * MB);
  const e = await expectError(begin(db, f.alice, f.general, 'i.jpg', 'image/jpeg', 25 * MB + 1), 'invalid_input');
  assert.match(e.hint, /25 MB/);
  await expectError(begin(db, f.alice, f.general, 'a.wav', 'audio/wav', 26 * MB), 'invalid_input');
  await expectError(begin(db, f.alice, f.general, 'd.pdf', 'application/pdf', 30 * MB), 'invalid_input');
  await expectError(begin(db, f.alice, f.general, 'e.txt', 'text/plain', 0), 'invalid_input');
  await expectError(begin(db, f.alice, f.general, 'e.txt', 'text/plain', -5), 'invalid_input');
}));

test('begin_upload: denied without post permission (stranger, other tenant, guest, suspended, cross-team)', () => tx(async (db) => {
  const f = await db.fixture();
  const anon = await expectError(begin(db, null, f.general));
  assert.equal(anon.sqlstate, '42501', 'anonymous callers are refused by the grant itself');
  await expectError(begin(db, f.stranger, f.general), 'not_found');
  await expectError(begin(db, f.eve, f.general), 'not_found');
  await expectError(begin(db, f.alice, f.otherChannel), 'not_found');
  await expectError(begin(db, f.guest, f.general), 'not_found');
  await expectError(begin(db, f.suspended, f.general), 'not_found');
  await expectError(begin(db, f.carol, f.general), 'not_found');
  await expectError(begin(db, f.bob, f.grants), 'not_found');
  await expectError(begin(db, f.carol, f.dmAliceBob), 'not_found');
  // read only: archived channel, announcement channel for a plain member, blocked DM
  await db.q("update dek.channels set posting_policy = 'admins' where id = $1", [f.general]);
  await expectError(begin(db, f.alice, f.general), 'forbidden');
  await begin(db, f.owner, f.general);
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.general]);
  await expectError(begin(db, f.owner, f.general), 'archived');
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  await expectError(begin(db, f.alice, f.dmAliceBob), 'blocked');
}));

test('begin_upload: rate limit 60 per 10 minutes', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 0; i < 60; i += 1) await settle(db, (await begin(db, f.alice, f.general, `p${i}.png`, 'image/png', 10)).attachment_id);
  const e = await expectError(begin(db, f.alice, f.general, 'one-more.png', 'image/png', 10), 'rate_limited');
  assert.match(e.hint, /Try again in/);
  await begin(db, f.bob, f.general, 'bob.png', 'image/png', 10);   // per person
}));

test('begin_upload: at most 20 reservations in flight per person', () => tx(async (db) => {
  const f = await db.fixture();
  const first = await begin(db, f.alice, f.general, 'p0.png', 'image/png', 10);
  for (let i = 1; i < 20; i += 1) await begin(db, f.alice, f.general, `p${i}.png`, 'image/png', 10);
  const e = await expectError(begin(db, f.alice, f.general, 'p20.png', 'image/png', 10), 'rate_limited');
  assert.match(e.hint, /uploads in progress/);
  await begin(db, f.bob, f.general, 'bob.png', 'image/png', 10);   // per person
  await db.call(f.alice, 'abort_upload', { p_attachment: first.attachment_id });
  await begin(db, f.alice, f.general, 'p21.png', 'image/png', 10);   // finishing one frees a slot
}));

test('abort_upload: uploader only, pending only, idempotent', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await begin(db, f.alice, f.general);
  await expectError(db.call(f.bob, 'abort_upload', { p_attachment: r.attachment_id }), 'not_found');
  await expectError(db.call(f.eve, 'abort_upload', { p_attachment: r.attachment_id }), 'not_found');
  await expectError(db.call(f.stranger, 'abort_upload', { p_attachment: r.attachment_id }), 'not_found');
  await expectError(db.call(f.alice, 'abort_upload', { p_attachment: '00000000-0000-0000-0000-000000000000' }), 'not_found');
  assert.deepEqual(await db.call(f.alice, 'abort_upload', { p_attachment: r.attachment_id }), { aborted: true });
  const a = await row(db, r.attachment_id);
  assert.equal(a.status, 'rejected');
  assert.equal(a.reject_reason, 'aborted');
  assert.deepEqual(await db.call(f.alice, 'abort_upload', { p_attachment: r.attachment_id }), { aborted: true });
  // after abort the reserved path no longer accepts bytes
  const can = await db.as(f.alice, 'select dek.can_write_object($1) as ok', [r.path]);
  assert.equal(can[0].ok, false);
  // a finished upload cannot be aborted
  const done = await begin(db, f.alice, f.general, 'done.jpg');
  await db.q("update dek.attachments set status = 'ready' where id = $1", [done.attachment_id]);
  await expectError(db.call(f.alice, 'abort_upload', { p_attachment: done.attachment_id }), 'conflict');
  // a suspended uploader cannot act in the org
  const s = await begin(db, f.bob, f.general, 'b.jpg');
  await db.member(f.org, f.bob, 'member', 'suspended');
  await expectError(db.call(f.bob, 'abort_upload', { p_attachment: s.attachment_id }), 'suspended');
}));

test('storage policy: only the reserver writes the reserved paths; nothing is readable before ready (DEKA05, DEKA11)', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await begin(db, f.alice, f.grants, 'grant.pdf', 'application/pdf', 1000);
  const t = await begin(db, f.alice, f.grants, 'pic.png', 'image/png', 1000, true);
  // A policy treats null as a deny, so "allowed" means exactly true.
  const w = async (u, p) => (await db.as(u, 'select dek.can_write_object($1) as ok', [p]))[0].ok === true;
  const rd = async (u, p) => (await db.as(u, 'select dek.can_read_object($1) as ok', [p]))[0].ok === true;
  assert.equal(await w(f.alice, r.path), true);
  assert.equal(await w(f.alice, t.thumb_path), true);
  assert.equal(await w(f.carol, r.path), false, 'a reader of the channel cannot write the reservation');
  assert.equal(await w(f.eve, r.path), false);
  assert.equal(await w(f.alice, r.path.replace('grant.pdf', 'other.pdf')), false, 'only the reserved name');
  assert.equal(await rd(f.alice, r.path), false, 'pending is never readable, not even by the uploader');
  assert.equal(await rd(f.carol, r.path), false);
  await fakeObject(db, r.path, 1000, 'application/pdf');
  await svc(db, 'svc_finalize_upload', { p_attachment: r.attachment_id, p_ok: true, p_mime: 'application/pdf',
    p_size: 1000, p_width: null, p_height: null, p_duration_ms: null, p_reason: null });
  assert.equal(await rd(f.carol, r.path), true, 'a channel member reads it once ready');
  assert.equal(await rd(f.guest, r.path), true);
  assert.equal(await rd(f.bob, r.path), false, 'a server member outside the private channel');
  assert.equal(await rd(f.eve, r.path), false, 'the other tenant guessing the path (DEKA05)');
  assert.equal(await rd(f.stranger, r.path), false);
  assert.equal(await w(f.alice, r.path), false, 'no overwrite once ready');
}));

test('svc functions are callable by service_role only', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await begin(db, f.alice, f.general);
  for (const [fn, args] of [
    ['svc_finalize_upload', { p_attachment: r.attachment_id, p_ok: false, p_mime: null, p_size: null,
      p_width: null, p_height: null, p_duration_ms: null, p_reason: 'x' }],
    ['svc_upload_info', { p_attachment: r.attachment_id, p_user: f.alice }],
    ['svc_media_purge', {}],
  ]) {
    const e = await expectError(db.call(f.alice, fn, args));
    assert.equal(e.sqlstate, '42501', `${fn} must not be executable by authenticated`);
  }
  const grants = await db.q(`
    select p.proname,
           has_function_privilege('authenticated', p.oid, 'execute') as authed,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and p.proname in ('begin_upload', 'abort_upload', 'svc_finalize_upload',
           'svc_upload_info', 'svc_media_purge')`);
  assert.equal(grants.length, 5);
  for (const g of grants) {
    if (g.proname.startsWith('svc_')) assert.deepEqual([g.authed, g.anon, g.svc], [false, false, true], g.proname);
    else assert.deepEqual([g.authed, g.anon], [true, false], g.proname);
  }
}));

test('svc_upload_info: the uploader only, with the Storage metadata', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await begin(db, f.alice, f.general, 'p.png', 'image/png', 4321, true);
  let info = await svc(db, 'svc_upload_info', { p_attachment: r.attachment_id, p_user: f.alice });
  assert.equal(info.status, 'pending');
  assert.equal(info.object_path, r.path);
  assert.equal(info.thumb_path, r.thumb_path);
  assert.equal(info.mime_type, 'image/png');
  assert.equal(info.object, null, 'not uploaded yet');
  assert.equal(info.max_bytes, 25 * MB);
  await fakeObject(db, r.path, 4321, 'image/png');
  info = await svc(db, 'svc_upload_info', { p_attachment: r.attachment_id, p_user: f.alice });
  assert.deepEqual(info.object, { size: 4321, mimetype: 'image/png' });
  assert.equal(info.thumb, null);
  await expectError(svc(db, 'svc_upload_info', { p_attachment: r.attachment_id, p_user: f.bob }), 'not_found');
  await expectError(svc(db, 'svc_upload_info', { p_attachment: r.attachment_id, p_user: null }), 'not_found');
}));

test('svc_finalize_upload: ready with real metadata; the thumbnail is kept only when it was uploaded', () => tx(async (db) => {
  const f = await db.fixture();
  const fin = (id, extra = {}) => svc(db, 'svc_finalize_upload', { p_attachment: id, p_ok: true, p_mime: 'image/png',
    p_size: 2048, p_width: 640, p_height: 480, p_duration_ms: null, p_reason: null, ...extra });
  // declared jpeg, really png (same family): the real type is recorded
  const a = await begin(db, f.alice, f.general, 'a.jpg', 'image/jpeg', 9999, true);
  await fakeObject(db, a.path, 2048, 'image/jpeg');
  await fakeObject(db, a.thumb_path, 300, 'image/webp');
  const ra = await fin(a.attachment_id);
  assert.equal(ra.status, 'ready');
  assert.equal(ra.mime_type, 'image/png');
  assert.equal(ra.size_bytes, 2048);
  assert.equal(ra.width, 640);
  assert.equal(ra.height, 480);
  assert.equal(ra.thumb_path, a.thumb_path);
  const rowA = await row(db, a.attachment_id);
  assert.ok(rowA.ready_at);
  // no thumbnail object: thumb_path goes so no client asks for a missing file
  const b = await begin(db, f.alice, f.general, 'b.png', 'image/png', 2048, true);
  await fakeObject(db, b.path, 2048, 'image/png');
  const rb = await fin(b.attachment_id, { p_width: 0, p_height: 999999 });
  assert.equal(rb.thumb_path, null);
  assert.equal(rb.width, null, 'nonsense dimensions are dropped');
  assert.equal(rb.height, null);
  // a thumbnail Storage would serve as a web page, or a big one, is dropped too
  for (const [type, size] of [['text/html', 300], ['image/svg+xml', 300], ['image/webp', 3 * MB]]) {
    const t = await begin(db, f.alice, f.general, 't.png', 'image/png', 2048, true);
    await fakeObject(db, t.path, 2048, 'image/png');
    await fakeObject(db, t.thumb_path, size, type);
    assert.equal((await fin(t.attachment_id)).thumb_path, null, `${type} ${size}`);
  }
  // a retry on a ready file reconciles a thumbnail media-finalize removed afterwards
  const c = await begin(db, f.alice, f.general, 'c.png', 'image/png', 2048, true);
  await fakeObject(db, c.path, 2048, 'image/png');
  await fin(c.attachment_id);
  await db.q('update dek.attachments set thumb_path = $2 where id = $1', [c.attachment_id, c.thumb_path]);
  assert.equal((await fin(c.attachment_id)).thumb_path, null, 'no object behind it any more');
  // a retry that reaches the same outcome is fine; the opposite outcome is a conflict
  assert.equal((await fin(b.attachment_id)).status, 'ready');
  await expectError(svc(db, 'svc_finalize_upload', { p_attachment: b.attachment_id, p_ok: false, p_mime: null,
    p_size: null, p_width: null, p_height: null, p_duration_ms: null, p_reason: 'late' }), 'conflict');
}));

test('svc_finalize_upload: refuses a missing object, a size mismatch, a type off the list, and oversize', () => tx(async (db) => {
  const f = await db.fixture();
  const a = await begin(db, f.alice, f.general, 'a.png', 'image/png', 2048);
  const fin = (extra = {}) => svc(db, 'svc_finalize_upload', { p_attachment: a.attachment_id, p_ok: true,
    p_mime: 'image/png', p_size: 2048, p_width: null, p_height: null, p_duration_ms: null, p_reason: null, ...extra });
  await expectError(fin(), 'conflict');
  // bytes Storage would serve as a web page are never made ready
  const html = await begin(db, f.alice, f.general, 'h.png', 'image/png', 2048);
  await fakeObject(db, html.path, 2048, 'text/html');
  await expectError(svc(db, 'svc_finalize_upload', { p_attachment: html.attachment_id, p_ok: true, p_mime: 'image/png',
    p_size: 2048, p_width: null, p_height: null, p_duration_ms: null, p_reason: null }), 'invalid_input');
  await fakeObject(db, a.path, 2048, 'image/png');
  await expectError(fin({ p_size: 2047 }), 'invalid_input');
  await expectError(fin({ p_mime: 'text/html' }), 'invalid_input');
  await expectError(fin({ p_mime: 'application/x-msdownload' }), 'invalid_input');
  await expectError(fin({ p_size: 26 * MB }), 'invalid_input');
  assert.equal((await row(db, a.attachment_id)).status, 'pending');
  assert.equal((await fin()).status, 'ready');
  await expectError(svc(db, 'svc_finalize_upload', { p_attachment: '00000000-0000-0000-0000-000000000000', p_ok: true,
    p_mime: 'image/png', p_size: 1, p_width: null, p_height: null, p_duration_ms: null, p_reason: null }), 'not_found');
}));

test('svc_finalize_upload: a rejection records the reason and is purged when the bytes are already gone', () => tx(async (db) => {
  const f = await db.fixture();
  const rej = (id, reason) => svc(db, 'svc_finalize_upload', { p_attachment: id, p_ok: false, p_mime: null,
    p_size: null, p_width: null, p_height: null, p_duration_ms: null, p_reason: reason });
  const gone = await begin(db, f.alice, f.general, 'evil.jpg', 'image/jpeg', 100);
  const r1 = await rej(gone.attachment_id, 'executable');
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reject_reason, 'executable');
  assert.ok((await row(db, gone.attachment_id)).purged_at, 'media-finalize removed the bytes: nothing left to purge');
  const kept = await begin(db, f.alice, f.general, 'evil2.jpg', 'image/jpeg', 100);
  await fakeObject(db, kept.path, 100, 'image/jpeg');
  await rej(kept.attachment_id, 'type_mismatch');
  const k = await row(db, kept.attachment_id);
  assert.equal(k.status, 'rejected');
  assert.equal(k.purged_at, null, 'the object is still there: the purge will remove it');
  assert.equal((await db.as(f.alice, 'select dek.can_read_object($1) as ok', [kept.path]))[0].ok, false,
    'a rejected object is never readable (DEKA11)');
}));

test('svc_media_purge: hands out deleted and rejected objects, stamps what was removed', () => tx(async (db) => {
  const f = await db.fixture();
  const ids = [];
  for (const [status, reason] of [['rejected', 'executable'], ['deleted', null], ['rejected', 'aborted']]) {
    const r = await begin(db, f.alice, f.general, 'x.png', 'image/png', 10, true);
    await db.q("update dek.attachments set status = $2, reject_reason = $3, created_at = now() - interval '1 hour' * $4 where id = $1",
      [r.attachment_id, status, reason, 3 - ids.length]);
    ids.push(r.attachment_id);
  }
  const ready = await begin(db, f.alice, f.general, 'ok.png', 'image/png', 10);
  await db.q("update dek.attachments set status = 'ready' where id = $1", [ready.attachment_id]);
  await db.q("update dek.attachments set purged_at = now() where status in ('deleted', 'rejected') and not (id = any($1))", [ids]);

  const first = await svc(db, 'svc_media_purge', { p_done: [], p_failed: [], p_limit: 100 });
  assert.equal(first.stamped, 0);
  assert.deepEqual(first.items.map((i) => i.id), ids, 'oldest first, ready files never');
  assert.equal(first.items[0].paths.length, 2, 'object and thumbnail');
  const second = await svc(db, 'svc_media_purge', { p_done: [ids[0], ids[1]], p_failed: [ids[2]], p_limit: 100 });
  assert.equal(second.stamped, 2);
  assert.deepEqual(second.items, [], 'a failed removal is not handed out again in the same run');
  const left = await db.q('select id from dek.attachments where id = any($1) and purged_at is null', [ids]);
  assert.deepEqual(left.map((x) => x.id), [ids[2]]);
  const capped = await svc(db, 'svc_media_purge', { p_done: [], p_failed: [], p_limit: 1000 });
  assert.ok(capped.items.length <= 100);
}));

test('media_purge_tick: abandoned and unsent uploads, one request to media-finalize, idle otherwise', () => tx(async (db) => {
  const f = await db.fixture();
  // isolate from whatever else is in the shared project: only this test's rows are due
  await db.q("update dek.attachments set purged_at = now() where status in ('deleted', 'rejected') and purged_at is null");
  await db.q("update dek.attachments set created_at = now() where status = 'pending' and created_at < now() - interval '1 day'");
  await db.q(`update dek.attachments set created_at = now()
               where status = 'ready' and message_id is null and legacy_id is null and created_at < now() - interval '14 days'`);
  const queued = async () => (await db.one(
    "select count(*)::int n from net.http_request_queue where url like '%/media-finalize'")).n;
  const before = await queued();
  await db.q('select dek.media_purge_tick()');
  assert.equal(await queued(), before, 'nothing due: no request');

  const old = await begin(db, f.alice, f.general, 'old.png', 'image/png', 10);
  const fresh = await begin(db, f.alice, f.general, 'fresh.png', 'image/png', 10);
  const unsent = await begin(db, f.alice, f.general, 'unsent.png', 'image/png', 10);
  const legacy = await begin(db, f.alice, f.general, 'legacy.png', 'image/png', 10);
  await db.q("update dek.attachments set created_at = now() - interval '25 hours' where id = $1", [old.attachment_id]);
  await db.q("update dek.attachments set status = 'ready', created_at = now() - interval '15 days' where id = any($1)",
    [[unsent.attachment_id, legacy.attachment_id]]);
  await db.q('update dek.attachments set legacy_id = gen_random_uuid() where id = $1', [legacy.attachment_id]);
  await db.q('select dek.media_purge_tick()');
  assert.deepEqual(
    [(await row(db, old.attachment_id)).status, (await row(db, old.attachment_id)).reject_reason],
    ['rejected', 'abandoned']);
  assert.equal((await row(db, fresh.attachment_id)).status, 'pending');
  assert.equal((await row(db, unsent.attachment_id)).status, 'deleted');
  assert.equal((await row(db, legacy.attachment_id)).status, 'ready', 'migrated files are never auto-deleted');
  assert.equal(await queued(), before + 1, 'one request to media-finalize');
  const req = await db.one(
    "select body, headers from net.http_request_queue where url like '%/media-finalize' order by id desc limit 1");
  assert.equal(Buffer.from(req.body).toString('utf8').includes('purge'), true);
  assert.ok(req.headers['x-dek-internal'], 'the internal secret rides along');
}));

test('cron: purge and reaper jobs exist; each job is bounded below its interval in its own command', () => tx(async (db) => {
  // A function-level SET statement_timeout does not bound the statement that calls the
  // function (a 1 s setting let a 3 s sleep finish); a SET in the command string does.
  const jobs = Object.fromEntries((await db.q(
    "select jobname, schedule, command from cron.job where jobname in ('dek-media-purge', 'dek-call-reaper')"))
    .map((j) => [j.jobname, j]));
  assert.deepEqual(Object.keys(jobs).sort(), ['dek-call-reaper', 'dek-media-purge']);
  assert.equal(jobs['dek-call-reaper'].schedule, '* * * * *');
  assert.equal(jobs['dek-call-reaper'].command, "set statement_timeout = '20s'; select dek.media_reap_calls()");
  assert.equal(jobs['dek-media-purge'].command, "set statement_timeout = '60s'; select dek.media_purge_tick()");
  const plan = await db.q("explain select 1 from dek.attachments a where a.status in ('deleted', 'rejected') and a.purged_at is null");
  assert.match(plan.map((p) => p['QUERY PLAN']).join('\n'), /Index/, 'the purge probe is an index lookup');
}));
