// Lead migrations 0902-0910: sign-in codes, account cleanup on a direct Auth delete,
// old message links, the admin channel list, saved ids, server invite lists.
// Owner: lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';

const hex = (s) => createHash('sha256').update(s).digest('hex');
const issue = (db, email, hash, request = hex(`req-${email}-${hash}`), invite = null, ip = null) =>
  db.one('select api.svc_auth_code_issue($1, $2, $3, $4, $5) as r', [email, hash, request, invite, ip]).then((x) => x.r);
const verify = (db, email, hash, request) =>
  db.one('select api.svc_auth_code_verify($1, $2, $3) as r', [email, hash, request]).then((x) => x.r);
const ago = (db) => db.q("update dek.auth_codes set created_at = created_at - interval '2 minutes'");

test('auth codes: addresses, decoys for unknown people, the one-a-minute brake', () => tx(async (db) => {
  await db.user('Coder', 'coder.probe@jcf-lead-test.org');
  for (const bad of ['qa-x@dek-test.invalid', 'someone@example.com', 'not-an-email', 'a@x.com,b.org',
    'Boss<b@v.org>', '"><svg/onload=1>@d.org', 'a..b@x.org', 'dot.@x.org', 'x@-bad.org']) {
    assert.equal((await issue(db, bad, hex('a'))).reason, 'invalid_email', bad);
  }
  assert.equal((await issue(db, 'coder.probe@jcf-lead-test.org', 'nothex')).reason, 'invalid_request');
  assert.equal((await issue(db, 'coder.probe@jcf-lead-test.org', hex('a'), 'short')).reason, 'invalid_request');
  // an unknown address gets the same answer, but nothing is mailed and nothing can be verified
  const decoy = await issue(db, 'stranger.probe@jcf-lead-test.org', hex('a'), hex('r1'));
  assert.deepEqual([decoy.ok, decoy.mail], [true, false]);
  assert.equal((await verify(db, 'stranger.probe@jcf-lead-test.org', hex('a'), hex('r1'))).reason, 'expired');
  assert.equal((await issue(db, 'stranger.probe@jcf-lead-test.org', hex('b'))).reason, 'too_soon', 'decoys use the same brakes');
  const ok = await issue(db, '  Coder.Probe@JCF-Lead-Test.org ', hex('a'));
  assert.deepEqual([ok.ok, ok.mail], [true, true]);
  const again = await issue(db, 'coder.probe@jcf-lead-test.org', hex('b'));
  assert.equal(again.reason, 'too_soon');
  assert.ok(again.retry_after > 0 && again.retry_after <= 60);
  for (let i = 0; i < 4; i += 1) { await ago(db); await issue(db, 'coder.probe@jcf-lead-test.org', hex(`n${i}`)); }
  await ago(db);
  assert.equal((await issue(db, 'coder.probe@jcf-lead-test.org', hex('six'))).reason, 'too_many', 'five codes an hour');
}));

test('auth codes: a newcomer needs an invite that accept_invite would honor', () => tx(async (db) => {
  const f = await db.fixture();
  const inv = await db.call(f.owner, 'create_invite', { p_org: f.org, p_email: 'newcomer.probe@jcf-lead-test.org' });
  const code = inv.code;
  assert.ok(code, 'create_invite returns the code once');
  assert.equal((await issue(db, 'other.probe@jcf-lead-test.org', hex('a'), hex('r0'), code)).mail, false, 'targeted to someone else');
  const ok = await issue(db, 'newcomer.probe@jcf-lead-test.org', hex('a'), hex('r1'), code);
  assert.deepEqual([ok.ok, ok.mail], [true, true]);
  await db.q("update dek.invites set revoked_at = now() where code_sha256 = sha256(convert_to($1, 'UTF8'))", [code]);
  await ago(db);
  assert.equal((await issue(db, 'newcomer.probe@jcf-lead-test.org', hex('b'), hex('r2'), code)).mail, false, 'revoked: no mail');
}));

test('auth codes: only the requester can try a code; 3 tries; single use; release', () => tx(async (db) => {
  const me = 'coder.probe@jcf-lead-test.org';
  await db.user('Coder', me);
  await issue(db, me, hex('right'), hex('mine'));
  assert.equal((await verify(db, me, hex('right'), hex('someone-else'))).reason, 'expired', 'without the token nothing happens');
  assert.equal((await verify(db, me, hex('wrong'), hex('someone-else'))).reason, 'expired');
  const w1 = await verify(db, me, hex('wrong'), hex('mine'));
  assert.deepEqual([w1.reason, w1.attempts_left], ['wrong_code', 2], 'the stranger burned no tries');
  const good = await verify(db, 'CODER.probe@jcf-lead-test.org', hex('right'), hex('mine'));
  assert.deepEqual([good.ok, good.existing], [true, true]);
  assert.equal((await verify(db, me, hex('right'), hex('mine'))).reason, 'expired', 'single use');
  // a failure after verify puts the code back
  const rel = await db.one('select api.svc_auth_code_release($1, $2) as r', [me, hex('mine')]);
  assert.equal(rel.r.released, true);
  assert.equal((await verify(db, me, hex('right'), hex('mine'))).ok, true, 'usable again after release');
  // three wrong tries burn a code
  await ago(db);
  await issue(db, me, hex('second'), hex('mine2'));
  for (let i = 0; i < 3; i += 1) await verify(db, me, hex(`bad${i}`), hex('mine2'));
  assert.equal((await verify(db, me, hex('second'), hex('mine2'))).reason, 'too_many_attempts');
  // expiry
  await ago(db);
  await issue(db, me, hex('third'), hex('mine3'));
  await db.q("update dek.auth_codes set expires_at = now() - interval '1 second' where request_hash = $1", [hex('mine3')]);
  assert.equal((await verify(db, me, hex('third'), hex('mine3'))).reason, 'expired');
}));

test('auth codes: 30 wrong tries a day lock code sign-in for that address', () => tx(async (db) => {
  const me = 'coder.probe@jcf-lead-test.org';
  await db.user('Coder', me);
  await db.q(`insert into dek.auth_codes (email, code_hash, request_hash, expires_at, attempts, created_at)
              select $1, $2, md5(g::text) || md5(g::text), now() + interval '10 minutes', 3, now() - interval '3 hours'
                from generate_series(1, 10) g`, [me, hex('old')]);
  await issue(db, me, hex('fresh'), hex('fresh-req'));
  assert.equal((await verify(db, me, hex('fresh'), hex('fresh-req'))).reason, 'too_many_attempts');
}));

test('auth codes: only the service role can call the svc functions', () => tx(async (db) => {
  for (const role of ['anon', 'authenticated']) {
    const r = await db.one(`select has_function_privilege('${role}', 'api.svc_auth_code_issue(text, text, text, text, text)', 'execute') a,
                                   has_function_privilege('${role}', 'api.svc_auth_code_verify(text, text, text)', 'execute') b,
                                   has_function_privilege('${role}', 'api.svc_auth_code_release(text, text)', 'execute') c`);
    assert.deepEqual([r.a, r.b, r.c], [false, false, false], role);
  }
}));

test('uploads: at most 20 unfinished reservations per person', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 0; i < 20; i += 1) {
    await db.call(f.alice, 'begin_upload', { p_channel: f.general, p_file_name: `f${i}.png`, p_mime: 'image/png', p_size: 1000 });
  }
  await expectError(db.call(f.alice, 'begin_upload', { p_channel: f.general, p_file_name: 'f20.png', p_mime: 'image/png', p_size: 1000 }), 'rate_limited');
  // someone else is not affected
  await db.call(f.bob, 'begin_upload', { p_channel: f.general, p_file_name: 'b.png', p_mime: 'image/png', p_size: 1000 });
}));

test('realtime: one event id per emitted event, shared by every topic', () => tx(async (db) => {
  await db.q("select dek.emit_many(array['u:lead-test-a', 'u:lead-test-b'], 'lead.test', '{}'::jsonb)");
  const rows = await db.q("select id, payload->>'eid' eid from realtime.messages where event = 'lead.test'");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].eid, rows[1].eid);
  assert.notEqual(rows[0].id, rows[1].id);
}));

test('a direct Auth delete anonymizes the profile and revokes access', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q('delete from auth.users where id = $1', [f.bob]);
  const p = await db.one('select display_name, deleted_at is not null as gone from dek.profiles where id = $1', [f.bob]);
  assert.deepEqual([p.display_name, p.gone], ['Deleted user', true]);
  const left = await db.one(`select (select count(*)::int from dek.org_members where user_id = $1) orgs,
                                    (select count(*)::int from dek.channel_members cm join dek.channels c on c.id = cm.channel_id
                                      where cm.user_id = $1 and c.kind not in ('dm', 'group_dm')) chans`, [f.bob]);
  assert.deepEqual([left.orgs, left.chans], [0, 0]);
  assert.equal(await db.one('select dek.can_read_channel($1, $2) as ok', [f.bob, f.general]).then((x) => x.ok), false);
}));

test('old message links resolve for readers only, thread replies included', () => tx(async (db) => {
  const f = await db.fixture();
  const root = (await db.message(f.general, f.alice, 'root')).id;
  const reply = (await db.message(f.general, f.bob, 'reply', { root })).id;
  await db.q("update dek.messages set meta = jsonb_build_object('legacy', jsonb_build_object('seq', 41)) where id = $1", [root]);
  await db.q("update dek.messages set meta = jsonb_build_object('legacy', jsonb_build_object('seq', 42)) where id = $1", [reply]);
  const r1 = await db.call(f.alice, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: 41 });
  assert.deepEqual([r1.message_id, r1.thread_root_id, r1.org_id], [root, null, f.org]);
  const r2 = await db.call(f.alice, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: 42 });
  assert.deepEqual([r2.message_id, r2.thread_root_id], [reply, root]);
  await expectError(db.call(f.carol, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: 41 }), 'not_found');
  await expectError(db.call(f.eve, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: 41 }), 'not_found');
  await expectError(db.call(f.alice, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: 999 }), 'not_found');
  await expectError(db.call(f.alice, 'resolve_legacy_message', { p_channel: f.general, p_legacy_seq: -1 }), 'invalid_input');
}));

test('list_channels manage mode: server admins see private channels, others are refused', () => tx(async (db) => {
  const f = await db.fixture();
  const names = (rows) => rows.map((c) => c.name).sort();
  // the owner is a server admin of Medical Partnerships but not in #grants
  const plain = await db.call(f.owner, 'list_channels', { p_server: f.medical });
  assert.ok(!names(plain).includes('grants'), 'normal mode hides private channels the caller is not in');
  const managed = await db.call(f.owner, 'list_channels', { p_server: f.medical, p_manage: true });
  assert.ok(names(managed).includes('grants') && names(managed).includes('leadership'));
  await expectError(db.call(f.alice, 'list_channels', { p_server: f.medical, p_manage: true }), 'forbidden');
  await expectError(db.call(f.eve, 'list_channels', { p_server: f.medical, p_manage: true }), 'not_found');
}));

test('saved ids: own org only, and every change reaches the person\'s devices', () => tx(async (db) => {
  const f = await db.fixture();
  const m = (await db.message(f.general, f.bob, 'keep this')).id;
  await db.call(f.alice, 'save_message', { p_message: m, p_saved: true });
  assert.deepEqual(await db.call(f.alice, 'list_saved_ids', { p_org: f.org }), [m]);
  assert.deepEqual(await db.call(f.bob, 'list_saved_ids', { p_org: f.org }), []);
  await expectError(db.call(f.eve, 'list_saved_ids', { p_org: f.org }), 'not_found');
  await db.call(f.alice, 'save_message', { p_message: m, p_saved: false });
  const ev = await db.q(`select payload->>'saved' saved from realtime.messages
                          where topic = $1 and event = 'saved.upd' order by inserted_at`, [`u:${f.alice}`]);
  assert.deepEqual(ev.map((e) => e.saved), ['true', 'false']);
}));

test('server invite list: server admins see every invite of their server', () => tx(async (db) => {
  const f = await db.fixture();
  // admin of the org creates a server invite; the owner (server admin) and alice (member) look
  await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical });
  const own = await db.call(f.owner, 'list_invites', { p_org: f.org, p_server: f.medical });
  assert.equal(own.items.length, 1);
  await expectError(db.call(f.alice, 'list_invites', { p_org: f.org, p_server: f.medical }), 'forbidden');
  await expectError(db.call(f.owner, 'list_invites', { p_org: f.org, p_server: f.otherServer }), 'not_found');
}));

test('calls: a ninth joined person is refused, rejoining does not count twice (0911)', () => tx(async (db) => {
  const f = await db.fixture();
  const call = await db.call(f.alice, 'start_call', { p_channel: f.dmAliceBob, p_media: 'audio' });
  for (let i = 0; i < 7; i += 1) {
    const u = await db.user(`Caller ${i}`);
    await db.q("insert into dek.call_participants (call_id, user_id, state, session_id) values ($1, $2, 'joined', gen_random_uuid())", [call.id, u]);
  }
  // alice plus 7 joined: the call is full, so bob (ringing) cannot join
  await expectError(db.safe("update dek.call_participants set state = 'joined' where call_id = $1 and user_id = $2", [call.id, f.bob]), 'conflict');
  // an already joined person moving to a new session is not a new seat
  await db.q('update dek.call_participants set session_id = gen_random_uuid() where call_id = $1 and user_id = $2', [call.id, f.alice]);
}));

test('crash reports: redacted again on the server, one row per kind and day, counted (0912)', () => tx(async (db) => {
  const f = await db.fixture();
  const fp = 'a1b2c3d4e5f60718293a4b5c';
  const first = await db.call(f.alice, 'report_client_error', { p_report: {
    fingerprint: fp, name: 'TypeError', message: 'boom for asha@jcf.org at https://x.example/a 12345678',
    stack: 'at x (app.js:1:2)', route: 'channel', build: 'b1', agent: 'Chrome Android' } });
  assert.equal(first.stored, true);
  await db.call(f.alice, 'report_client_error', { p_report: { fingerprint: fp, name: 'TypeError', message: 'again' } });
  const row = await db.one('select count, message, user_id, route from dek.client_errors where fingerprint = $1', [fp]);
  assert.equal(row.count, 2);
  assert.doesNotMatch(row.message, /asha@|https:|12345678/);
  assert.deepEqual([row.user_id, row.route], [f.alice, 'channel']);
  await expectError(db.call(f.alice, 'report_client_error', { p_report: { fingerprint: 'nothex' } }), 'invalid_input');
  const anon = await db.call(null, 'report_client_error', { p_report: { fingerprint: 'ffffffffffffffffffffffff', name: 'Error', message: 'on the sign-in screen' } });
  assert.equal(anon.stored, true);
}));
