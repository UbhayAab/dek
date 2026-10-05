// Group calls through the SFU (0914). Owner: lead. CONTRACT 1 (Call.version, Call.sfu,
// participants' sfu_session and sfu_tracks), 2.9 (svc_sfu_gate, svc_sfu_publish), 3
// (call.upd), 5 (the sfu function). The switch lives in dek.settings (sfu_enabled,
// sfu_orgs); each test sets it inside its own rolled-back transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError, DekError } from './_harness.mjs';

const start = (db, uid, channel, media = 'audio') => db.call(uid, 'start_call', { p_channel: channel, p_media: media });
const answer = (db, uid, call, session = randomUUID()) => db.call(uid, 'answer_call', { p_call: call, p_session_id: session });
const leave = (db, uid, call) => db.call(uid, 'leave_call', { p_call: call });
const join = (db, uid, channel, session = randomUUID()) => db.call(uid, 'join_room', { p_channel: channel, p_session_id: session });
const getCall = (db, uid, call) => db.call(uid, 'get_call', { p_call: call });
const part = (call, uid) => call.participants.find((p) => p.user_id === uid);
const cfId = () => randomUUID().replace(/-/g, '');   // the shape of a Cloudflare session id

// Every row of one transaction has the same inserted_at, so the version is the order.
const updates = async (db, callId) => (await db.q(
  `select payload from realtime.messages
    where event = 'call.upd' and topic = $1 order by (payload -> 'call' ->> 'version')::bigint`, [`call:${callId}`]))
  .map((r) => r.payload.call);

// Call api.<fn> the way the sfu Edge Function does: role service_role.
let spn = 0;
async function svc(db, fn, args = {}) {
  const keys = Object.keys(args);
  const sp = `sfu_svc_${++spn}`;
  await db.c.query(`savepoint ${sp}`);
  try {
    await db.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    await db.c.query('set local role service_role');
    const res = await db.c.query(`select api.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`,
      keys.map((k) => (k === 'p_wanted' && args[k] !== null ? JSON.stringify(args[k]) : args[k])));
    await db.c.query('reset role');
    await db.c.query(`release savepoint ${sp}`);
    return res.rows[0]?.result;
  } catch (e) {
    await db.c.query(`rollback to savepoint ${sp}`);
    await db.c.query('reset role');
    throw new DekError(e.message, e.hint, e.code);
  }
}

const gate = (db, user, call, session, action = 'session', wanted = null) =>
  svc(db, 'svc_sfu_gate', { p_user: user, p_call: call, p_session: session, p_action: action, p_wanted: wanted });
const publish = (db, user, call, session, sfu, { add = [], remove = [], fresh = false, epoch = null } = {}) =>
  svc(db, 'svc_sfu_publish', {
    p_user: user, p_call: call, p_session: session, p_sfu_session: sfu, p_add: add, p_remove: remove, p_new_session: fresh, p_epoch: epoch,
  });

async function setting(db, key, value) {
  await db.q(`insert into dek.settings (key, value) values ($1, $2)
              on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, value]);
}

// The standard fixture, an audio room in Medical, a group DM (alice, bob, owner), and the
// switch off for everyone (the fixture orgs have random slugs, never in sfu_orgs).
async function world(db, { on = true } = {}) {
  const f = await db.fixture();
  f.voice = await db.channel(f.medical, 'voice', { kind: 'audio' });
  f.voice2 = await db.channel(f.medical, 'voice-two', { kind: 'audio' });
  const g = await db.one(
    "insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'group_dm', 'private', $2) returning id",
    [f.org, `${f.org}:g:${randomUUID()}`]);
  f.group = g.id;
  for (const u of [f.alice, f.bob, f.owner]) await db.channelMember(f.group, u);
  f.slug = (await db.one('select slug from dek.orgs where id = $1', [f.org])).slug;
  await setting(db, 'sfu_orgs', 'dek-qa');
  await setting(db, 'sfu_enabled', on ? 'true' : 'false');
  return f;
}

// A room with alice and bob joined, the SFU on.
async function room(db) {
  const f = await world(db);
  f.sa = randomUUID();
  f.sb = randomUUID();
  await join(db, f.alice, f.voice, f.sa);
  const call = await join(db, f.bob, f.voice, f.sb);
  f.call = call.id;
  return { f, call };
}

test('the switch and the rule: off by default; on, rooms and group calls go through the SFU, a 1:1 call never does', () => tx(async (db) => {
  const f = await world(db, { on: false });
  const defaults = await db.q("select key, value from dek.settings where key in ('sfu_enabled', 'sfu_orgs') order by key");
  assert.equal(defaults.length, 2);

  const off = await join(db, f.alice, f.voice);
  assert.equal(off.sfu, false, 'the switch is off');
  assert.equal(typeof off.version, 'number');
  assert.equal((await db.one('select sfu from dek.calls where id = $1', [off.id])).sfu, false);
  assert.deepEqual(part(off, f.alice).sfu_tracks, []);
  assert.equal(part(off, f.alice).sfu_session, null);
  await leave(db, f.alice, off.id);

  await setting(db, 'sfu_enabled', 'true');
  const r = await join(db, f.alice, f.voice);
  assert.notEqual(r.id, off.id);
  assert.equal(r.sfu, true, 'a room, even with one person in it');
  assert.equal((await db.one('select sfu from dek.calls where id = $1', [r.id])).sfu, true, 'stamped when it opened');

  const dm = await start(db, f.alice, f.dmAliceBob);
  assert.equal(dm.sfu, false, '1:1 calls keep the direct path');
  assert.equal((await answer(db, f.bob, dm.id)).sfu, false);

  const grp = await start(db, f.alice, f.group, 'video');
  assert.equal(grp.participants.length, 3);
  assert.equal(grp.sfu, true, 'a group call of three');
  assert.equal((await answer(db, f.owner, grp.id)).sfu, true);
}));

test('sfu_orgs turns it on per organization; switching off moves live calls back; on again only stamps new calls', () => tx(async (db) => {
  const f = await world(db, { on: false });
  await setting(db, 'sfu_orgs', ` dek-qa , ${f.slug}`);
  const r = await join(db, f.alice, f.voice);
  assert.equal(r.sfu, true, 'listed by slug (spaces ignored)');
  const otherRoom = await db.channel(f.otherServer, 'ss-voice', { kind: 'audio' });
  assert.equal((await join(db, f.eve, otherRoom)).sfu, false, 'another organization is not');

  await setting(db, 'sfu_orgs', 'dek-qa');
  assert.equal((await getCall(db, f.alice, r.id)).sfu, false, 'the kill switch reaches a live call');
  await setting(db, 'sfu_orgs', f.slug);
  assert.equal((await getCall(db, f.alice, r.id)).sfu, true, 'the stamp stays with the call');

  await setting(db, 'sfu_orgs', '');
  const before = await join(db, f.bob, f.voice2);
  await setting(db, 'sfu_enabled', 'true');
  assert.equal((await getCall(db, f.bob, before.id)).sfu, false, 'a call opened while off stays on the mesh');
}));

test('Call.version grows with every call.upd and matches what the call returns', () => tx(async (db) => {
  const f = await world(db);
  const a = await join(db, f.alice, f.voice);
  const b = await join(db, f.bob, f.voice);
  const c = await leave(db, f.bob, a.id);
  const seen = (await updates(db, a.id)).map((x) => x.version);
  assert.ok(a.version < b.version && b.version < c.version, `strictly increasing: ${a.version}, ${b.version}, ${c.version}`);
  assert.deepEqual(seen, [a.version, b.version, c.version], 'one call.upd per change, each with its own version');
  assert.equal((await getCall(db, f.alice, a.id)).version, c.version, 'get_call reads the same version');
}));

test('svc_sfu_gate: joined participants of an SFU call only, with their own session', () => tx(async (db) => {
  const { f } = await room(db);
  assert.deepEqual(await gate(db, f.alice, f.call, f.sa), { sfu_session: null, sfu_tracks: [], allowed: [] });
  for (const action of ['push', 'pull', 'renegotiate', 'close']) await gate(db, f.alice, f.call, f.sa, action);

  await expectError(gate(db, f.alice, f.call, f.sb), 'conflict');           // bob's session, not hers
  await expectError(gate(db, f.alice, f.call, randomUUID()), 'conflict');
  await expectError(gate(db, f.admin, f.call, randomUUID()), 'not_found');  // can read the room, never joined
  for (const who of [f.carol, f.guest, f.suspended, f.eve, f.stranger]) {
    await expectError(gate(db, who, f.call, randomUUID()), 'not_found');
  }
  await expectError(gate(db, f.alice, randomUUID(), f.sa), 'not_found');
  await expectError(gate(db, f.alice, f.call, f.sa, 'delete'), 'invalid_input');
  await expectError(gate(db, f.alice, f.call, null), 'invalid_input');
  await expectError(gate(db, f.alice, f.call, f.sa, 'pull', { session: 'x' }), 'invalid_input');
  await expectError(gate(db, f.alice, f.call, f.sa, 'pull', Array.from({ length: 65 }, () => ({ session: cfId(), name: 'mic-1' }))), 'invalid_input');

  // a member suspended mid-call is refused at once
  await db.member(f.org, f.bob, 'member', 'suspended');
  await expectError(gate(db, f.bob, f.call, f.sb), 'not_found');
  await db.member(f.org, f.bob, 'member', 'active');

  await leave(db, f.bob, f.call);
  await expectError(gate(db, f.bob, f.call, f.sb), 'conflict');
  await leave(db, f.alice, f.call);
  await expectError(gate(db, f.alice, f.call, f.sa), 'conflict');           // the room closed

  const e = await expectError(db.call(f.alice, 'svc_sfu_gate', { p_user: f.alice, p_call: f.call, p_session: f.sa, p_action: 'session' }));
  assert.equal(e.sqlstate, '42501', 'not callable by signed-in people');
  const p = await expectError(db.call(f.alice, 'svc_sfu_publish', { p_user: f.alice, p_call: f.call, p_session: f.sa, p_sfu_session: cfId() }));
  assert.equal(p.sqlstate, '42501');
}));

test('svc_sfu_gate: a 1:1 call, a ringing person, and a call that is not stamped get conflict', () => tx(async (db) => {
  const f = await world(db);
  const dm = await start(db, f.alice, f.dmAliceBob);
  const s = randomUUID();
  await answer(db, f.bob, dm.id, s);
  await expectError(gate(db, f.bob, dm.id, s), 'conflict');

  const grp = await start(db, f.alice, f.group);
  const mine = part(grp, f.alice).session_id;
  await gate(db, f.alice, grp.id, mine);                                     // the caller is joined
  await expectError(gate(db, f.bob, grp.id, randomUUID()), 'conflict');     // still ringing

  await setting(db, 'sfu_enabled', 'false');
  await expectError(gate(db, f.alice, grp.id, mine), 'conflict');           // switched off
}));

test('svc_sfu_publish records sessions and tracks for everyone (call.upd); pull sees only what others publish now', () => tx(async (db) => {
  const { f } = await room(db);
  const cfa = cfId();
  const cfb = cfId();
  const n0 = (await updates(db, f.call)).length;

  const a = await publish(db, f.alice, f.call, f.sa, cfa, { add: ['mic-1'], fresh: true });
  assert.equal(part(a, f.alice).sfu_session, cfa);
  assert.deepEqual(part(a, f.alice).sfu_tracks, ['mic-1']);
  const ups = await updates(db, f.call);
  assert.equal(ups.length, n0 + 1, 'one call.upd');
  assert.deepEqual(part(ups[ups.length - 1], f.alice).sfu_tracks, ['mic-1']);
  assert.equal(ups[ups.length - 1].version, a.version);
  const audience = await db.q(
    "select topic from realtime.messages where event = 'call.upd' and payload -> 'call' ->> 'version' = $1 order by topic",
    [String(a.version)]);
  assert.ok(audience.some((r) => r.topic === `u:${f.bob}`), 'reaches bob on his own topic');
  assert.ok(!audience.some((r) => r.topic === `s:${f.medical}`), 'not the whole server: only the people in the call');
  assert.ok(!audience.some((r) => r.topic === `u:${f.owner}`), 'nor someone who can see the room but is not in it');

  await publish(db, f.bob, f.call, f.sb, cfb, { add: ['mic-1', 'cam-1'], fresh: true });
  const wanted = [
    { session: cfb, name: 'mic-1' }, { session: cfb, name: 'cam-1' }, { session: cfb, name: 'mic-1' },
    { session: cfb, name: 'screen-1' },                 // not published
    { session: cfa, name: 'mic-1' },                    // her own
    { session: cfId(), name: 'mic-1' },                 // nobody's
    { name: 'mic-1' }, 'junk',
  ];
  const g = await gate(db, f.alice, f.call, f.sa, 'pull', wanted);
  assert.equal(g.sfu_session, cfa);
  assert.deepEqual(g.allowed, [{ session: cfb, name: 'cam-1' }, { session: cfb, name: 'mic-1' }]);

  // push and close change the list; a stale session id is refused
  let c = await publish(db, f.bob, f.call, f.sb, cfb, { add: ['screen-2'] });
  assert.deepEqual(part(c, f.bob).sfu_tracks, ['cam-1', 'mic-1', 'screen-2']);
  c = await publish(db, f.bob, f.call, f.sb, cfb, { remove: ['cam-1'] });
  assert.deepEqual(part(c, f.bob).sfu_tracks, ['mic-1', 'screen-2']);
  await expectError(publish(db, f.bob, f.call, f.sb, cfId(), { add: ['cam-2'] }), 'conflict');
  await expectError(publish(db, f.bob, f.call, f.sa, cfb, { add: ['cam-2'] }), 'conflict');   // not his session
  await expectError(publish(db, f.bob, f.call, f.sb, cfb, { add: ['video-1'] }), 'invalid_input');
  await expectError(publish(db, f.bob, f.call, f.sb, cfb, { add: ['cam-1', 'cam-2', 'cam-3', 'cam-4', 'cam-5'] }), 'invalid_input');
  await expectError(publish(db, f.bob, f.call, f.sb, 'bad id!', { fresh: true }), 'invalid_input');
  await expectError(publish(db, f.carol, f.call, randomUUID(), cfId(), { fresh: true }), 'not_found');

  // nothing changed: no event
  const n1 = (await updates(db, f.call)).length;
  await publish(db, f.bob, f.call, f.sb, cfb, { add: ['mic-1'] });
  assert.equal((await updates(db, f.call)).length, n1);

  // a new SFU session replaces the old one and its tracks
  const cfb2 = cfId();
  c = await publish(db, f.bob, f.call, f.sb, cfb2, { add: ['mic-1'], fresh: true });
  assert.equal(part(c, f.bob).sfu_session, cfb2);
  assert.deepEqual(part(c, f.bob).sfu_tracks, ['mic-1']);
  assert.deepEqual((await gate(db, f.alice, f.call, f.sa, 'pull', [{ session: cfb, name: 'mic-1' }])).allowed, []);

  // listening only: a session with nothing published
  const quiet = await publish(db, f.alice, f.call, f.sa, cfId(), { fresh: true });
  assert.deepEqual(part(quiet, f.alice).sfu_tracks, []);
}));

test('a setup still on its way from a replaced connection cannot overwrite the newer one (epoch)', () => tx(async (db) => {
  const { f } = await room(db);
  const older = cfId();
  const newer = cfId();
  const row = () => db.one('select sfu_session, sfu_epoch::text as epoch from dek.call_participants where call_id = $1 and user_id = $2', [f.call, f.alice]);
  await publish(db, f.alice, f.call, f.sa, newer, { add: ['mic-1'], fresh: true, epoch: 2000 });
  await expectError(publish(db, f.alice, f.call, f.sa, older, { add: ['mic-1'], fresh: true, epoch: 1000 }), 'conflict');
  await expectError(publish(db, f.alice, f.call, f.sa, older, { add: ['mic-1'], fresh: true, epoch: 2000 }), 'conflict');
  assert.deepEqual(await row(), { sfu_session: newer, epoch: '2000' });
  const later = cfId();
  await publish(db, f.alice, f.call, f.sa, later, { add: ['mic-1'], fresh: true, epoch: 3000 });
  assert.deepEqual(await row(), { sfu_session: later, epoch: '3000' });
  await publish(db, f.alice, f.call, f.sa, later, { add: ['cam-2'] });   // changes keep the number
  assert.equal((await row()).epoch, '3000');
  await leave(db, f.alice, f.call);
  assert.deepEqual(await row(), { sfu_session: null, epoch: '0' }, 'leaving starts the count again');
}));

test('leaving, a new session, or the reaper clears the SFU registration', () => tx(async (db) => {
  const { f } = await room(db);
  const owner = randomUUID();
  await join(db, f.owner, f.voice, owner);
  const reg = async (uid, s) => publish(db, uid, f.call, s, cfId(), { add: ['mic-1'], fresh: true });
  const row = (uid) => db.one('select state, sfu_session, sfu_tracks from dek.call_participants where call_id = $1 and user_id = $2', [f.call, uid]);

  await reg(f.bob, f.sb);
  await leave(db, f.bob, f.call);
  assert.deepEqual(await row(f.bob), { state: 'left', sfu_session: null, sfu_tracks: [] });
  const back = await join(db, f.bob, f.voice, f.sb);
  assert.equal(part(back, f.bob).sfu_session, null, 'back with the same session: publishes again before anyone pulls');

  await reg(f.alice, f.sa);
  const moved = await join(db, f.alice, f.voice, randomUUID());   // a reload, another device
  assert.equal(part(moved, f.alice).sfu_session, null);
  assert.deepEqual(part(moved, f.alice).sfu_tracks, []);

  await reg(f.owner, owner);
  await db.q("update dek.call_participants set last_heartbeat_at = now() - interval '2 minutes' where call_id = $1 and user_id = $2", [f.call, f.owner]);
  await db.q('select dek.media_reap_calls()');
  assert.deepEqual(await row(f.owner), { state: 'left', sfu_session: null, sfu_tracks: [] });
}));

test('a session whose person left, or that was replaced, is revoked at Cloudflare (a request queued for after commit)', () => tx(async (db) => {
  const { f } = await room(db);
  const cfa = cfId();
  const cfa2 = cfId();
  const cfb = cfId();
  // Only this test's sessions: the queue is shared with the pg_net worker.
  const revokes = async () => (await db.q(
    `select convert_from(body, 'UTF8')::jsonb as body, headers from net.http_request_queue
      where url like '%/sfu' and convert_from(body, 'UTF8')::jsonb ->> 'sfu_session' = any($1) order by id`,
    [[cfa, cfa2, cfb]]));

  await publish(db, f.alice, f.call, f.sa, cfa, { add: ['mic-1'], fresh: true });
  await publish(db, f.alice, f.call, f.sa, cfa, { add: ['cam-2'] });
  assert.equal((await revokes()).length, 0, 'registering and adding tracks revoke nothing');

  await publish(db, f.alice, f.call, f.sa, cfa2, { add: ['mic-1'], fresh: true });
  let q = await revokes();
  assert.deepEqual(q.map((r) => r.body), [{ action: 'revoke', sfu_session: cfa }], 'the replaced session');
  assert.ok(q[0].headers['x-dek-internal'], 'the internal secret rides along');

  await leave(db, f.alice, f.call);
  q = await revokes();
  assert.deepEqual(q.map((r) => r.body.sfu_session), [cfa, cfa2], 'leaving revokes the current one');

  await publish(db, f.bob, f.call, f.sb, cfb, { add: ['mic-1'], fresh: true });
  await db.q("update dek.call_participants set last_heartbeat_at = now() - interval '2 minutes' where call_id = $1 and user_id = $2", [f.call, f.bob]);
  await db.q('select dek.media_reap_calls()');
  q = await revokes();
  assert.deepEqual(q.map((r) => r.body.sfu_session), [cfa, cfa2, cfb], 'so does the reaper');
}));

test('rate limits: 20 new SFU sessions per 10 minutes, 120 actions a minute', () => tx(async (db) => {
  const { f } = await room(db);
  for (let i = 0; i < 20; i += 1) await gate(db, f.alice, f.call, f.sa, 'session');
  await expectError(gate(db, f.alice, f.call, f.sa, 'session'), 'rate_limited');
  for (let i = 20; i < 120; i += 1) await gate(db, f.alice, f.call, f.sa, 'pull');
  await expectError(gate(db, f.alice, f.call, f.sa, 'renegotiate'), 'rate_limited');
  await gate(db, f.bob, f.call, f.sb, 'pull');   // per person
}));
