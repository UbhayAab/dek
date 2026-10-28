// [lead] 0916 browse_channels, request_channel_join, list and decide (Fixboard #19). The
// file is re-run inside each rolled-back transaction, so it is tested before it is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tx, expectError } from './_harness.mjs';
import { mark, since } from './org-lib.mjs';

const SQL = readFileSync(new URL('../migrations/0916_channel_requests.sql', import.meta.url), 'utf8');

test('browse_channels: every live channel of my servers, private ones locked without their topic', () => tx(async (db) => {
  await db.q(SQL);
  const f = await db.fixture();
  await db.q("update dek.channels set topic = 'secret plans' where id = $1", [f.secret]);
  const bob = (await db.call(f.bob, 'browse_channels', { p_org: f.org })).channels;
  const byId = Object.fromEntries(bob.map((c) => [c.id, c]));
  assert.equal(byId[f.general].member, true);
  assert.equal(byId[f.general].locked, false);
  assert.equal(byId[f.grants].locked, true, 'private, bob is not in it');
  assert.equal(byId[f.secret].locked, true);
  assert.equal(byId[f.secret].topic, null, 'a locked channel never shows its topic');
  assert.ok(byId[f.secret].name, 'the name is shown');
  assert.ok(byId[f.grants].member_count >= 1);
  assert.equal(byId[f.techGeneral], undefined, 'not a server bob is in');
  assert.equal(byId[f.otherChannel], undefined, 'other organization');

  const carol = (await db.call(f.carol, 'browse_channels', { p_org: f.org })).channels;
  assert.ok(carol.some((c) => c.id === f.grants && c.member), 'cross-team: the channel carol was added to');
  assert.ok(!carol.some((c) => c.id === f.general), 'carol is not in the medical server');
  const guest = (await db.call(f.guest, 'browse_channels', { p_org: f.org })).channels;
  assert.deepEqual(guest.map((c) => c.id), [f.grants], 'guests: only what they were added to');

  await expectError(db.call(f.eve, 'browse_channels', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'browse_channels', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'browse_channels', { p_org: f.org }), 'suspended');
}));

test('request_channel_join: a locked channel files one request, approvers are told and pushed', () => tx(async (db) => {
  await db.q(SQL);
  const f = await db.fixture();
  const approvers = (await db.q('select dek.channel_approvers($1) a', [f.secret]))[0].a;
  assert.ok(approvers.length > 0);
  assert.ok(!approvers.includes(f.bob));
  const before = await mark(db);
  const r1 = await db.call(f.bob, 'request_channel_join', { p_channel: f.secret, p_note: ' please ' });
  assert.equal(r1.status, 'pending');
  const r2 = await db.call(f.bob, 'request_channel_join', { p_channel: f.secret });
  assert.equal(r2.request_id, r1.request_id, 'asking twice keeps one request');
  const ev = await since(db, before, { event: 'join.req' });
  assert.deepEqual(ev.map((e) => e.topic).sort(), approvers.map((u) => `u:${u}`).sort());
  const intents = await db.q("select kind, target_user_id from dek.notification_intents where channel_request_id = $1", [r1.request_id]);
  assert.deepEqual(intents, [{ kind: 'request', target_user_id: null }]);
  assert.equal((await db.q('select note from dek.channel_join_requests where id = $1', [r1.request_id]))[0].note, 'please');
  const browse = (await db.call(f.bob, 'browse_channels', { p_org: f.org })).channels;
  assert.equal(browse.find((c) => c.id === f.secret).requested, true);

  // a public channel simply joins
  const pub = await db.channel(f.medical, 'random');
  assert.equal((await db.call(f.bob, 'request_channel_join', { p_channel: pub })).status, 'joined');
  // members: already joined
  assert.equal((await db.call(f.alice, 'request_channel_join', { p_channel: f.grants })).status, 'joined');

  await expectError(db.call(f.guest, 'request_channel_join', { p_channel: f.secret }), 'not_found');
  await expectError(db.call(f.carol, 'request_channel_join', { p_channel: f.secret }), 'not_found');
  await expectError(db.call(f.eve, 'request_channel_join', { p_channel: f.secret }), 'not_found');
  await expectError(db.call(f.stranger, 'request_channel_join', { p_channel: f.secret }), 'not_found');
  await expectError(db.call(f.bob, 'request_channel_join', { p_channel: f.dmAliceBob }), 'not_found');

  // withdraw
  assert.equal((await db.call(f.bob, 'withdraw_channel_request', { p_channel: f.secret })).status, 'none');
  assert.equal((await db.q('select status from dek.channel_join_requests where id = $1', [r1.request_id]))[0].status, 'withdrawn');
}));

test('list and decide: approvers only; approving adds the person and pushes them', () => tx(async (db) => {
  await db.q(SQL);
  const f = await db.fixture();
  const { request_id: id } = await db.call(f.bob, 'request_channel_join', { p_channel: f.secret });
  const approver = (await db.q('select dek.channel_approvers($1) a', [f.secret]))[0].a[0];

  const list = (await db.call(approver, 'list_channel_requests', { p_org: f.org })).items;
  assert.equal(list.length, 1);
  assert.equal(list[0].user.id, f.bob);
  assert.equal(list[0].channel.id, f.secret);
  assert.deepEqual((await db.call(f.bob, 'list_channel_requests', { p_org: f.org })).items, [], 'not an approver');
  await expectError(db.call(f.eve, 'list_channel_requests', { p_org: f.org }), 'not_found');

  await expectError(db.call(f.bob, 'decide_channel_request', { p_request: id, p_approve: true }), 'forbidden');
  await expectError(db.call(f.carol, 'decide_channel_request', { p_request: id, p_approve: true }), 'forbidden');
  await expectError(db.call(f.eve, 'decide_channel_request', { p_request: id, p_approve: true }), 'not_found');
  await expectError(db.call(approver, 'decide_channel_request', { p_request: id, p_approve: null }), 'invalid_input');

  const before = await mark(db);
  const d = await db.call(approver, 'decide_channel_request', { p_request: id, p_approve: true });
  assert.equal(d.status, 'approved');
  assert.equal((await db.q('select count(*)::int n from dek.channel_members where channel_id = $1 and user_id = $2', [f.secret, f.bob]))[0].n, 1);
  assert.ok((await since(db, before, { event: 'member.upd', topic: `u:${f.bob}` })).length >= 1);
  assert.ok((await since(db, before, { event: 'join.req', topic: `u:${f.bob}` })).length >= 1);
  const pushed = await db.q("select target_user_id from dek.notification_intents where channel_request_id = $1 and target_user_id is not null", [id]);
  assert.deepEqual(pushed.map((x) => x.target_user_id), [f.bob]);
  await expectError(db.call(approver, 'decide_channel_request', { p_request: id, p_approve: false }), 'conflict');

  // the route: approval goes to bob only, a decided request pushes nobody new
  const rows = await db.q("select * from dek.plat_route((select i from dek.notification_intents i where channel_request_id = $1 and target_user_id is null))", [id]);
  assert.equal(rows.length, 0, 'already decided: the approvers are not pushed any more');

  // reject path
  const { request_id: id2 } = await db.call(f.alice, 'request_channel_join', { p_channel: f.secret });
  assert.equal((await db.call(approver, 'decide_channel_request', { p_request: id2, p_approve: false })).status, 'rejected');
  assert.equal((await db.q('select count(*)::int n from dek.channel_members where channel_id = $1 and user_id = $2', [f.secret, f.alice]))[0].n, 0);
}));
