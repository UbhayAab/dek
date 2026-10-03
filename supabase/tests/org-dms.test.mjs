// [org] direct messages: open_dm (1:1 and group), blocks, hide_dm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { mark, since, channelRow, sorted } from './org-lib.mjs';

test('open_dm 1:1: one conversation per pair per org, found from either side, keyed by sorted ids', () => tx(async (db) => {
  const f = await db.fixture();
  // the fixture DM was written with the same key rule, so open_dm finds it
  const ab = await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob] });
  assert.equal(ab.id, f.dmAliceBob);
  assert.equal(ab.kind, 'dm');
  assert.deepEqual(ab.dm_user_ids, [f.bob]);
  assert.equal((await db.call(f.bob, 'open_dm', { p_org: f.org, p_user_ids: [f.alice, f.bob] })).id, f.dmAliceBob);

  const before = await mark(db);
  const ac = await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.carol] });
  assert.equal(ac.kind, 'dm');
  assert.equal(ac.visibility, 'private');
  assert.equal(ac.server_id, null);
  assert.equal(ac.member, true);
  assert.equal(ac.member_count, 2);
  assert.deepEqual(ac.dm_user_ids, [f.carol]);
  const key = (await db.one('select dm_key from dek.channels where id = $1', [ac.id])).dm_key;
  assert.equal(key, `${f.org}:${[f.alice, f.carol].sort().join(':')}`);
  const ev = await since(db, before, { event: 'chan.upd' });
  assert.deepEqual(sorted(ev.map((e) => e.topic)), sorted([`u:${f.alice}`, `u:${f.carol}`]));
  const mu = await since(db, before, { event: 'member.upd' });
  assert.deepEqual(mu.map((e) => [e.topic, e.payload.scope, e.payload.user_id]), [[`u:${f.carol}`, 'channel', f.carol]]);
  const reopened = await mark(db);
  const ca = await db.call(f.carol, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] });
  assert.equal(ca.id, ac.id);
  assert.deepEqual(ca.dm_user_ids, [f.alice]);
  assert.equal((await since(db, reopened)).length, 0, 'reopening announces nothing');

  // guests can be messaged; the same pair in another org is another conversation
  assert.equal((await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.guest] })).kind, 'dm');
  const both = await db.user('In Both Orgs');
  await db.member(f.org, both);
  await db.member(f.otherOrg, both);
  const inJcf = await db.call(both, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] });
  const inSs = await db.call(both, 'open_dm', { p_org: f.otherOrg, p_user_ids: [f.eve] });
  assert.notEqual(inJcf.id, inSs.id);
  assert.equal(inSs.org_id, f.otherOrg);
}));

test('open_dm group: 2 to 8 others, one conversation per exact set, at most 9 people', () => tx(async (db) => {
  const f = await db.fixture();
  const g = await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob, f.carol] });
  assert.equal(g.kind, 'group_dm');
  assert.equal(g.member_count, 3);
  assert.deepEqual(sorted(g.dm_user_ids), sorted([f.bob, f.carol]));
  assert.equal((await db.call(f.carol, 'open_dm', { p_org: f.org, p_user_ids: [f.bob, f.alice, f.bob] })).id, g.id);
  assert.notEqual((await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob, f.carol, f.guest] })).id, g.id,
    'a different set is a different conversation');

  const extra = [];
  for (let i = 0; i < 9; i += 1) {
    const u = await db.user(`Extra ${i}`);
    await db.member(f.org, u);
    extra.push(u);
  }
  const nine = await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: extra.slice(0, 8) });
  assert.equal(nine.member_count, 9);
  await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: extra }), 'invalid_input');
  await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [] }), 'invalid_input');
  await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] }), 'invalid_input');
}));

test('open_dm: everyone must be an active member; blocked pairs refused; strangers and other tenants not_found', () => tx(async (db) => {
  const f = await db.fixture();
  for (const other of [f.eve, f.suspended, f.stranger]) {
    await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [other] }), 'invalid_input');
    await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob, other] }), 'invalid_input');
  }
  await db.call(f.bob, 'block_user', { p_user: f.alice, p_blocked: true });
  await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob] }), 'blocked');
  await expectError(db.call(f.bob, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] }), 'blocked');
  // adding one more person does not get round a block, in either direction
  await expectError(db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob, f.carol] }), 'blocked');
  await expectError(db.call(f.bob, 'open_dm', { p_org: f.org, p_user_ids: [f.alice, f.carol] }), 'blocked');
  // a third person is never told that two others blocked each other
  assert.equal((await db.call(f.carol, 'open_dm', { p_org: f.org, p_user_ids: [f.alice, f.bob] })).kind, 'group_dm');
  await db.call(f.bob, 'block_user', { p_user: f.alice, p_blocked: false });
  assert.equal((await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob] })).id, f.dmAliceBob);

  await expectError(db.call(f.eve, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] }), 'not_found');
  await expectError(db.call(f.eve, 'open_dm', { p_org: f.otherOrg, p_user_ids: [f.alice] }), 'invalid_input');
  await expectError(db.call(f.stranger, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] }), 'not_found');
  await expectError(db.call(f.suspended, 'open_dm', { p_org: f.org, p_user_ids: [f.alice] }), 'suspended');
}));

test('hide_dm: hides for the caller only; open_dm brings it back', () => tx(async (db) => {
  const f = await db.fixture();
  assert.deepEqual(await db.call(f.alice, 'hide_dm', { p_channel: f.dmAliceBob }), { channel_id: f.dmAliceBob, hidden: true });
  assert.equal((await channelRow(db, f.dmAliceBob, f.alice)).hidden, true);
  assert.equal((await channelRow(db, f.dmAliceBob, f.bob)).hidden, false);
  assert.equal((await db.call(f.alice, 'open_dm', { p_org: f.org, p_user_ids: [f.bob] })).hidden, false);
  assert.equal((await channelRow(db, f.dmAliceBob, f.alice)).hidden, false);

  const dmSuspended = await db.dm(f.org, f.suspended, f.alice);
  await expectError(db.call(f.suspended, 'hide_dm', { p_channel: dmSuspended }), 'suspended');
  await expectError(db.call(f.carol, 'hide_dm', { p_channel: f.dmAliceBob }), 'not_found');
  await expectError(db.call(f.alice, 'hide_dm', { p_channel: f.grants }), 'not_found');
  await expectError(db.call(f.eve, 'hide_dm', { p_channel: f.dmAliceBob }), 'not_found');
  await expectError(db.call(f.stranger, 'hide_dm', { p_channel: f.dmAliceBob }), 'not_found');
}));
