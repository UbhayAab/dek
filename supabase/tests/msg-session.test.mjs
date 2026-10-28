// Session and bootstrap: api.me, api.bootstrap, api.get_profiles. Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, expectAnonDenied } from './msg-lib.mjs';

test('me: identity, email, profile, active organizations, prefs (created when missing), platform admin flag', () => tx(async (db) => {
  const f = await db.fixture();
  const me = await db.call(f.alice, 'me');
  assert.equal(me.user_id, f.alice);
  assert.match(me.email, /@dek-test\.invalid$/);
  assert.equal(me.profile.id, f.alice);
  assert.equal(me.profile.display_name, 'Alice');
  assert.equal(me.profile.deleted, false);
  assert.deepEqual(me.orgs.map((o) => [o.id, o.my_role]), [[f.org, 'member']]);
  assert.equal(typeof me.orgs[0].unread_channels, 'number');
  assert.deepEqual(me.prefs, {
    default_level: 'mentions', dm_level: 'all', thread_replies: true,
    quiet_start: null, quiet_end: null, quiet_tz: 'Asia/Kolkata', preview: 'full' });
  assert.equal(me.is_platform_admin, false);

  await db.q('delete from dek.notification_prefs where user_id = $1', [f.alice]);
  await db.q("update dek.orgs set archived_at = null where id = $1", [f.otherOrg]);
  await db.member(f.otherOrg, f.alice);
  await db.q('insert into dek.platform_admins (user_id) values ($1)', [f.alice]);
  const again = await db.call(f.alice, 'me');
  assert.equal(again.orgs.length, 2);
  assert.equal(again.is_platform_admin, true);
  assert.equal((await db.q('select 1 from dek.notification_prefs where user_id = $1', [f.alice])).length, 1,
    'missing prefs are created with defaults');
  await db.q("update dek.notification_prefs set quiet_start = '22:30', quiet_end = '07:00' where user_id = $1", [f.alice]);
  const quiet = await db.call(f.alice, 'me');
  assert.equal(quiet.prefs.quiet_start, '22:30');
  assert.equal(quiet.prefs.quiet_end, '07:00');

  const sus = await db.call(f.suspended, 'me');
  assert.deepEqual(sus.orgs, [], 'a suspended membership is not listed');
  const stranger = await db.call(f.stranger, 'me');
  assert.deepEqual(stranger.orgs, []);
  await expectAnonDenied(db.call(null, 'me'));
}));

test('bootstrap: org and settings, servers, joined channels and unhidden DMs, profiles, topics (DEK07)', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.bob, f.general, 'one');
  await send(db, f.bob, f.dmAliceBob, 'dm');
  const groupDm = await db.one(
    "insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'group_dm', 'private', $2) returning id",
    [f.org, `g:${f.alice}:${f.bob}:${f.carol}`]);
  for (const u of [f.alice, f.bob, f.carol]) await db.channelMember(groupDm.id, u);
  await db.q("update dek.channel_members set hidden = true where channel_id = $1 and user_id = $2", [groupDm.id, f.alice]);

  const b = await db.call(f.alice, 'bootstrap', { p_org: f.org });
  assert.equal(b.org.id, f.org);
  assert.equal(b.org.my_role, 'member');
  assert.equal(b.org.settings.edit_window_minutes, null);
  assert.equal(b.org.settings.default_invite_hours, 168);
  assert.deepEqual(b.servers.map((s) => [s.id, s.my_role]), [[f.medical, 'member']]);
  const chans = Object.fromEntries(b.channels.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(chans).sort(), [f.general, f.grants, f.dmAliceBob].sort(),
    'joined channels and the visible DM; not leadership, not the hidden group DM');
  assert.equal(b.channels.at(-1).id, f.dmAliceBob, 'DMs after server channels');
  assert.equal(chans[f.general].unread, 1);
  assert.equal(chans[f.general].last_seq, 1);
  assert.equal(chans[f.grants].my_role, 'owner');
  assert.deepEqual(chans[f.dmAliceBob].dm_user_ids, [f.bob]);
  assert.deepEqual(b.profiles.map((p) => p.id).sort(), [f.bob, f.owner].sort(), 'the DM partner and the server admin');
  assert.deepEqual(b.topics, [`u:${f.alice}`, `s:${f.medical}`]);
  assert.ok(Math.abs(new Date(b.server_time) - Date.now()) < 120e3);
  const prof = await db.one('select last_active_at from dek.profiles where id = $1', [f.alice]);
  assert.ok(prof.last_active_at, 'bootstrap marks the person active');

  await send(db, f.carol, groupDm.id, 'group hello');   // unhides it
  const b2 = await db.call(f.alice, 'bootstrap', { p_org: f.org });
  assert.ok(b2.channels.some((c) => c.id === groupDm.id));
  assert.ok(b2.profiles.some((p) => p.id === f.carol), 'group DM partners are included');
}));

test('bootstrap: a cross-team contributor sees Grants and nothing else of the host server (DEKA04)', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.alice, f.general, 'medical only');
  const c = await db.call(f.carol, 'bootstrap', { p_org: f.org });
  const servers = Object.fromEntries(c.servers.map((s) => [s.id, s.my_role]));
  assert.deepEqual(servers, { [f.medical]: null, [f.tech]: 'member' }, 'Medical is a partial view');
  assert.deepEqual(c.channels.map((ch) => ch.id).sort(), [f.grants, f.techGeneral].sort());
  assert.deepEqual(c.topics, [`u:${f.carol}`, `s:${f.tech}`], 'no Medical server topic');

  const g = await db.call(f.guest, 'bootstrap', { p_org: f.org });
  assert.equal(g.org.my_role, 'guest');
  assert.deepEqual(g.channels.map((ch) => ch.id), [f.grants]);
  assert.deepEqual(g.topics, [`u:${f.guest}`], 'guests never get server topics');
  // even a guest who is a server member
  await db.serverMember(f.medical, f.guest);
  const g2 = await db.call(f.guest, 'bootstrap', { p_org: f.org });
  assert.deepEqual(g2.topics, [`u:${f.guest}`]);
}));

test('bootstrap: strangers and the other tenant get not_found, suspended members get suspended (DEKA05)', () => tx(async (db) => {
  const f = await db.fixture();
  await expectError(db.call(f.stranger, 'bootstrap', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.eve, 'bootstrap', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.alice, 'bootstrap', { p_org: f.otherOrg }), 'not_found');
  await expectError(db.call(f.suspended, 'bootstrap', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.alice, 'bootstrap', { p_org: null }), 'not_found');
  await expectAnonDenied(db.call(null, 'bootstrap', { p_org: f.org }));
  const e = await db.call(f.eve, 'bootstrap', { p_org: f.otherOrg });
  assert.deepEqual(e.channels.map((c) => c.id), [f.otherChannel]);
}));

test('get_profiles: only people who share an organization with the caller; at most 200 ids', () => tx(async (db) => {
  const f = await db.fixture();
  const p = await db.call(f.alice, 'get_profiles', { p_ids: [f.bob, f.eve, f.stranger, f.carol, f.bob, f.alice] });
  assert.deepEqual(p.map((x) => x.id), [f.bob, f.carol, f.alice], 'input order, deduped, same-org only');
  assert.equal(p[0].display_name, 'Bob');
  assert.deepEqual(await db.call(f.eve, 'get_profiles', { p_ids: [f.alice, f.bob] }), []);
  assert.deepEqual(await db.call(f.stranger, 'get_profiles', { p_ids: [f.alice] }), []);
  assert.deepEqual(await db.call(f.alice, 'get_profiles', { p_ids: [] }), []);
  assert.deepEqual(await db.call(f.suspended, 'get_profiles', { p_ids: [f.alice] }), [],
    'a suspended membership shares nothing');
  const many = Array.from({ length: 201 }, () => f.bob);
  await expectError(db.call(f.alice, 'get_profiles', { p_ids: many }), 'invalid_input');
  await expectAnonDenied(db.call(null, 'get_profiles', { p_ids: [f.alice] }));
}));
