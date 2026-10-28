// Profile, status and notification preferences (CONTRACT 2.6). Owner: plat.
// These act on the caller's own rows, so the denials that matter are: no session
// (no grant), a deleted account (auth_required), and somebody else's handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';

const PROFILE_KEYS = ['avatar_path', 'deleted', 'display_name', 'handle', 'id', 'last_active_at',
  'status_emoji', 'status_text', 'status_until', 'timezone', 'title'];
const DEFAULT_PREFS = {
  default_level: 'mentions', dm_level: 'all', thread_replies: true,
  quiet_start: null, quiet_end: null, quiet_tz: 'Asia/Kolkata', preview: 'full',
};

test('update_profile: every field, the Profile shape, a normalised handle, partial patches', () => tx(async (db) => {
  const f = await db.fixture();
  const avatar = `${f.alice}/a1.webp`;
  await db.q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [avatar]);
  const p = await db.call(f.alice, 'update_profile', { p_patch: {
    display_name: '  Alice Rao ', handle: '@Alice.R', title: 'Grants lead', timezone: 'America/New_York',
    avatar_path: avatar } });
  assert.deepEqual(Object.keys(p).sort(), PROFILE_KEYS);
  assert.deepEqual([p.id, p.display_name, p.handle, p.title, p.timezone, p.avatar_path, p.deleted],
    [f.alice, 'Alice Rao', 'alice.r', 'Grants lead', 'America/New_York', avatar, false]);
  const q = await db.call(f.alice, 'update_profile', { p_patch: { title: null, handle: null, avatar_path: null } });
  assert.deepEqual([q.display_name, q.title, q.handle, q.avatar_path, q.timezone],
    ['Alice Rao', null, null, null, 'America/New_York'], 'null clears optional fields, the rest stay');
  const stored = await db.one('select display_name, updated_at > created_at as touched from dek.profiles where id = $1', [f.alice]);
  assert.equal(stored.display_name, 'Alice Rao');
}));

test('update_profile: validation, unknown fields, taken handles, other people\'s avatar folders', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${f.bob}/b.webp`]);
  const bad = (patch) => expectError(db.call(f.alice, 'update_profile', { p_patch: patch }), 'invalid_input');
  await bad({ display_name: '' });
  await bad({ display_name: '   ' });
  await bad({ display_name: 'x'.repeat(81) });
  await bad({ display_name: 'two\nlines' });
  await bad({ display_name: null });
  await bad({ display_name: 42 });
  await bad({ handle: 'a' });
  await bad({ handle: 'has space' });
  await bad({ handle: '-dash-first' });
  await bad({ title: 'x'.repeat(81) });
  await bad({ timezone: 'Mars/Olympus_Mons' });
  await bad({ timezone: "Asia/Kolkata'; drop table x;--" });
  await bad({ timezone: null });
  await bad({ avatar_path: `${f.bob}/b.webp` });
  await bad({ avatar_path: `${f.alice}/missing.webp` });
  await bad({ avatar_path: `${f.alice}/../${f.bob}/b.webp` });
  await bad({ email: 'someone@example.com' });
  await bad({ status_text: 'set_status does this' });
  await expectError(db.call(f.alice, 'update_profile', { p_patch: '[1]' }), 'invalid_input');
  await db.call(f.bob, 'update_profile', { p_patch: { handle: 'taken' } });
  await expectError(db.call(f.alice, 'update_profile', { p_patch: { handle: 'Taken' } }), 'conflict');
  assert.equal((await db.call(f.bob, 'update_profile', { p_patch: { handle: 'taken' } })).handle, 'taken',
    'keeping your own handle is not a conflict');
  assert.equal((await db.call(f.eve, 'update_profile', { p_patch: { title: 'Ops' } })).title, 'Ops',
    'any signed-in person, in any tenant, edits their own profile');
}));

test('set_status: set, clear, validation', () => tx(async (db) => {
  const f = await db.fixture();
  const until = new Date(Date.now() + 3600e3).toISOString();
  let p = await db.call(f.alice, 'set_status', { p_text: '  In a   meeting ', p_emoji: ':calendar:', p_until: until });
  assert.deepEqual([p.status_text, p.status_emoji], ['In a meeting', ':calendar:']);
  assert.equal(new Date(p.status_until).getTime(), new Date(until).getTime());
  p = await db.call(f.alice, 'set_status', { p_text: 'Back at 3' });
  assert.deepEqual([p.status_text, p.status_emoji, p.status_until], ['Back at 3', null, null], 'no expiry');
  p = await db.call(f.alice, 'set_status', {});
  assert.deepEqual([p.status_text, p.status_emoji, p.status_until], [null, null, null], 'cleared');
  await expectError(db.call(f.alice, 'set_status', { p_text: 'x'.repeat(101) }), 'invalid_input');
  await expectError(db.call(f.alice, 'set_status', { p_emoji: 'x'.repeat(65) }), 'invalid_input');
  await expectError(db.call(f.alice, 'set_status',
    { p_text: 'late', p_until: new Date(Date.now() - 60e3).toISOString() }), 'invalid_input');
}));

test('notification prefs: defaults, full and partial patches, a missing row, quiet hours rules', () => tx(async (db) => {
  const f = await db.fixture();
  assert.deepEqual(await db.call(f.alice, 'get_notification_prefs'), DEFAULT_PREFS);
  const all = { default_level: 'all', dm_level: 'none', thread_replies: false, quiet_start: '22:30',
                quiet_end: '07:00', quiet_tz: 'Europe/London', preview: 'name_only' };
  assert.deepEqual(await db.call(f.alice, 'set_notification_prefs', { p_patch: all }), all);
  assert.deepEqual(await db.call(f.alice, 'set_notification_prefs', { p_patch: { preview: 'none' } }),
    { ...all, preview: 'none' }, 'a partial patch keeps the rest');
  assert.deepEqual(await db.call(f.alice, 'set_notification_prefs', { p_patch: { quiet_start: null, quiet_end: null } }),
    { ...all, preview: 'none', quiet_start: null, quiet_end: null });
  assert.deepEqual(await db.call(f.alice, 'get_notification_prefs'),
    { ...all, preview: 'none', quiet_start: null, quiet_end: null }, 'stored');
  await db.q('delete from dek.notification_prefs where user_id = $1', [f.bob]);
  assert.deepEqual(await db.call(f.bob, 'get_notification_prefs'), DEFAULT_PREFS, 'an imported account without a row');
  assert.equal((await db.call(f.bob, 'set_notification_prefs', { p_patch: { default_level: 'none' } })).default_level, 'none');
  assert.deepEqual(await db.call(f.carol, 'set_notification_prefs', { p_patch: {} }), DEFAULT_PREFS, 'an empty patch');
}));

test('notification prefs: validation', () => tx(async (db) => {
  const f = await db.fixture();
  const bad = (patch) => expectError(db.call(f.alice, 'set_notification_prefs', { p_patch: patch }), 'invalid_input');
  await bad({ default_level: 'loud' });
  await bad({ default_level: null });
  await bad({ dm_level: 'mentions' });
  await bad({ thread_replies: 'yes' });
  await bad({ quiet_start: '25:00', quiet_end: '07:00' });
  await bad({ quiet_start: '9:00', quiet_end: '17:00' });
  await bad({ quiet_start: '22:00' });
  await bad({ quiet_start: '08:00', quiet_end: '08:00' });
  await bad({ quiet_tz: 'Nowhere/Land' });
  await bad({ quiet_tz: null });
  await bad({ preview: 'partial' });
  await bad({ sound: true });
  await expectError(db.call(f.alice, 'set_notification_prefs', { p_patch: 'null' }), 'invalid_input');
  assert.deepEqual(await db.call(f.alice, 'get_notification_prefs'), DEFAULT_PREFS, 'nothing half applied');
}));

test('no session and deleted accounts: every plat function refuses', () => tx(async (db) => {
  const f = await db.fixture();
  const calls = [
    ['update_profile', { p_patch: { title: 'x' } }], ['set_status', { p_text: 'x' }],
    ['get_notification_prefs', {}], ['set_notification_prefs', { p_patch: {} }],
    ['register_push_device', { p_kind: 'fcm', p_endpoint: 'x'.repeat(40) }],
    ['unregister_push_device', { p_endpoint: 'x' }], ['list_my_devices', {}], ['send_test_notification', {}],
    ['notification_health', {}], ['request_account_deletion', {}],
  ];
  for (const [fn, args] of calls) {
    const e = await expectError(db.call(null, fn, args));
    assert.equal(e.sqlstate, '42501', `${fn}: anon has no grant`);
  }
  await db.q('update dek.profiles set deleted_at = now() where id = $1', [f.alice]);
  for (const [fn, args] of calls) await expectError(db.call(f.alice, fn, args), 'auth_required');
}));
