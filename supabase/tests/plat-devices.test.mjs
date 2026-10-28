// Push devices, test notifications and the health screen (CONTRACT 2.6, PRD DEK15,
// DEK19). Owner: plat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import { device, webpushKeys } from './plat-lib.mjs';

const DEVICE_KEYS = ['created_at', 'enabled', 'failure_count', 'id', 'kind', 'label', 'last_attempt_at',
  'last_seen_at', 'last_status', 'last_success_at', 'platform'];

const sub = (endpoint, extra = {}) => {
  const k = webpushKeys();
  return { p_kind: 'webpush', p_endpoint: endpoint, p_p256dh: k.p256dh, p_auth: k.auth, ...extra };
};
const fcmUrl = () => `https://fcm.googleapis.com/fcm/send/t-${randomUUID()}`;

test('register_push_device: the Device shape without secrets, upsert by endpoint, every real push service', () => tx(async (db) => {
  const f = await db.fixture();
  const ep = fcmUrl();
  const args = sub(ep, { p_label: 'Chrome on Android', p_platform: 'android' });
  const d = await db.call(f.alice, 'register_push_device', args);
  assert.deepEqual(Object.keys(d).sort(), DEVICE_KEYS, 'no endpoint or keys leave the server');
  assert.deepEqual([d.kind, d.label, d.platform, d.enabled, d.failure_count, d.last_status],
    ['webpush', 'Chrome on Android', 'android', true, 0, null]);
  assert.ok(d.last_seen_at);
  const again = await db.call(f.alice, 'register_push_device', { ...args, p_label: null, p_platform: null });
  assert.equal(again.id, d.id, 'the same subscription is the same row');
  assert.equal(again.label, 'Chrome on Android', 'a refresh without a label keeps it');
  for (const base of ['https://web.push.apple.com/QK1', 'https://wns2-pn1p.notify.windows.com/w/?token=',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA', 'https://android.googleapis.com/gcm/send/']) {
    assert.equal((await db.call(f.alice, 'register_push_device', sub(base + randomUUID()))).kind, 'webpush', base);
  }
  const fcm = await db.call(f.alice, 'register_push_device',
    { p_kind: 'fcm', p_endpoint: `dGVzdA:APA91b${'x'.repeat(140)}`, p_platform: 'android' });
  assert.equal(fcm.kind, 'fcm');
  const apns = await db.call(f.alice, 'register_push_device', { p_kind: 'apns', p_endpoint: 'AB'.repeat(32) });
  assert.equal((await db.one('select endpoint from dek.push_devices where id = $1', [apns.id])).endpoint, 'ab'.repeat(32),
    'APNs tokens are stored lowercase');
  const own = await db.q('select user_id from dek.push_devices where id = any($1::uuid[])', [[d.id, fcm.id, apns.id]]);
  assert.ok(own.every((r) => r.user_id === f.alice));
}));

test('register_push_device: unknown push services, missing keys and malformed tokens are refused', () => tx(async (db) => {
  const f = await db.fixture();
  const bad = (args) => expectError(db.call(f.alice, 'register_push_device', args), 'invalid_input');
  await bad({ p_kind: 'sms', p_endpoint: 'x' });
  await bad(sub('http://fcm.googleapis.com/fcm/send/x'));
  await bad(sub('https://evil.example.com/fcm.googleapis.com/x'));
  await bad(sub('https://fcm.googleapis.com.evil.example/x'));
  await bad(sub('https://fcm.googleapis.com@evil.example/x'));
  await bad(sub('https://169.254.169.254/latest/meta-data'));
  await bad(sub('https://localhost/push'));
  await bad(sub(`https://fcm.googleapis.com/${'x'.repeat(2000)}`));
  await bad(sub(''));
  await bad({ p_kind: 'webpush', p_endpoint: fcmUrl() });
  await bad(sub(fcmUrl(), { p_p256dh: 'short' }));
  await bad(sub(fcmUrl(), { p_auth: 'has spaces in it!!' }));
  await bad({ p_kind: 'fcm', p_endpoint: 'not a token!' });
  await bad({ p_kind: 'apns', p_endpoint: 'xyz' });
  assert.equal((await db.one('select count(*)::int n from dek.push_devices where user_id = $1', [f.alice])).n, 0);
}));

test('register_push_device: a subscription moving to another account is re-owned with a clean status', () => tx(async (db) => {
  const f = await db.fixture();
  const args = sub(`https://web.push.apple.com/t-${randomUUID()}`, { p_label: 'iPhone' });
  const a = await db.call(f.alice, 'register_push_device', args);
  await db.q(`update dek.push_devices set last_status = 'sent 201', last_success_at = now(), last_attempt_at = now(),
                     failure_count = 2 where id = $1`, [a.id]);
  const b = await db.call(f.bob, 'register_push_device', { ...args, p_label: null });
  assert.equal(b.id, a.id);
  assert.deepEqual([b.label, b.last_status, b.last_success_at, b.last_attempt_at, b.failure_count],
    [null, null, null, null, 0], 'nothing of the previous person\'s label or history');
  assert.deepEqual(await db.call(f.alice, 'list_my_devices'), [], 'alice lost it at once');
  assert.deepEqual((await db.call(f.bob, 'list_my_devices')).map((x) => x.id), [a.id]);
  await db.q('update dek.push_devices set enabled = false, revoked_at = now() where id = $1', [b.id]);
  const back = await db.call(f.bob, 'register_push_device', args);
  assert.deepEqual([back.id, back.enabled], [a.id, true], 'a revoked subscription that comes back is live again');
}));

test('register_push_device: at most 10 active devices, the least recently seen retire', () => tx(async (db) => {
  const f = await db.fixture();
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const d = await db.call(f.alice, 'register_push_device', sub(fcmUrl()));
    ids.push(d.id);
    // registrations really happen minutes apart; one transaction has one now()
    await db.q("update dek.push_devices set last_seen_at = now() - make_interval(mins => 100 - $2) where id = $1", [d.id, i]);
  }
  const list = await db.call(f.alice, 'list_my_devices');
  assert.equal(list.length, 12);
  assert.equal(list.filter((d) => d.enabled).length, 10);
  assert.deepEqual(list.filter((d) => !d.enabled).map((d) => d.id).sort(), [ids[0], ids[1]].sort());
  assert.match(list.find((d) => d.id === ids[0]).last_status, /replaced/);
  assert.ok(list.slice(0, 10).every((d) => d.enabled), 'active devices are listed first');
}));

test('register_push_device: retired rows are capped too, so a loop of fake endpoints cannot grow the table', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 0; i < 35; i += 1) {
    const d = await db.call(f.alice, 'register_push_device', sub(fcmUrl()));
    await db.q("update dek.push_devices set last_seen_at = now() - make_interval(mins => 100 - $2) where id = $1", [d.id, i]);
  }
  const rows = await db.one(`select count(*)::int total, count(*) filter (where enabled and revoked_at is null)::int active
                               from dek.push_devices where user_id = $1`, [f.alice]);
  assert.deepEqual(rows, { total: 30, active: 10 }, '10 active plus the 20 most recent retired');
}));

test('unregister_push_device: by id or endpoint, only your own, idempotent (sign-out on a shared phone)', () => tx(async (db) => {
  const f = await db.fixture();
  const ep = fcmUrl();
  const a = await db.call(f.alice, 'register_push_device', sub(ep));
  assert.deepEqual(await db.call(f.bob, 'unregister_push_device', { p_device: a.id }), { removed: 0 });
  assert.deepEqual(await db.call(f.eve, 'unregister_push_device', { p_endpoint: ep }), { removed: 0 });
  assert.deepEqual(await db.call(f.alice, 'unregister_push_device', { p_endpoint: ep }), { removed: 1 });
  assert.deepEqual(await db.call(f.alice, 'unregister_push_device', { p_endpoint: ep }), { removed: 0 });
  const b = await db.call(f.alice, 'register_push_device', sub(fcmUrl()));
  assert.deepEqual(await db.call(f.alice, 'unregister_push_device', { p_device: b.id }), { removed: 1 });
  const t = await db.call(f.alice, 'register_push_device', { p_kind: 'apns', p_endpoint: 'CD'.repeat(32) });
  assert.deepEqual(await db.call(f.alice, 'unregister_push_device', { p_endpoint: 'CD'.repeat(32) }), { removed: 1 },
    'an APNs token in either case');
  assert.equal((await db.one('select count(*)::int n from dek.push_devices where id = $1', [t.id])).n, 0);
  await expectError(db.call(f.alice, 'unregister_push_device', {}), 'invalid_input');
}));

test('list_my_devices: only mine, revoked ones included and marked', () => tx(async (db) => {
  const f = await db.fixture();
  const live = await device(db, f.alice);
  const dead = await device(db, f.alice, { revoked: true });
  await device(db, f.bob);
  await device(db, f.eve);
  const list = await db.call(f.alice, 'list_my_devices');
  assert.deepEqual(list.map((d) => [d.id, d.enabled]), [[live, true], [dead, false]]);
}));

test('send_test_notification: an intent for your own device, refused for others, rate limited (DEK19)', () => tx(async (db) => {
  const f = await db.fixture();
  await expectError(db.call(f.alice, 'send_test_notification', {}), 'conflict');
  const mine = await device(db, f.alice);
  const off = await device(db, f.alice, { enabled: false });
  const bobs = await device(db, f.bob);
  await expectError(db.call(f.alice, 'send_test_notification', { p_device: bobs }), 'not_found');
  await expectError(db.call(f.eve, 'send_test_notification', { p_device: mine }), 'not_found');
  await expectError(db.call(f.alice, 'send_test_notification', { p_device: off }), 'conflict');
  const r = await db.call(f.alice, 'send_test_notification', { p_device: mine });
  assert.deepEqual(Object.keys(r), ['intent_id']);
  const row = await db.one(`select kind, target_user_id, target_device_id, actor_id, org_id, status
                              from dek.notification_intents where id = $1`, [r.intent_id]);
  assert.deepEqual(row, { kind: 'test', target_user_id: f.alice, target_device_id: mine, actor_id: f.alice,
                          org_id: null, status: 'pending' });
  for (let i = 0; i < 4; i += 1) await db.call(f.alice, 'send_test_notification', {});
  await expectError(db.call(f.alice, 'send_test_notification', {}), 'rate_limited');
  await db.call(f.bob, 'send_test_notification', {});   // limits are per person
}));

test('notification_health: my devices and my last 20 deliveries, newest first', () => tx(async (db) => {
  const f = await db.fixture();
  const mine = await device(db, f.alice);
  await device(db, f.bob);
  const id = (await db.one("select dek.enqueue_intent('test', null, p_target_user => $1) as id", [f.alice])).id;
  await db.q(`insert into dek.notification_deliveries (intent_id, user_id, device_id, kind, status, reason, http_status, created_at)
              select $1, $2, null, 'webpush', 'sent', 'n' || g, 201, now() - make_interval(secs => g)
                from generate_series(1, 25) g`, [id, f.alice]);
  await db.q(`insert into dek.notification_deliveries (intent_id, user_id, device_id, kind, status, created_at)
              values ($1, $2, null, 'webpush', 'failed', now())`, [id, f.bob]);
  const h = await db.call(f.alice, 'notification_health');
  assert.deepEqual(Object.keys(h).sort(), ['devices', 'recent']);
  assert.deepEqual(h.devices.map((d) => d.id), [mine]);
  assert.equal(h.recent.length, 20);
  assert.deepEqual(Object.keys(h.recent[0]).sort(), ['created_at', 'device_id', 'kind', 'reason', 'status']);
  assert.deepEqual([h.recent[0].reason, h.recent[19].reason], ['n1', 'n20'], 'newest first, bob\'s row not included');
  const empty = await db.call(f.carol, 'notification_health');
  assert.deepEqual(empty, { devices: [], recent: [] });
}));
