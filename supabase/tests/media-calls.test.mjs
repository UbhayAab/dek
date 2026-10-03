// Calls: the state machine of CONTRACT 2.8, its realtime events (call.ring, call.upd),
// the call intent, the DM system lines, rooms and their cap, and the reaper. Owner: [media].
// PRD DEK21 to DEK24, DEKA12, DEKA13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError, DekError } from './_harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const start = (db, uid, channel, media = 'audio') => db.call(uid, 'start_call', { p_channel: channel, p_media: media });
const answer = (db, uid, call, session = randomUUID()) => db.call(uid, 'answer_call', { p_call: call, p_session_id: session });
const decline = (db, uid, call) => db.call(uid, 'decline_call', { p_call: call });
const leave = (db, uid, call) => db.call(uid, 'leave_call', { p_call: call });
const join = (db, uid, channel, session = randomUUID()) => db.call(uid, 'join_room', { p_channel: channel, p_session_id: session });
const beat = (db, uid, call, session) => db.call(uid, 'call_heartbeat', { p_call: call, p_session_id: session });
const reap = (db) => db.q('select dek.media_reap_calls()');

const part = (call, uid) => call.participants.find((p) => p.user_id === uid);
const events = (db, event, callId) => db.q(
  `select topic, payload from realtime.messages
    where event = $1 and payload -> 'call' ->> 'id' = $2 order by inserted_at, id`, [event, callId]);
const systemLines = (db, channel) => db.q(
  "select body, meta from dek.messages where channel_id = $1 and kind = 'system' order by seq", [channel]);
const callRow = (db, id) => db.one('select * from dek.calls where id = $1', [id]);
// One emission writes one row per topic; count emissions on the call's own topic.
const emissions = async (db, callId) => (await events(db, 'call.upd', callId)).filter((e) => e.topic === `call:${callId}`).length;

// Call api.<fn> the way an Edge Function does: role service_role.
let spn = 0;
async function svc(db, fn, args = {}) {
  const keys = Object.keys(args);
  const sp = `media_svc_${++spn}`;
  await db.c.query(`savepoint ${sp}`);
  try {
    await db.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    await db.c.query('set local role service_role');
    const res = await db.c.query(`select api.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`,
      keys.map((k) => args[k]));
    await db.c.query('reset role');
    await db.c.query(`release savepoint ${sp}`);
    return res.rows[0]?.result;
  } catch (e) {
    await db.c.query(`rollback to savepoint ${sp}`);
    await db.c.query('reset role');
    throw new DekError(e.message, e.hint, e.code);
  }
}

// The standard fixture plus an audio room in Medical and a group DM (alice, bob, owner).
async function world(db) {
  const f = await db.fixture();
  f.voice = await db.channel(f.medical, 'voice', { kind: 'audio' });
  const g = await db.one(
    "insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'group_dm', 'private', $2) returning id",
    [f.org, `${f.org}:g:${randomUUID()}`]);
  f.group = g.id;
  for (const u of [f.alice, f.bob, f.owner]) await db.channelMember(f.group, u);
  return f;
}

test('start_call in a DM: the caller joins, the other person rings, one ring event, one call intent', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob);
  assert.equal(call.kind, 'direct');
  assert.equal(call.media, 'audio');
  assert.equal(call.channel_id, f.dmAliceBob);
  assert.equal(call.org_id, f.org);
  assert.equal(call.started_by, f.alice);
  assert.equal(call.ended_at, null);
  assert.equal(part(call, f.alice).state, 'joined');
  assert.match(part(call, f.alice).session_id, UUID, 'the server made the caller a session id');
  assert.equal(part(call, f.bob).state, 'ringing');
  assert.equal(part(call, f.bob).session_id, null);

  const rings = await events(db, 'call.ring', call.id);
  assert.deepEqual(rings.map((r) => r.topic), [`u:${f.bob}`], 'call.ring goes to the callee only');
  assert.equal(rings[0].payload.from, f.alice);
  assert.equal(rings[0].payload.v, 1);
  const upd = await events(db, 'call.upd', call.id);
  assert.deepEqual(upd.map((r) => r.topic).sort(), [`call:${call.id}`, `u:${f.alice}`, `u:${f.bob}`].sort());

  const intents = await db.q('select kind, org_id, channel_id, call_id, actor_id, status from dek.notification_intents where call_id = $1', [call.id]);
  assert.deepEqual(intents, [{ kind: 'call', org_id: f.org, channel_id: f.dmAliceBob, call_id: call.id,
    actor_id: f.alice, status: 'pending' }]);

  // one active call per conversation: pressing call again, from either side, returns it
  assert.equal((await start(db, f.bob, f.dmAliceBob)).id, call.id);
  assert.equal((await start(db, f.alice, f.dmAliceBob, 'video')).id, call.id);
  assert.equal((await db.one('select count(*)::int n from dek.notification_intents where call_id = $1', [call.id])).n, 1);
  assert.equal((await db.one('select count(*)::int n from dek.calls where channel_id = $1', [f.dmAliceBob])).n, 1);
}));

test('start_call: media, channel kinds, and who may call', () => tx(async (db) => {
  const f = await world(db);
  await expectError(start(db, f.alice, f.dmAliceBob, 'screen'), 'invalid_input');
  await expectError(start(db, f.alice, f.general), 'invalid_input');
  await expectError(start(db, f.stranger, f.dmAliceBob), 'not_found');
  await expectError(start(db, f.eve, f.dmAliceBob), 'not_found');
  await expectError(start(db, f.carol, f.dmAliceBob), 'not_found');
  await expectError(start(db, f.eve, f.otherChannel), 'invalid_input');   // her own text channel: not a call place
  const dmSusp = await db.dm(f.org, f.alice, f.suspended);
  await expectError(start(db, f.suspended, dmSusp), 'not_found');
  await expectError(start(db, f.alice, dmSusp), 'forbidden', 'a suspended person cannot be rung');
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  await expectError(start(db, f.alice, f.dmAliceBob), 'blocked');
  await expectError(start(db, f.bob, f.dmAliceBob), 'blocked');
  await db.q('delete from dek.user_blocks');
  const video = await start(db, f.alice, f.dmAliceBob, 'video');
  assert.equal(video.media, 'video');
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.group]);
  await expectError(start(db, f.alice, f.group), 'archived');
}));

test('start_call: rate limit 30 per 10 minutes', () => tx(async (db) => {
  const f = await world(db);
  for (let i = 0; i < 30; i += 1) await start(db, f.alice, f.dmAliceBob);
  await expectError(start(db, f.alice, f.dmAliceBob), 'rate_limited');
}));

test('answer_call: participants only; a new session re-attaches; an ended call is a conflict', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob);
  for (const u of [f.carol, f.eve, f.stranger, f.owner]) await expectError(answer(db, u, call.id), 'not_found');
  await expectError(db.call(f.bob, 'answer_call', { p_call: call.id, p_session_id: null }), 'invalid_input');
  await expectError(answer(db, f.bob, randomUUID()), 'not_found');

  const s1 = randomUUID();
  const a1 = await answer(db, f.bob, call.id, s1);
  assert.equal(part(a1, f.bob).state, 'joined');
  assert.equal(part(a1, f.bob).session_id, s1);
  assert.ok(part(a1, f.bob).joined_at);
  const n1 = await emissions(db, call.id);
  assert.equal((await answer(db, f.bob, call.id, s1)).id, call.id, 'same session: idempotent');
  assert.equal(await emissions(db, call.id), n1, 'and silent');

  const s2 = randomUUID();
  const a2 = await answer(db, f.bob, call.id, s2);
  assert.equal(part(a2, f.bob).session_id, s2, 'a reload re-attaches with a new session');
  assert.equal(part(a2, f.bob).joined_at, part(a1, f.bob).joined_at, 'talk time is kept');
  assert.equal(a2.participants.length, 2, 'no duplicate participant');
  assert.equal(await emissions(db, call.id), n1 + 1, 'peers hear about the new session');

  await leave(db, f.alice, call.id);
  await expectError(answer(db, f.bob, call.id), 'conflict');
}));

test('answer_call: rate limit 60 per minute (every new session is an event for everyone in the call)', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob);
  for (let i = 0; i < 60; i += 1) await answer(db, f.bob, call.id);
  await expectError(answer(db, f.bob, call.id), 'rate_limited');
}));

test('svc_turn_grant: relay credentials for active organization members only, 30 per 10 minutes', () => tx(async (db) => {
  const f = await world(db);
  assert.deepEqual(await svc(db, 'svc_turn_grant', { p_user: f.alice }), { ok: true });
  assert.deepEqual(await svc(db, 'svc_turn_grant', { p_user: f.guest }), { ok: true }, 'guests make calls too');
  assert.deepEqual(await svc(db, 'svc_turn_grant', { p_user: f.eve }), { ok: true }, 'a member of the other organization');
  await expectError(svc(db, 'svc_turn_grant', { p_user: f.stranger }), 'forbidden');
  await expectError(svc(db, 'svc_turn_grant', { p_user: f.suspended }), 'forbidden');
  await expectError(svc(db, 'svc_turn_grant', { p_user: null }), 'forbidden');
  for (let i = 1; i < 30; i += 1) await svc(db, 'svc_turn_grant', { p_user: f.alice });
  await expectError(svc(db, 'svc_turn_grant', { p_user: f.alice }), 'rate_limited');
  const e = await expectError(db.call(f.alice, 'svc_turn_grant', { p_user: f.alice }));
  assert.equal(e.sqlstate, '42501', 'not callable by signed-in people');
}));

test('decline_call: a 1:1 decline ends the call with "Call declined"', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob);
  await expectError(decline(db, f.carol, call.id), 'not_found');
  await expectError(decline(db, f.eve, call.id), 'not_found');
  const d = await decline(db, f.bob, call.id);
  assert.ok(d.ended_at);
  assert.equal(d.end_reason, 'declined');
  assert.equal(part(d, f.bob).state, 'declined');
  assert.equal(part(d, f.alice).state, 'left');
  const lines = await systemLines(db, f.dmAliceBob);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].body, 'Call declined');
  assert.equal(lines[0].meta.call_id, call.id);
  assert.equal(lines[0].meta.end_reason, 'declined');
  const news = await db.q(
    "select topic from realtime.messages where event = 'msg.new' and payload -> 'message' -> 'meta' ->> 'call_id' = $1", [call.id]);
  assert.deepEqual(news.map((r) => r.topic).sort(), [`u:${f.alice}`, `u:${f.bob}`].sort());
  // one transaction: every row has the same inserted_at, so look for the event, not the last row
  const ends = (await events(db, 'call.upd', call.id)).filter((e) => e.payload.call.end_reason === 'declined');
  assert.deepEqual(ends.map((e) => e.topic).sort(), [`call:${call.id}`, `u:${f.alice}`, `u:${f.bob}`].sort(),
    'the ending is announced on the call topic and to both people');
  // late or repeated declines change nothing
  assert.equal((await decline(db, f.bob, call.id)).end_reason, 'declined');
  assert.equal((await decline(db, f.alice, call.id)).end_reason, 'declined');
  assert.equal((await systemLines(db, f.dmAliceBob)).length, 1);
  // someone already in a call leaves it, they do not decline it
  const c2 = await start(db, f.alice, f.dmAliceBob);
  await answer(db, f.bob, c2.id);
  await expectError(decline(db, f.bob, c2.id), 'conflict');
}));

test('leave_call: after an answer the call ends for both with "Video call, N min"', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob, 'video');
  await answer(db, f.bob, call.id);
  await db.q("update dek.call_participants set joined_at = now() - interval '3 minutes 5 seconds' where call_id = $1 and user_id = $2",
    [call.id, f.bob]);
  await expectError(leave(db, f.carol, call.id), 'not_found');
  await expectError(leave(db, f.eve, call.id), 'not_found');
  const l = await leave(db, f.bob, call.id);
  assert.ok(l.ended_at, 'one side hanging up ends a 1:1 call');
  assert.equal(l.end_reason, 'completed');
  assert.equal(part(l, f.alice).state, 'left');
  assert.equal(part(l, f.bob).state, 'left');
  const [line] = await systemLines(db, f.dmAliceBob);
  assert.equal(line.body, 'Video call, 3 min');
  assert.ok(line.meta.duration_s >= 180 && line.meta.duration_s < 200);
  assert.equal(line.meta.media, 'video');
  assert.equal((await leave(db, f.alice, call.id)).end_reason, 'completed', 'ending is idempotent');
  assert.equal((await systemLines(db, f.dmAliceBob)).length, 1);
  const ended = await callRow(db, call.id);
  assert.ok(ended.ended_at);
  // the channel is free for the next call
  assert.notEqual((await start(db, f.alice, f.dmAliceBob)).id, call.id);
}));

test('leave_call: the caller hanging up before an answer is a missed call; a short call says 1 min', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.dmAliceBob);
  const l = await leave(db, f.alice, call.id);
  assert.equal(l.end_reason, 'missed');
  assert.equal(part(l, f.bob).state, 'missed', 'the phone stops ringing');
  assert.deepEqual((await systemLines(db, f.dmAliceBob)).map((x) => x.body), ['Missed call']);
  const c2 = await start(db, f.bob, f.dmAliceBob);
  await answer(db, f.alice, c2.id);
  await leave(db, f.alice, c2.id);
  assert.deepEqual((await systemLines(db, f.dmAliceBob)).map((x) => x.body), ['Missed call', 'Voice call, 1 min']);
  // a ringing person who hangs up has declined
  const c3 = await start(db, f.alice, f.dmAliceBob);
  assert.equal((await leave(db, f.bob, c3.id)).end_reason, 'declined');
}));

test('group call: a decline does not end it while someone can still answer; people rejoin; the last two end it', () => tx(async (db) => {
  const f = await world(db);
  const call = await start(db, f.alice, f.group);
  assert.deepEqual([part(call, f.bob).state, part(call, f.owner).state], ['ringing', 'ringing']);
  assert.equal((await events(db, 'call.ring', call.id)).length, 2);
  const d = await decline(db, f.bob, call.id);
  assert.equal(d.ended_at, null, 'the owner is still ringing');
  await answer(db, f.owner, call.id);
  const back = await answer(db, f.bob, call.id);
  assert.equal(part(back, f.bob).state, 'joined', 'a decline is not final while the call goes on');
  assert.equal((await leave(db, f.alice, call.id)).ended_at, null, 'two people are still talking');
  const end = await leave(db, f.owner, call.id);
  assert.equal(end.end_reason, 'completed', 'one person alone ends a direct call');
  assert.equal(part(end, f.bob).state, 'left');
  assert.equal((await systemLines(db, f.group))[0].body, 'Voice call, 1 min');
  // nobody answering a group call is a missed call
  const c2 = await start(db, f.alice, f.group);
  await decline(db, f.bob, c2.id);
  const all = await decline(db, f.owner, c2.id);
  assert.equal(all.end_reason, 'declined');
  assert.equal((await systemLines(db, f.group)).at(-1).body, 'Call declined');
  // someone who blocked the caller is not rung
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.owner, f.alice]);
  const c3 = await start(db, f.alice, f.group);
  assert.deepEqual(c3.participants.map((p) => p.user_id).sort(), [f.alice, f.bob].sort());
}));

test('reaper: 45 s of ringing is missed, 90 s of silence is left, empty calls end (and say so)', () => tx(async (db) => {
  const f = await world(db);
  const dm = await start(db, f.alice, f.dmAliceBob);
  const fresh = await start(db, f.owner, await db.dm(f.org, f.owner, f.admin));
  await db.q("update dek.call_participants set updated_at = now() - interval '50 seconds' where call_id = $1 and state = 'ringing'", [dm.id]);
  const before = await emissions(db, dm.id);
  await reap(db);
  const c = await db.one('select end_reason, ended_at from dek.calls where id = $1', [dm.id]);
  assert.equal(c.end_reason, 'missed');
  assert.ok(c.ended_at);
  assert.deepEqual((await systemLines(db, f.dmAliceBob)).map((x) => x.body), ['Missed call']);
  assert.equal(await emissions(db, dm.id), before + 1, 'the reaper announces what it changed');
  assert.equal((await callRow(db, fresh.id)).ended_at, null, 'a ring of a few seconds is left alone');

  const s = randomUUID();
  const room = await join(db, f.alice, f.voice, s);
  await join(db, f.bob, f.voice);
  await db.q("update dek.call_participants set last_heartbeat_at = now() - interval '100 seconds' where call_id = $1 and user_id = $2",
    [room.id, f.bob]);
  await reap(db);
  let r = await callRow(db, room.id);
  assert.equal(r.ended_at, null, 'the room goes on without the silent person (DEKA13)');
  assert.equal((await db.one('select state from dek.call_participants where call_id = $1 and user_id = $2', [room.id, f.bob])).state, 'left');
  await db.q("update dek.call_participants set last_heartbeat_at = now() - interval '100 seconds' where call_id = $1", [room.id]);
  await reap(db);
  r = await callRow(db, room.id);
  assert.equal(r.end_reason, 'completed');
  assert.deepEqual(await systemLines(db, f.voice), [], 'rooms do not post call lines');
}));

test('rooms: join, rejoin with a new session without a duplicate (DEKA13), the audience hears it', () => tx(async (db) => {
  const f = await world(db);
  const s1 = randomUUID();
  const r1 = await join(db, f.alice, f.voice, s1);
  assert.equal(r1.kind, 'room');
  assert.equal(r1.media, 'audio');
  assert.equal(r1.channel_id, f.voice);
  assert.equal(part(r1, f.alice).session_id, s1);
  const r2 = await join(db, f.bob, f.voice);
  assert.equal(r2.id, r1.id, 'one room per channel');
  const s2 = randomUUID();
  const r3 = await join(db, f.alice, f.voice, s2);
  assert.equal(r3.id, r1.id);
  assert.equal(r3.participants.filter((p) => p.user_id === f.alice).length, 1, 'no duplicate participant (DEKA13)');
  assert.equal(part(r3, f.alice).session_id, s2);
  assert.equal((await db.one('select count(*)::int n from dek.call_participants where call_id = $1 and user_id = $2',
    [r1.id, f.alice])).n, 1);
  const topics = new Set((await events(db, 'call.upd', r1.id)).map((e) => e.topic));
  for (const t of [`call:${r1.id}`, `u:${f.alice}`, `u:${f.bob}`, `s:${f.medical}`]) assert.ok(topics.has(t), t);
  // start_call in an audio channel joins its room with a session made by the server
  const r4 = await start(db, f.owner, f.voice);
  assert.equal(r4.id, r1.id);
  assert.match(part(r4, f.owner).session_id, UUID);
  // leave and come back: the same row again
  await leave(db, f.bob, r1.id);
  const r5 = await join(db, f.bob, f.voice);
  assert.equal(part(r5, f.bob).state, 'joined');
  assert.equal(r5.participants.length, 3);
  // everyone leaves: the room ends, and the next join opens a new one
  await leave(db, f.alice, r1.id);
  await leave(db, f.bob, r1.id);
  const gone = await leave(db, f.owner, r1.id);
  assert.equal(gone.end_reason, 'completed');
  assert.notEqual((await join(db, f.alice, f.voice)).id, r1.id);
}));

test('rooms: at most 8 joined; the ninth gets conflict until someone leaves', () => tx(async (db) => {
  const f = await world(db);
  const people = [f.owner, f.admin, f.alice, f.bob];
  for (let i = 0; i < 5; i += 1) {
    const u = await db.user(`Extra ${i}`);
    await db.member(f.org, u);
    await db.serverMember(f.medical, u);
    people.push(u);
  }
  let room;
  for (const u of people.slice(0, 8)) room = await join(db, u, f.voice);
  assert.equal(room.participants.filter((p) => p.state === 'joined').length, 8);
  const e = await expectError(join(db, people[8], f.voice), 'conflict');
  assert.match(e.hint, /full/);
  await expectError(start(db, people[8], f.voice), 'conflict');
  await join(db, people[0], f.voice);   // someone already inside reconnecting is not a ninth person
  await leave(db, people[3], room.id);
  const in9 = await join(db, people[8], f.voice);
  assert.equal(in9.participants.filter((p) => p.state === 'joined').length, 8);
}));

test('rooms: who may join (stranger, other tenant, guest, suspended, cross-team, archived, text)', () => tx(async (db) => {
  const f = await world(db);
  await expectError(join(db, f.alice, f.general), 'invalid_input');
  await expectError(db.call(f.alice, 'join_room', { p_channel: f.voice, p_session_id: null }), 'invalid_input');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(join(db, u, f.voice), 'not_found');
    await expectError(start(db, u, f.voice), 'not_found');
  }
  // a guest added to a private audio channel can join that one
  const backstage = await db.channel(f.medical, 'backstage', { kind: 'audio', visibility: 'private', members: [f.guest, f.alice] });
  const r = await join(db, f.guest, backstage);
  assert.equal(part(r, f.guest).state, 'joined');
  const t = new Set((await events(db, 'call.upd', r.id)).map((e) => e.topic));
  assert.ok(t.has(`u:${f.alice}`), 'a private room is announced to its members');
  assert.ok(!t.has(`s:${f.medical}`), 'and not to the whole server');
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.voice]);
  await expectError(join(db, f.alice, f.voice), 'archived');
}));

test('call_heartbeat: keeps the session alive; a replaced, reaped or ended session gets conflict', () => tx(async (db) => {
  const f = await world(db);
  const s1 = randomUUID();
  const room = await join(db, f.alice, f.voice, s1);
  await db.q("update dek.call_participants set last_heartbeat_at = now() - interval '60 seconds' where call_id = $1", [room.id]);
  assert.deepEqual(await beat(db, f.alice, room.id, s1), { ok: true });
  const hb = await db.one('select last_heartbeat_at > now() - interval \'5 seconds\' as fresh from dek.call_participants where call_id = $1 and user_id = $2',
    [room.id, f.alice]);
  assert.equal(hb.fresh, true);
  await expectError(beat(db, f.alice, room.id, randomUUID()), 'conflict');
  await expectError(beat(db, f.bob, room.id, s1), 'not_found');
  await expectError(beat(db, f.eve, room.id, s1), 'not_found');
  await expectError(beat(db, f.alice, randomUUID(), s1), 'not_found');
  // a member suspended mid-call cannot keep the session alive, so the reaper takes it
  const s2 = randomUUID();
  await join(db, f.bob, f.voice, s2);
  await db.member(f.org, f.bob, 'member', 'suspended');
  await expectError(beat(db, f.bob, room.id, s2), 'not_found');
  await expectError(leave(db, f.bob, room.id), 'suspended');
  await leave(db, f.alice, room.id);
  await expectError(beat(db, f.alice, room.id, s1), 'conflict');
}));

test('answer, decline, leave and heartbeat refuse the stranger, the other tenant, a guest outside the room, a suspended member', () => tx(async (db) => {
  const f = await world(db);
  const room = await join(db, f.alice, f.voice);
  const dm = await start(db, f.alice, f.dmAliceBob);
  const s = randomUUID();
  for (const u of [f.stranger, f.eve, f.guest, f.carol]) {
    for (const id of [room.id, dm.id]) {
      await expectError(answer(db, u, id), 'not_found');
      await expectError(decline(db, u, id), 'not_found');
      await expectError(leave(db, u, id), 'not_found');
      await expectError(beat(db, u, id, s), 'not_found');
    }
  }
  // bob is being rung, then suspended: he can no longer act on the call
  await db.member(f.org, f.bob, 'member', 'suspended');
  await expectError(answer(db, f.bob, dm.id), 'not_found');
  await expectError(decline(db, f.bob, dm.id), 'not_found');
  await expectError(leave(db, f.bob, dm.id), 'suspended');
  await expectError(beat(db, f.bob, dm.id, s), 'not_found');
  await expectError(answer(db, f.bob, room.id), 'not_found');
  assert.equal((await callRow(db, dm.id)).ended_at, null, 'nothing changed');
}));

test('get_call: participants and readers of a room only', () => tx(async (db) => {
  const f = await world(db);
  const dm = await start(db, f.alice, f.dmAliceBob);
  assert.equal((await db.call(f.alice, 'get_call', { p_call: dm.id })).id, dm.id);
  assert.equal((await db.call(f.bob, 'get_call', { p_call: dm.id })).id, dm.id);
  for (const u of [f.carol, f.eve, f.stranger, f.owner, f.guest]) {
    await expectError(db.call(u, 'get_call', { p_call: dm.id }), 'not_found');
  }
  const room = await join(db, f.alice, f.voice);
  assert.equal((await db.call(f.bob, 'get_call', { p_call: room.id })).id, room.id, 'a reader of the room channel');
  for (const u of [f.carol, f.eve, f.stranger, f.guest, f.suspended]) {
    await expectError(db.call(u, 'get_call', { p_call: room.id }), 'not_found');
  }
  await expectError(db.call(f.alice, 'get_call', { p_call: randomUUID() }), 'not_found');
}));

test('active_calls: rooms with people the caller can read, and calls ringing the caller', () => tx(async (db) => {
  const f = await world(db);
  const room = await join(db, f.alice, f.voice);
  const dm = await start(db, f.alice, f.dmAliceBob);
  const ids = async (u) => (await db.call(u, 'active_calls', { p_org: f.org })).map((c) => c.id).sort();
  assert.deepEqual(await ids(f.bob), [room.id, dm.id].sort(), 'the room plus the call ringing bob');
  assert.deepEqual(await ids(f.alice), [room.id, dm.id].sort(), 'alice is joined to her own call');
  assert.deepEqual(await ids(f.owner), [room.id]);
  assert.deepEqual(await ids(f.carol), [], 'not in Medical');
  assert.deepEqual(await ids(f.guest), []);
  await expectError(db.call(f.eve, 'active_calls', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'active_calls', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'active_calls', { p_org: f.org }), 'suspended');
  assert.deepEqual(await db.call(f.eve, 'active_calls', { p_org: f.otherOrg }), []);
  await decline(db, f.bob, dm.id);
  await leave(db, f.alice, room.id);
  assert.deepEqual(await ids(f.bob), [], 'ended calls and empty rooms are gone');
}));
