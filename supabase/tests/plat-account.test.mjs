// Account deletion (PRD APP08): request_account_deletion and
// svc_complete_account_deletion. Owner: plat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import { svc, device, message, msgIntent, claim, users } from './plat-lib.mjs';

const count = async (db, sql, args) => (await db.one(sql, args)).n;

test('request_account_deletion: leaves every org, removes personal data, anonymises, keeps the record', () => tx(async (db) => {
  const f = await db.fixture();
  await db.member(f.otherOrg, f.alice);
  await device(db, f.alice);
  const m = await message(db, f.general, f.alice, 'my last words');
  await db.q('insert into dek.saved_messages (user_id, message_id, org_id) values ($1, $2, $3)', [f.alice, m.id, f.org]);
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2), ($3, $1)', [f.alice, f.carol, f.bob]);
  await db.q('insert into dek.thread_follows (root_id, user_id, channel_id, org_id) values ($1, $2, $3, $4)',
    [m.id, f.alice, f.general, f.org]);
  await db.q("insert into dek.join_requests (org_id, server_id, user_id) values ($1, $2, $3)", [f.org, f.tech, f.alice]);
  await db.q("insert into dek.platform_admins (user_id) values ($1)", [f.alice]);
  await db.q(`update dek.profiles set handle = 'alice', title = 'Lead', avatar_path = $2, status_text = 'busy'
               where id = $1`, [f.alice, `${f.alice}/a.webp`]);

  assert.deepEqual(await db.call(f.alice, 'request_account_deletion'), { status: 'scheduled' });

  const n = (sql) => count(db, sql, [f.alice]);
  assert.equal(await n('select count(*)::int n from dek.org_members where user_id = $1'), 0, 'both organizations');
  assert.equal(await n('select count(*)::int n from dek.server_members where user_id = $1'), 0);
  assert.equal(await n(`select count(*)::int n from dek.channel_members cm join dek.channels c on c.id = cm.channel_id
                         where cm.user_id = $1 and c.kind in ('text', 'audio')`), 0, 'channels, the private one she owned too');
  assert.equal(await n(`select count(*)::int n from dek.channel_members cm join dek.channels c on c.id = cm.channel_id
                         where cm.user_id = $1 and c.kind = 'dm'`), 1, 'the DM row stays: bob\'s history shows who he talked to');
  for (const t of ['push_devices', 'notification_prefs', 'saved_messages', 'thread_follows', 'platform_admins']) {
    assert.equal(await n(`select count(*)::int n from dek.${t} where user_id = $1`), 0, t);
  }
  assert.equal(await n('select count(*)::int n from dek.user_blocks where blocker_id = $1'), 0, 'her blocks');
  assert.equal(await n("select count(*)::int n from dek.join_requests where user_id = $1 and status = 'pending'"), 0);
  const p = await db.one(`select display_name, handle, title, avatar_path, status_text, last_active_at, deleted_at
                            from dek.profiles where id = $1`, [f.alice]);
  assert.deepEqual([p.display_name, p.handle, p.title, p.avatar_path, p.status_text, p.last_active_at],
    ['Deleted user', null, null, null, null, null]);
  assert.ok(p.deleted_at);
  assert.deepEqual(await db.one('select author_id, body from dek.messages where id = $1', [m.id]),
    { author_id: f.alice, body: 'my last words' }, 'what she wrote stays as the organization\'s record');
  const ev = await db.q("select payload from realtime.messages where topic = $1 and event = 'access.revoked'", [`u:${f.alice}`]);
  assert.equal(ev.filter((e) => e.payload.scope === 'org').length, 2, 'access.revoked for each organization');
  assert.equal(await count(db, `select count(*)::int n from dek.audit_log
                                 where action = 'member.account_deleted' and target_id = $1`, [f.alice]), 2);

  await expectError(db.call(f.alice, 'get_notification_prefs'), 'auth_required');
  await expectError(db.call(f.alice, 'request_account_deletion'), 'auth_required');
  await db.q("update dek.notification_prefs set default_level = 'all' where user_id = $1", [f.bob]);
  const later = await message(db, f.dmAliceBob, f.bob, 'are you still there?');
  assert.deepEqual(users(await claim(db, await msgIntent(db, later, f.bob))), [], 'nothing routes to a deleted account');
}));

test('request_account_deletion: refused for the last owner of an organization, allowed with a second owner', () => tx(async (db) => {
  const f = await db.fixture();
  await expectError(db.call(f.owner, 'request_account_deletion'), 'conflict');
  await expectError(db.call(f.eve, 'request_account_deletion'), 'conflict');
  assert.equal(await count(db, 'select count(*)::int n from dek.org_members where user_id = $1', [f.owner]), 1,
    'a refusal changes nothing');
  await db.member(f.org, f.admin, 'owner');
  assert.deepEqual(await db.call(f.owner, 'request_account_deletion'), { status: 'scheduled' });
  for (const u of [f.stranger, f.guest, f.suspended]) {
    assert.deepEqual(await db.call(u, 'request_account_deletion'), { status: 'scheduled' },
      'no org, a guest, a suspended member: anyone can delete their own account');
  }
  assert.equal(await count(db, 'select count(*)::int n from dek.org_members where user_id = $1', [f.suspended]), 0);
}));

test('svc_complete_account_deletion: only after the request and after the auth user is gone; idempotent', () => tx(async (db) => {
  const f = await db.fixture();
  await expectError(svc(db, 'svc_complete_account_deletion', { p_user: f.bob }), 'conflict');
  await db.call(f.bob, 'request_account_deletion');
  await expectError(svc(db, 'svc_complete_account_deletion', { p_user: f.bob }), 'conflict');
  const id = (await db.one("select dek.enqueue_intent('test', null, p_target_user => $1) as id", [f.bob])).id;
  await db.q(`insert into dek.notification_deliveries (intent_id, user_id, kind, status) values ($1, $2, 'webpush', 'sent')`,
    [id, f.bob]);
  await db.q('delete from auth.users where id = $1', [f.bob]);
  assert.deepEqual(await svc(db, 'svc_complete_account_deletion', { p_user: f.bob }), { status: 'deleted' });
  assert.deepEqual(await svc(db, 'svc_complete_account_deletion', { p_user: f.bob }), { status: 'deleted' }, 'idempotent');
  assert.equal(await count(db, 'select count(*)::int n from dek.notification_deliveries where user_id = $1', [f.bob]), 0);
  assert.equal(await count(db, 'select count(*)::int n from dek.profiles where id = $1 and deleted_at is not null', [f.bob]), 1,
    'the anonymised profile stays so authorship still resolves');
  await expectError(svc(db, 'svc_complete_account_deletion', { p_user: randomUUID() }), 'not_found');
  await expectError(svc(db, 'svc_complete_account_deletion', { p_user: null }), 'invalid_input');
}));
