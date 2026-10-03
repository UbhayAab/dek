// Lead migrations 0902-0908: sign-in codes, account cleanup on a direct Auth delete,
// old message links, the admin channel list, saved ids, server invite lists.
// Owner: lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';

const hex = (s) => createHash('sha256').update(s).digest('hex');
const issue = (db, email, hash, invite = null, ip = null) =>
  db.one('select api.svc_auth_code_issue($1, $2, $3, $4) as r', [email, hash, invite, ip]).then((x) => x.r);
const verify = (db, email, hash) =>
  db.one('select api.svc_auth_code_verify($1, $2) as r', [email, hash]).then((x) => x.r);

test('auth codes: who may get one', () => tx(async (db) => {
  const uid = await db.user('Coder', 'coder.probe@jcf-lead-test.org');
  assert.ok(uid);
  assert.equal((await issue(db, 'qa-x@dek-test.invalid', hex('a'))).reason, 'invalid_email');
  assert.equal((await issue(db, 'someone@example.com', hex('a'))).reason, 'invalid_email');
  assert.equal((await issue(db, 'not-an-email', hex('a'))).reason, 'invalid_email');
  assert.equal((await issue(db, 'coder.probe@jcf-lead-test.org', 'nothex')).reason, 'invalid_request');
  assert.equal((await issue(db, 'stranger.probe@jcf-lead-test.org', hex('a'))).reason, 'no_account');
  const ok = await issue(db, '  Coder.Probe@JCF-Lead-Test.org ', hex('a'));
  assert.equal(ok.ok, true);
  assert.equal(ok.existing, true);
  const again = await issue(db, 'coder.probe@jcf-lead-test.org', hex('b'));
  assert.equal(again.reason, 'too_soon');
  assert.ok(again.retry_after > 0 && again.retry_after <= 60);
}));

test('auth codes: a newcomer needs a valid invite for their address', () => tx(async (db) => {
  const f = await db.fixture();
  const inv = await db.call(f.owner, 'create_invite', { p_org: f.org, p_email: 'newcomer.probe@jcf-lead-test.org' });
  const code = inv.code;
  assert.ok(code, 'create_invite returns the code once');
  assert.equal((await issue(db, 'other.probe@jcf-lead-test.org', hex('a'), code)).reason, 'no_account');
  const ok = await issue(db, 'newcomer.probe@jcf-lead-test.org', hex('a'), code);
  assert.equal(ok.ok, true);
  assert.equal(ok.existing, false);
  await db.q('update dek.invites set revoked_at = now() where code_sha256 = sha256(convert_to($1, \'UTF8\'))', [code]);
  await db.q("update dek.auth_codes set created_at = created_at - interval '2 minutes'");
  assert.equal((await issue(db, 'newcomer.probe@jcf-lead-test.org', hex('b'), code)).reason, 'no_account');
}));

test('auth codes: verify, attempts, single use', () => tx(async (db) => {
  await db.user('Coder', 'coder.probe@jcf-lead-test.org');
  await issue(db, 'coder.probe@jcf-lead-test.org', hex('right'));
  const w1 = await verify(db, 'coder.probe@jcf-lead-test.org', hex('wrong'));
  assert.deepEqual([w1.reason, w1.attempts_left], ['wrong_code', 4]);
  const good = await verify(db, 'CODER.probe@jcf-lead-test.org', hex('right'));
  assert.deepEqual([good.ok, good.existing], [true, true]);
  assert.equal((await verify(db, 'coder.probe@jcf-lead-test.org', hex('right'))).reason, 'expired');
  // five wrong tries burn a fresh code
  await db.q("update dek.auth_codes set created_at = created_at - interval '2 minutes'");
  await issue(db, 'coder.probe@jcf-lead-test.org', hex('second'));
  for (let i = 0; i < 5; i += 1) await verify(db, 'coder.probe@jcf-lead-test.org', hex(`bad${i}`));
  assert.equal((await verify(db, 'coder.probe@jcf-lead-test.org', hex('second'))).reason, 'too_many_attempts');
  // expiry
  await db.q("update dek.auth_codes set created_at = created_at - interval '2 minutes'");
  await issue(db, 'coder.probe@jcf-lead-test.org', hex('third'));
  await db.q("update dek.auth_codes set expires_at = now() - interval '1 second' where consumed_at is null and attempts = 0");
  assert.equal((await verify(db, 'coder.probe@jcf-lead-test.org', hex('third'))).reason, 'expired');
}));

test('auth codes: only the service role can call the svc functions', () => tx(async (db) => {
  for (const role of ['anon', 'authenticated']) {
    const r = await db.one(`select has_function_privilege('${role}', 'api.svc_auth_code_issue(text, text, text, text)', 'execute') a,
                                   has_function_privilege('${role}', 'api.svc_auth_code_verify(text, text)', 'execute') b`);
    assert.deepEqual([r.a, r.b], [false, false], role);
  }
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
