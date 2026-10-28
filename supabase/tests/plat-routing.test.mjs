// Notification routing: api.svc_claim_intent and api.svc_record_deliveries, the PRD
// DEK14, DEK17 and DEK18 matrix. Owner: plat. Every case runs inside one rolled-back
// transaction against the real project (the intent trigger's pg_net request rolls
// back with it, so nothing is ever sent from here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import {
  device, message, intent, msgIntent, claim, record, users, sorted, prefs, notify, intentRow, release,
} from './plat-lib.mjs';

// The standard fixture plus one push device for every person in it.
async function world(db) {
  const f = await db.fixture();
  for (const u of ['owner', 'admin', 'alice', 'bob', 'carol', 'guest', 'suspended', 'eve', 'stranger']) {
    f[`${u}Dev`] = await device(db, f[u]);
  }
  return f;
}

const quietAroundNow = (db, user) => db.q(
  `update dek.notification_prefs
      set quiet_start = ((now() at time zone 'Asia/Kolkata') - interval '1 hour')::time,
          quiet_end = ((now() at time zone 'Asia/Kolkata') + interval '1 hour')::time,
          quiet_tz = 'Asia/Kolkata'
    where user_id = $1`, [user]);

test('channel levels: default is mentions, all and none override; never the author or a suspended member', () => tx(async (db) => {
  const f = await world(db);
  const plain = async () => claim(db, await msgIntent(db, await message(db, f.general, f.alice, 'plain update'), f.alice));
  let r = await plain();
  assert.deepEqual(users(r), [], 'everyone is on the default level, mentions');
  assert.equal(r.intent.status, 'done', 'an intent with nothing to send is done');

  for (const u of [f.bob, f.suspended, f.alice]) await prefs(db, u, { default_level: 'all' });
  await notify(db, f.general, f.admin, 'all');
  r = await plain();
  assert.deepEqual(users(r), sorted(f.bob, f.admin), 'bob by preference, admin by channel override');

  await notify(db, f.general, f.bob, 'none');
  r = await plain();
  assert.deepEqual(users(r), [f.admin], 'a channel set to none beats the default');
}));

test('mentions: a direct mention and <!channel> notify at the mentions level; none still wins', () => tx(async (db) => {
  const f = await world(db);
  let r = await claim(db, await msgIntent(db,
    await message(db, f.general, f.alice, `hi <@${f.bob}>`, { mentions: [f.bob] }), f.alice));
  assert.deepEqual(users(r), [f.bob]);
  assert.equal(r.deliveries[0].urgency, 'high');
  assert.equal(r.deliveries[0].body, 'hi @Bob');

  r = await claim(db, await msgIntent(db,
    await message(db, f.general, f.alice, '<!channel> standup now', { all: true }), f.alice));
  assert.deepEqual(users(r), sorted(f.owner, f.admin, f.bob), 'every reader, not the author, not the suspended member');
  assert.ok(r.deliveries.every((d) => d.urgency === 'high'));

  await notify(db, f.general, f.bob, 'none');
  r = await claim(db, await msgIntent(db,
    await message(db, f.general, f.alice, `<@${f.bob}> ping`, { mentions: [f.bob] }), f.alice));
  assert.deepEqual(users(r), [], 'none means never, even for a direct mention');
}));

test('mute: only a direct mention gets through until muted_until passes', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.bob, { default_level: 'all' });
  await notify(db, f.general, f.bob, 'default', new Date(Date.now() + 3600e3));
  const send = async (body, opts) =>
    users(await claim(db, await msgIntent(db, await message(db, f.general, f.alice, body, opts), f.alice)));
  assert.deepEqual(await send('plain'), []);
  assert.deepEqual(await send('<!here> all hands', { all: true }), sorted(f.owner, f.admin),
    'a channel-wide mention does not break a mute');
  assert.deepEqual(await send(`<@${f.bob}> you there?`, { mentions: [f.bob] }), [f.bob], 'a direct mention does');
  await notify(db, f.general, f.bob, 'default', new Date(Date.now() - 60e3));
  assert.deepEqual(await send('plain again'), [f.bob], 'an expired mute is no mute');
}));

test('quiet hours: the push becomes one skipped delivery, recorded once, never sent', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.bob, { default_level: 'all' });
  await quietAroundNow(db, f.bob);   // may wrap midnight, which the rule must handle
  await notify(db, f.general, f.admin, 'all');
  const id = await msgIntent(db, await message(db, f.general, f.alice, 'late night update'), f.alice);
  let r = await claim(db, id);
  assert.deepEqual(users(r), [f.admin]);
  assert.deepEqual(r.skipped, [{ user_id: f.bob, device_id: f.bobDev, reason: 'quiet_hours' }]);
  const rows = () => db.q('select device_id, status, reason from dek.notification_deliveries where intent_id = $1', [id]);
  assert.deepEqual(await rows(), [{ device_id: f.bobDev, status: 'skipped', reason: 'quiet_hours' }]);
  await release(db, id);
  r = await claim(db, id);
  assert.deepEqual(r.skipped, [], 'a retry neither skips nor sends the same device again');
  assert.equal((await rows()).length, 1);

  await db.q(`update dek.notification_prefs
                 set quiet_start = ((now() at time zone 'Asia/Kolkata') + interval '2 hours')::time,
                     quiet_end = ((now() at time zone 'Asia/Kolkata') + interval '3 hours')::time
               where user_id = $1`, [f.bob]);
  r = await claim(db, await msgIntent(db, await message(db, f.general, f.alice, 'daytime'), f.alice));
  assert.deepEqual(users(r), sorted(f.admin, f.bob), 'outside the window the push goes out');
}));

test('quiet hours helper: plain and midnight-wrapping windows, the end is exclusive, bad zones never block', () => tx(async (db) => {
  const q = async (s, e, tz, at) =>
    (await db.one('select dek.plat_in_quiet_hours($1::time, $2::time, $3, $4::timestamptz) as q', [s, e, tz, at])).q;
  assert.equal(await q('22:00', '07:00', 'Asia/Kolkata', '2026-10-03T18:00:00Z'), true, '23:30 IST');
  assert.equal(await q('22:00', '07:00', 'Asia/Kolkata', '2026-10-03T00:30:00Z'), true, '06:00 IST');
  assert.equal(await q('22:00', '07:00', 'Asia/Kolkata', '2026-10-03T01:30:00Z'), false, '07:00 IST');
  assert.equal(await q('22:00', '07:00', 'Asia/Kolkata', '2026-10-03T06:30:00Z'), false, '12:00 IST');
  assert.equal(await q('09:00', '17:00', 'Asia/Kolkata', '2026-10-03T06:30:00Z'), true, '12:00 IST');
  assert.equal(await q('09:00', '17:00', 'Asia/Kolkata', '2026-10-03T12:30:00Z'), false, '18:00 IST');
  assert.equal(await q('09:00', '17:00', 'America/New_York', '2026-10-03T16:00:00Z'), true, '12:00 EDT');
  assert.equal(await q('09:00', '09:00', 'Asia/Kolkata', '2026-10-03T03:30:00Z'), false, 'empty window');
  assert.equal(await q('09:00', '17:00', 'Not/AZone', '2026-10-03T06:30:00Z'), false, 'unreadable zone');
}));

test('send-time recheck: blocks, deleted accounts, people who left, were removed or suspended', () => tx(async (db) => {
  const f = await world(db);
  for (const u of [f.owner, f.admin, f.bob]) await prefs(db, u, { default_level: 'all' });
  const send = async (ch, body = 'news', opts = {}) =>
    users(await claim(db, await msgIntent(db, await message(db, ch, f.alice, body, opts), f.alice)));
  assert.deepEqual(await send(f.general), sorted(f.owner, f.admin, f.bob));
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  assert.deepEqual(await send(f.general, `<@${f.bob}>`, { mentions: [f.bob] }), sorted(f.owner, f.admin),
    'bob blocked the author: not even a mention reaches him');
  await db.q('update dek.profiles set deleted_at = now() where id = $1', [f.admin]);
  assert.deepEqual(await send(f.general), [f.owner], 'deleted account');
  await db.q('select dek.revoke_org_membership($1, $2, false, null)', [f.org, f.owner]);
  assert.deepEqual(await send(f.general), [], 'left the organization');

  const both = { mentions: [f.carol, f.guest] };
  assert.deepEqual(await send(f.grants, 'review please', both), sorted(f.carol, f.guest),
    'the cross-team member and the guest of a private channel');
  await db.q('select dek.revoke_channel_membership($1, $2)', [f.grants, f.carol]);
  assert.deepEqual(await send(f.grants, 'review please', both), [f.guest], 'removed from the channel');
  await db.q("update dek.org_members set status = 'suspended' where org_id = $1 and user_id = $2", [f.org, f.guest]);
  assert.deepEqual(await send(f.grants, 'review please', both), [], 'suspended in the organization');
}));

test('other tenants and outsiders are never recipients, and their names never reach the text', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.eve, { default_level: 'all' });
  await prefs(db, f.stranger, { default_level: 'all' });
  const m = await message(db, f.general, f.alice, `<@${f.eve}> <@${f.stranger}> <!channel>`,
    { mentions: [f.eve, f.stranger], all: true });
  const r = await claim(db, await msgIntent(db, m, f.alice));
  assert.deepEqual(users(r), sorted(f.owner, f.admin, f.bob));
  assert.equal(r.deliveries[0].body, '@unknown @unknown @channel');
  const e = await message(db, f.otherChannel, f.eve, '<!channel>', { all: true });
  assert.deepEqual(users(await claim(db, await msgIntent(db, e, f.eve))), [], 'the other tenant stays separate');
}));

test('threads: followers with thread_replies on plus mentioned people; tag and link name the thread', () => tx(async (db) => {
  const f = await world(db);
  const root = await message(db, f.general, f.alice, 'proposal');
  const follow = (u, on = true) => db.q(
    `insert into dek.thread_follows (root_id, user_id, channel_id, org_id, following) values ($1, $2, $3, $4, $5)
     on conflict (root_id, user_id) do update set following = excluded.following`,
    [root.id, u, f.general, f.org, on]);
  await follow(f.alice);
  await follow(f.bob);
  await follow(f.owner, false);
  await prefs(db, f.owner, { default_level: 'all' });
  const reply = async (author, body = 'agreed', opts = {}) => {
    const m = await message(db, f.general, author, body, { root: root.id, ...opts });
    return { m, r: await claim(db, await msgIntent(db, m, author)) };
  };
  let { m, r } = await reply(f.admin);
  assert.deepEqual(users(r), sorted(f.alice, f.bob), 'followers; "all" covers the channel timeline, not threads');
  assert.equal(r.deliveries[0].tag, `t:${root.id}`);
  assert.equal(r.deliveries[0].url, `/o/${f.org}/c/${f.general}/t/${root.id}/m/${m.id}`);

  await prefs(db, f.bob, { thread_replies: false });
  ({ r } = await reply(f.admin));
  assert.deepEqual(users(r), [f.alice], 'thread_replies off');

  ({ r } = await reply(f.admin, `<@${f.owner}> can you sign?`, { mentions: [f.owner] }));
  assert.deepEqual(users(r), sorted(f.alice, f.owner), 'a mention reaches someone who does not follow');

  ({ r } = await reply(f.admin, 'also in the channel', { alsoInChannel: true }));
  assert.deepEqual(users(r), sorted(f.alice, f.owner), 'a reply also sent to the channel is a timeline message');
}));

test('DMs: dm_level, per-conversation overrides, titles, partners who left', () => tx(async (db) => {
  const f = await world(db);
  const send = async (ch, body = 'lunch?', opts = {}) =>
    claim(db, await msgIntent(db, await message(db, ch, f.alice, body, opts), f.alice));
  let r = await send(f.dmAliceBob);
  assert.deepEqual(users(r), [f.bob], 'DMs notify by default');
  const d = r.deliveries[0];
  assert.deepEqual([d.title, d.body, d.tag, d.urgency], ['Alice', 'lunch?', `c:${f.dmAliceBob}`, 'normal']);
  assert.match(d.url, new RegExp(`^/o/${f.org}/c/${f.dmAliceBob}/m/`));
  const root = r.intent.message_id;
  assert.deepEqual(users(await send(f.dmAliceBob, 'about that', { root })), [f.bob],
    'in a DM, all means every message, thread replies included');
  await prefs(db, f.bob, { dm_level: 'none' });
  assert.deepEqual(users(await send(f.dmAliceBob)), [], 'dm_level none');
  await notify(db, f.dmAliceBob, f.bob, 'all');
  assert.deepEqual(users(await send(f.dmAliceBob)), [f.bob], 'this conversation set to all overrides dm_level');

  const group = (await db.one(
    `insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'group_dm', 'private', $2) returning id`,
    [f.org, `g:${f.alice}:${f.carol}:${f.owner}`])).id;
  for (const u of [f.alice, f.carol, f.owner]) await db.channelMember(group, u);
  r = await send(group, 'plan');
  assert.deepEqual(users(r), sorted(f.carol, f.owner));
  assert.equal(r.deliveries[0].title, 'Alice in a group message');
  await db.q('select dek.revoke_org_membership($1, $2, false, null)', [f.org, f.carol]);
  assert.deepEqual(users(await send(group, 'still there?')), [f.owner], 'a partner who left the organization');
}));

test('preview privacy: full, name_only and none decide what a lock screen shows (DEK18)', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.bob, { default_level: 'all' });
  const one = async () => (await claim(db, await msgIntent(db,
    await message(db, f.general, f.alice, `deadline moved, <@${f.owner}> knows`, { mentions: [f.owner] }), f.alice)))
    .deliveries.find((x) => x.user_id === f.bob);
  let d = await one();
  assert.deepEqual([d.title, d.body, d.preview], ['Alice in #general', 'deadline moved, @Owner knows', 'full']);
  assert.deepEqual([d.org_id, d.org_short_name, d.device.id], [f.org, 'JCF Test', f.bobDev]);
  assert.ok(d.device.endpoint.startsWith('https://fcm.googleapis.com/') && d.device.p256dh && d.device.auth);
  assert.equal(d.device.enabled, true);
  await prefs(db, f.bob, { preview: 'name_only' });
  d = await one();
  assert.deepEqual([d.title, d.body, d.preview], ['Alice in #general', 'New message', 'name_only']);
  await prefs(db, f.bob, { preview: 'none' });
  d = await one();
  assert.deepEqual([d.title, d.body, d.preview], ['Dek', 'New message', 'none']);
}));

test('notification text: mentions, channel links, broadcasts, whitespace, the 140 character cut', () => tx(async (db) => {
  const f = await world(db);
  const render = async (body, viewer = f.bob) => (await db.one('select dek.plat_render_body($1, $2, $3) as t', [body, f.org, viewer])).t;
  assert.equal(await render(`Hi <@${f.bob}>,\n\n see  <#${f.general}> and <#${f.secret}>\t<!channel> <!here>`),
    'Hi @Bob, see #general and #channel @channel @here', 'a channel bob cannot read keeps its name to itself');
  assert.equal(await render(`<#${f.general}>`, null), '#channel', 'no viewer, no channel names');
  assert.equal(await render(`<#${f.general}>`, f.carol), '#channel', 'the cross-team member cannot read #general');
  assert.equal(await render(`<#${f.otherChannel}> <@00000000-0000-0000-0000-000000000000>`), '#channel @unknown');
  const long = await render('x'.repeat(300));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('...'));
  await db.q('update dek.profiles set deleted_at = now() where id = $1', [f.bob]);
  assert.equal(await render(`<@${f.bob}>`), '@Deleted user');
  await prefs(db, f.owner, { default_level: 'all' });
  const r = await claim(db, await msgIntent(db, await message(db, f.general, f.alice, '', { attachments: 1 }), f.alice));
  assert.equal(r.deliveries.find((x) => x.user_id === f.owner).body, 'Sent an attachment');
}));

test('channel links are rendered per recipient: a name only for people who can read that channel', () => tx(async (db) => {
  const f = await world(db);
  const body = `notes in <#${f.general}>`;
  const r = await claim(db, await msgIntent(db,
    await message(db, f.grants, f.alice, body, { mentions: [f.carol, f.guest] }), f.alice));
  assert.deepEqual(r.deliveries.map((d) => d.body), ['notes in #channel', 'notes in #channel'],
    'the cross-team member and the guest of Grants cannot read #general');
  await prefs(db, f.bob, { default_level: 'all' });
  const back = await claim(db, await msgIntent(db,
    await message(db, f.general, f.alice, `see <#${f.general}> and <#${f.grants}>`), f.alice));
  assert.equal(back.deliveries.find((d) => d.user_id === f.bob).body, 'see #general and #channel',
    'bob reads #general but is not in the private Grants');
}));

test('already read, deleted and system messages are not pushed; an intent aimed at one person skips the read check', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.bob, { default_level: 'all' });
  const m = await message(db, f.general, f.alice, 'seen it');
  await db.q('update dek.channel_members set last_read_seq = $3 where channel_id = $1 and user_id = $2',
    [f.general, f.bob, m.seq]);
  assert.deepEqual(users(await claim(db, await msgIntent(db, m, f.alice))), [], 'bob already read it');
  // edit_message added a mention of the owner: one intent aimed at the owner only
  await db.q('update dek.messages set mentions = $2 where id = $1', [m.id, [f.owner]]);
  await db.q('update dek.channel_members set last_read_seq = $3 where channel_id = $1 and user_id = $2',
    [f.general, f.owner, m.seq]);
  const aimed = await intent(db, 'message', { org: f.org, msg: m.id, channel: f.general, actor: f.alice, user: f.owner });
  assert.deepEqual(users(await claim(db, aimed)), [f.owner]);
  const gone = await message(db, f.general, f.alice, 'oops');
  await db.q('update dek.messages set deleted_at = now() where id = $1', [gone.id]);
  assert.deepEqual(users(await claim(db, await msgIntent(db, gone, f.alice))), [], 'deleted before dispatch');
  const sys = await db.one("select (dek.post_system($1, 'Call ended')).id as id", [f.general]);
  const sysIntent = await intent(db, 'message', { org: f.org, msg: sys.id, channel: f.general });
  assert.deepEqual(users(await claim(db, sysIntent)), [], 'system lines never notify');
}));

test('calls: ringing participants get a call push; preview none, quiet hours, declined and ended calls', () => tx(async (db) => {
  const f = await world(db);
  const call = (await db.one(
    "insert into dek.calls (org_id, channel_id, kind, started_by) values ($1, $2, 'direct', $3) returning id",
    [f.org, f.dmAliceBob, f.alice])).id;
  await db.q("insert into dek.call_participants (call_id, user_id, state) values ($1, $2, 'joined'), ($1, $3, 'ringing')",
    [call, f.alice, f.bob]);
  const id = await intent(db, 'call', { org: f.org, call, channel: f.dmAliceBob, actor: f.alice });
  let r = await claim(db, id, true);
  assert.deepEqual(users(r), [f.bob]);
  const d = r.deliveries[0];
  assert.deepEqual([d.title, d.body, d.url, d.tag, d.urgency],
    ['Incoming call', 'Alice is calling', `/o/${f.org}/call/${call}`, `call:${call}`, 'high']);
  await prefs(db, f.bob, { preview: 'none' });
  r = await claim(db, id, true);
  assert.deepEqual([r.deliveries[0].title, r.deliveries[0].body], ['Dek', 'Incoming call']);
  await quietAroundNow(db, f.bob);
  r = await claim(db, id, true);
  assert.deepEqual([users(r), r.skipped.map((s) => s.user_id)], [[], [f.bob]], 'quiet hours hold a call push too');
  await prefs(db, f.bob, { quiet_start: null, quiet_end: null });
  await db.q("update dek.call_participants set state = 'declined' where call_id = $1 and user_id = $2", [call, f.bob]);
  assert.deepEqual(users(await claim(db, id, true)), [], 'declined');
  await db.q("update dek.call_participants set state = 'ringing' where call_id = $1 and user_id = $2", [call, f.bob]);
  await db.q("update dek.calls set ended_at = now(), end_reason = 'cancelled' where id = $1", [call]);
  assert.deepEqual(users(await claim(db, id, true)), [], 'ended before dispatch');
}));

test('test notifications go to the one target device, or to every active device', () => tx(async (db) => {
  const f = await world(db);
  const second = await device(db, f.bob);
  await device(db, f.bob, { enabled: false });
  await device(db, f.bob, { revoked: true });
  const all = await db.call(f.bob, 'send_test_notification', {});
  let r = await claim(db, Number(all.intent_id));
  assert.deepEqual(r.deliveries.map((x) => x.device.id).sort(), sorted(f.bobDev, second));
  const d = r.deliveries[0];
  assert.deepEqual([d.user_id, d.title, d.body, d.url, d.tag, d.org_id],
    [f.bob, 'Dek test notification', 'If you can see this, notifications work on this device.',
      '/settings/notifications', 'test', null]);
  const one = await db.call(f.bob, 'send_test_notification', { p_device: second });
  r = await claim(db, Number(one.intent_id));
  assert.deepEqual(r.deliveries.map((x) => x.device.id), [second]);
}));

test('retries never double-notify; retryable failures retry; a dead endpoint is revoked', () => tx(async (db) => {
  const f = await world(db);
  const bob2 = await device(db, f.bob);
  await prefs(db, f.bob, { default_level: 'all' });
  await prefs(db, f.owner, { default_level: 'all' });
  const id = await msgIntent(db, await message(db, f.general, f.alice, 'ship it'), f.alice);
  let r = await claim(db, id);
  assert.deepEqual(r.deliveries.map((d) => d.device.id).sort(), sorted(f.bobDev, bob2, f.ownerDev));
  let row = await intentRow(db, id);
  assert.deepEqual([row.status, row.attempts], ['processing', 1]);
  assert.ok(new Date(row.locked_until) > new Date(Date.now() + 60e3), 'locked for about 2 minutes');
  assert.equal((await claim(db, id)).intent, null, 'a second dispatcher gets nothing while the first holds it');

  const out = await record(db, id, [
    { user_id: f.bob, device_id: f.bobDev, status: 'sent', reason: null, http_status: 201 },
    { user_id: f.bob, device_id: bob2, status: 'failed', reason: 'push service unavailable', http_status: 503 },
    { user_id: f.owner, device_id: f.ownerDev, status: 'failed', reason: 'subscription expired', http_status: 410 },
  ]);
  assert.deepEqual([out.status, out.recorded, out.revoked], ['pending', 3, 1]);
  row = await intentRow(db, id);
  assert.equal(row.locked_until, null);
  assert.match(row.last_error, /^retrying: 503/);
  const dev = (x) => db.one(`select enabled, revoked_at, last_status, failure_count, last_success_at, last_attempt_at
                               from dek.push_devices where id = $1`, [x]);
  const dead = await dev(f.ownerDev);
  assert.equal(dead.enabled, false);
  assert.ok(dead.revoked_at);
  assert.match(dead.last_status, /^expired 410/);
  const ok = await dev(f.bobDev);
  assert.ok(ok.last_success_at && ok.last_attempt_at);
  assert.equal(ok.failure_count, 0);
  assert.equal((await dev(bob2)).failure_count, 1);
  const kinds = await db.q('select device_id, status from dek.notification_deliveries where intent_id = $1', [id]);
  assert.equal(kinds.find((x) => x.device_id === f.ownerDev).status, 'expired');

  r = await claim(db, id);
  assert.deepEqual(r.deliveries.map((d) => d.device.id), [bob2], 'only the retryable failure is tried again');
  assert.equal((await intentRow(db, id)).attempts, 2);
  const done = await record(db, id, [{ user_id: f.bob, device_id: bob2, status: 'sent', http_status: 201 }]);
  assert.equal(done.status, 'done');
  assert.equal((await claim(db, id)).intent, null, 'a done intent is never claimed again');
  await release(db, id);
  assert.deepEqual((await claim(db, id)).deliveries, [], 'even a forced retry finds nothing left to send');
}));

test('record: 404 and VapidPkHashMismatch revoke; other 4xx and not_configured are final without revoking', () => tx(async (db) => {
  const f = await world(db);
  const d2 = await device(db, f.bob);
  const d3 = await device(db, f.bob);
  const d4 = await device(db, f.bob, { kind: 'fcm' });
  const d5 = await device(db, f.bob, { kind: 'fcm' });
  const d6 = await device(db, f.bob, { kind: 'apns' });
  await prefs(db, f.bob, { default_level: 'all' });
  const id = await msgIntent(db, await message(db, f.general, f.alice, 'x'), f.alice);
  assert.equal((await claim(db, id)).deliveries.length, 6);
  const out = await record(db, id, [
    { user_id: f.bob, device_id: f.bobDev, status: 'failed', reason: '{"reason":"VapidPkHashMismatch"}', http_status: 400 },
    { user_id: f.bob, device_id: d2, status: 'failed', reason: 'not found', http_status: 404 },
    { user_id: f.bob, device_id: d3, status: 'failed', reason: 'payload too large', http_status: 413 },
    { user_id: f.bob, device_id: d4, status: 'not_configured', reason: 'FCM is not configured' },
    { user_id: f.bob, device_id: d5, status: 'failed', reason: 'Requested entity was not found.', http_status: 404 },
    { user_id: f.bob, device_id: d6, status: 'expired', reason: 'Unregistered', http_status: 410 },
  ]);
  assert.deepEqual([out.status, out.revoked], ['done', 3], 'nothing retryable, so done');
  const st = await db.q('select id, enabled, last_status from dek.push_devices where id = any($1::uuid[])',
    [[f.bobDev, d2, d3, d4, d5, d6]]);
  const by = Object.fromEntries(st.map((x) => [x.id, x]));
  assert.equal(by[f.bobDev].enabled, false, 'web push VapidPkHashMismatch');
  assert.equal(by[d2].enabled, false, 'web push 404');
  assert.equal(by[d3].enabled, true);
  assert.equal(by[d4].enabled, true);
  assert.match(by[d4].last_status, /^not_configured/);
  assert.equal(by[d5].enabled, true, 'an FCM 404 can be a wrong project: never a revocation by itself');
  assert.equal(by[d6].enabled, false, 'the adapter said expired (APNs 410)');
  await expectError(record(db, 999999999999, []), 'not_found');
  await expectError(record(db, id, { not: 'an array' }), 'invalid_input');
}));

test('claim lifecycle: dry runs write nothing, hour-old intents expire, the fifth attempt is the last', () => tx(async (db) => {
  const f = await world(db);
  await prefs(db, f.bob, { default_level: 'all' });
  await prefs(db, f.owner, { default_level: 'all' });
  await quietAroundNow(db, f.owner);
  const m = await message(db, f.general, f.alice, 'dry');
  const id = await msgIntent(db, m, f.alice);
  const dry = await claim(db, id, true);
  assert.deepEqual(users(dry), [f.bob]);
  assert.deepEqual(dry.skipped.map((s) => s.user_id), [f.owner]);
  assert.deepEqual(await intentRow(db, id), { status: 'pending', attempts: 0, locked_until: null, last_error: null });
  assert.equal((await db.one('select count(*)::int n from dek.notification_deliveries where intent_id = $1', [id])).n, 0);

  const old = await msgIntent(db, m, f.alice);
  await db.q("update dek.notification_intents set created_at = now() - interval '2 hours' where id = $1", [old]);
  assert.equal((await claim(db, old)).intent, null);
  assert.equal((await intentRow(db, old)).status, 'expired');

  const tired = await msgIntent(db, m, f.alice);
  await db.q('update dek.notification_intents set attempts = 5 where id = $1', [tired]);
  assert.equal((await claim(db, tired)).intent, null);
  assert.equal((await intentRow(db, tired)).status, 'failed');

  const last = await msgIntent(db, m, f.alice);
  await db.q('update dek.notification_intents set attempts = 4 where id = $1', [last]);
  await claim(db, last);
  const out = await record(db, last, [{ user_id: f.bob, device_id: f.bobDev, status: 'failed', reason: 'timeout' }]);
  assert.equal(out.status, 'failed');
  assert.match((await intentRow(db, last)).last_error, /^gave up: network timeout/);
}));

test('service functions answer to service_role only', () => tx(async (db) => {
  const f = await world(db);
  const id = await intent(db, 'test', { user: f.bob, actor: f.bob });
  for (const [fn, args] of [
    ['svc_claim_intent', { p_intent: id }],
    ['svc_record_deliveries', { p_intent: id, p_results: '[]' }],
    ['svc_complete_account_deletion', { p_user: f.bob }],
  ]) {
    const e = await expectError(db.call(f.bob, fn, args));
    assert.equal(e.sqlstate, '42501', `${fn} must refuse authenticated`);
  }
}));

test('performance: one claim for a 300 person channel with <!channel>', () => tx(async (db) => {
  const f = await world(db);
  const ids = (await db.q(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
           'perf-' || g || '-' || substr(md5(random()::text), 1, 8) || '@dek-test.invalid', '', now(),
           '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('display_name', 'Perf ' || g),
           now(), now()
      from generate_series(1, 300) g
    returning id`)).map((r) => r.id);
  await db.q(`
    with om as (insert into dek.org_members (org_id, user_id) select $1, u from unnest($4::uuid[]) u returning user_id)
    , sm as (insert into dek.server_members (server_id, user_id, org_id) select $2, user_id, $1 from om returning user_id)
    , cm as (insert into dek.channel_members (channel_id, user_id, org_id) select $3, user_id, $1 from sm returning user_id)
    insert into dek.push_devices (user_id, kind, endpoint, p256dh, auth, last_seen_at)
    select user_id, 'webpush', 'https://fcm.googleapis.com/fcm/send/perf-' || user_id, repeat('A', 87), repeat('B', 22), now()
      from cm`, [f.org, f.medical, f.general, ids]);
  const m = await message(db, f.general, f.alice, '<!channel> everyone', { all: true });
  const id = await msgIntent(db, m, f.alice);
  const plan = await db.one('explain (analyze, format json) select api.svc_claim_intent($1)', [id]);
  const ms = plan['QUERY PLAN'][0]['Execution Time'];
  const n = (await db.one("select jsonb_array_length(api.svc_claim_intent($1, true) -> 'deliveries') as n", [id])).n;
  assert.equal(n, 303, '300 new members plus owner, admin and bob');
  assert.ok(ms < 1500, `claim took ${ms} ms`);
  console.log(`# plat perf: svc_claim_intent for 303 recipients took ${ms.toFixed(1)} ms server side`);
}));
