// [org] channels: listing, the cross-team rule, create, update, archive, join, leave, members, notify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { mark, since, setSettings, canRead, channelRow, auditRows, sorted, ids } from './org-lib.mjs';

const CHANNEL_KEYS = ['allow_reactions', 'allow_replies', 'archived', 'auto_join', 'category', 'created_at', 'created_by',
  'description', 'dm_user_ids', 'hidden', 'id', 'kind', 'last_message_at', 'last_read_seq', 'last_seq', 'member',
  'member_count', 'mentions', 'muted_until', 'my_role', 'name', 'notify', 'org_id', 'position', 'posting_policy',
  'server_id', 'topic', 'unread', 'visibility'];

test('list_channels: public plus my private channels for members; only my channels for partial access', () => tx(async (db) => {
  const f = await db.fixture();
  const random = await db.channel(f.medical, 'random');
  const old = await db.channel(f.medical, 'old', { members: [f.alice] });
  await db.q('update dek.channels set archived_at = now() where id = $1', [old]);

  const alice = await db.call(f.alice, 'list_channels', { p_server: f.medical });
  assert.deepEqual(ids(alice), sorted([f.general, f.grants, random, old]));
  assert.deepEqual(Object.keys(alice[0]).sort(), CHANNEL_KEYS);
  const byId = Object.fromEntries(alice.map((c) => [c.id, c]));
  assert.equal(byId[f.general].member, true);
  assert.equal(byId[random].member, false, 'public, not joined');
  assert.equal(byId[f.grants].my_role, 'owner');
  assert.equal(byId[old].archived, true);
  assert.equal(byId[f.grants].member_count, 3);

  assert.deepEqual(ids(await db.call(f.owner, 'list_channels', { p_server: f.medical })),
    sorted([f.general, f.secret, random, old]));
  assert.deepEqual(ids(await db.call(f.admin, 'list_channels', { p_server: f.medical })), sorted([f.general, random, old]),
    'org admins are not let into private channels');
  assert.deepEqual(ids(await db.call(f.carol, 'list_channels', { p_server: f.medical })), [f.grants]);
  assert.deepEqual(ids(await db.call(f.guest, 'list_channels', { p_server: f.medical })), [f.grants]);
  assert.deepEqual(ids(await db.call(f.carol, 'list_channels', { p_server: f.tech })), [f.techGeneral]);
  assert.deepEqual(await db.call(f.bob, 'list_channels', { p_server: f.tech }), []);
  await expectError(db.call(f.suspended, 'list_channels', { p_server: f.medical }), 'suspended');
  await expectError(db.call(f.eve, 'list_channels', { p_server: f.medical }), 'not_found');
  await expectError(db.call(f.stranger, 'list_channels', { p_server: f.medical }), 'not_found');
}));

test('cross-team contributor (DEKA04): added to Grants, sees Grants and nothing else of the host server', () => tx(async (db) => {
  const f = await db.fixture();
  const dana = await db.user('Dana (tech contributor)');
  await db.member(f.org, dana);
  await db.serverMember(f.tech, dana);
  // Alice (owner of Grants) adds Dana from the Tech team
  await db.call(f.alice, 'add_channel_members', { p_channel: f.grants, p_user_ids: [dana] });
  assert.equal(await canRead(db, dana, f.grants), true);
  assert.deepEqual(ids(await db.call(dana, 'list_channels', { p_server: f.medical })), [f.grants]);
  const medical = (await db.call(dana, 'list_servers', { p_org: f.org })).find((s) => s.id === f.medical);
  assert.equal(medical.my_role, null, 'Medical appears as a partial server');
  for (const ch of [f.general, f.secret]) {
    assert.equal(await canRead(db, dana, ch), false);
    await expectError(db.call(dana, 'join_channel', { p_channel: ch }), 'not_found');
    await expectError(db.call(dana, 'list_channel_members', { p_channel: ch }), 'not_found');
    await expectError(db.call(dana, 'update_channel', { p_channel: ch, p_patch: { topic: 'x' } }), 'not_found');
  }
  const topic = await db.as(dana, 'select dek.can_use_topic($1, $2, $3) as ok', [`s:${f.medical}`, 'read', 'broadcast']);
  assert.equal(topic[0].ok, false, 'no server topic either');
  await expectError(db.call(dana, 'create_channel', { p_server: f.medical, p_name: 'dana' }), 'forbidden');
  // a new private channel created with cross-team members gives them that channel only
  const c = await db.call(f.alice, 'create_channel', {
    p_server: f.medical, p_name: 'grant-writing', p_visibility: 'private', p_member_ids: [dana] });
  assert.deepEqual(ids(await db.call(dana, 'list_channels', { p_server: f.medical })), sorted([f.grants, c.id]));
  assert.equal(await canRead(db, dana, f.general), false);
}));

test('create_channel: owner is the creator; cross-team members; auto_join for admins; names unique', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const pub = await db.call(f.alice, 'create_channel', {
    p_server: f.medical, p_name: ' design ', p_topic: 'Visual work', p_description: 'Mockups\nand reviews',
    p_category: 'Work' });
  assert.deepEqual(Object.keys(pub).sort(), CHANNEL_KEYS);
  assert.equal(pub.name, 'design');
  assert.equal(pub.kind, 'text');
  assert.equal(pub.visibility, 'public');
  assert.equal(pub.my_role, 'owner');
  assert.equal(pub.member, true);
  assert.equal(pub.member_count, 1);
  assert.equal(pub.created_by, f.alice);
  assert.equal(pub.category, 'Work');
  const pubEv = await since(db, before, { event: 'chan.upd' });
  assert.deepEqual(pubEv.map((e) => [e.topic, e.payload.channel.id]), [[`s:${f.medical}`, pub.id]]);

  const b2 = await mark(db);
  const priv = await db.call(f.alice, 'create_channel', {
    p_server: f.medical, p_name: 'budget', p_visibility: 'private', p_member_ids: [f.bob, f.carol, f.guest, f.alice] });
  assert.equal(priv.member_count, 4);
  assert.equal(await canRead(db, f.carol, priv.id), true, 'cross-team member (DEK02)');
  assert.equal(await canRead(db, f.guest, priv.id), true);
  assert.equal(await canRead(db, f.admin, priv.id), false);
  assert.equal(await canRead(db, f.carol, f.general), false, 'and nothing else');
  const chanEv = await since(db, b2, { event: 'chan.upd' });
  assert.deepEqual(sorted(chanEv.map((e) => e.topic)), sorted([f.alice, f.bob, f.carol, f.guest].map((u) => `u:${u}`)));
  const memEv = await since(db, b2, { event: 'member.upd' });
  assert.deepEqual(sorted(memEv.map((e) => e.topic)), sorted([f.bob, f.carol, f.guest].map((u) => `u:${u}`)));
  assert.ok(memEv.every((e) => e.payload.scope === 'channel' && e.payload.change === 'added'));
  assert.equal((await auditRows(db, f.org, 'channel.created')).length, 2);

  const room = await db.call(f.owner, 'create_channel', { p_server: f.medical, p_name: 'Standup', p_kind: 'audio',
    p_auto_join: true, p_posting_policy: 'admins' });
  assert.equal(room.kind, 'audio');
  assert.equal(room.auto_join, true);
  assert.equal(room.posting_policy, 'admins');
  assert.equal(room.position, 3, 'appended after the existing channels');

  await expectError(db.call(f.bob, 'create_channel', { p_server: f.medical, p_name: 'GENERAL' }), 'conflict');
  await expectError(db.call(f.bob, 'create_channel', { p_server: f.medical, p_name: 'x', p_auto_join: true }), 'forbidden');
  await expectError(db.call(f.owner, 'create_channel', {
    p_server: f.medical, p_name: 'inner-circle', p_visibility: 'private', p_auto_join: true }), 'invalid_input');
  for (const a of [{ p_kind: 'dm' }, { p_visibility: 'secret' }, { p_posting_policy: 'nobody' }, { p_name: '' },
    { p_topic: 'x'.repeat(251) }, { p_member_ids: [f.eve] }, { p_member_ids: [f.suspended] }]) {
    await expectError(db.call(f.bob, 'create_channel', { p_server: f.medical, p_name: 'valid-name', ...a }), 'invalid_input');
  }
  await expectError(db.call(f.carol, 'create_channel', { p_server: f.medical, p_name: 'c' }), 'forbidden');
  await expectError(db.call(f.guest, 'create_channel', { p_server: f.medical, p_name: 'g' }), 'forbidden');
  assert.equal((await db.call(f.carol, 'create_channel', { p_server: f.tech, p_name: 'infra' })).my_role, 'owner');
  await expectError(db.call(f.bob, 'create_channel', { p_server: f.tech, p_name: 'b' }), 'forbidden');
  await expectError(db.call(f.suspended, 'create_channel', { p_server: f.medical, p_name: 's' }), 'suspended');
  await expectError(db.call(f.eve, 'create_channel', { p_server: f.medical, p_name: 'e' }), 'not_found');
  await expectError(db.call(f.stranger, 'create_channel', { p_server: f.medical, p_name: 'st' }), 'not_found');
  await setSettings(db, f.org, { member_can_create_channels: false });
  await expectError(db.call(f.bob, 'create_channel', { p_server: f.medical, p_name: 'b2' }), 'forbidden');
  assert.equal((await db.call(f.admin, 'create_channel', { p_server: f.medical, p_name: 'a2' })).my_role, 'owner');
}));

test('update_channel: owner or server admins; announcement mode; public to private only', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const g = await db.call(f.alice, 'update_channel', { p_channel: f.grants, p_patch: {
    name: 'grants-2026', topic: 'CSR applications', description: 'All grant work', allow_replies: false,
    allow_reactions: false, category: 'Funding', position: 7 } });
  assert.equal(g.name, 'grants-2026');
  assert.equal(g.topic, 'CSR applications');
  assert.equal(g.allow_replies, false);
  assert.equal(g.allow_reactions, false);
  assert.equal(g.category, 'Funding');
  assert.equal(g.position, 7);
  const ev = await since(db, before, { event: 'chan.upd' });
  assert.deepEqual(sorted(ev.map((e) => e.topic)), sorted([f.alice, f.carol, f.guest].map((u) => `u:${u}`)));
  assert.equal(ev[0].payload.channel.topic, 'CSR applications');
  assert.equal((await auditRows(db, f.org, 'channel.updated')).length, 1);

  // announcement channel (DEK03): only moderators post, replies still allowed
  await db.call(f.owner, 'update_channel', { p_channel: f.general, p_patch: { posting_policy: 'admins' } });
  await expectError(db.safe('select dek.assert_post($1, $2)', [f.alice, f.general]), 'forbidden');
  await db.safe('select dek.assert_post($1, $2, true)', [f.alice, f.general]);
  await db.safe('select dek.assert_post($1, $2)', [f.owner, f.general]);

  // public to private: explicit members keep it, other server members lose it
  const newcomer = await db.user('Newcomer');
  await db.member(f.org, newcomer);
  await db.serverMember(f.medical, newcomer);
  assert.equal(await canRead(db, newcomer, f.general), true);
  const b2 = await mark(db);
  const priv = await db.call(f.owner, 'update_channel', {
    p_channel: f.general, p_patch: { visibility: 'private', topic: 'Secret plans' } });
  assert.equal(priv.visibility, 'private');
  assert.equal(priv.topic, 'Secret plans');
  assert.equal(await canRead(db, newcomer, f.general), false);
  assert.equal(await canRead(db, f.bob, f.general), true);
  const serverEv = await since(db, b2, { event: 'chan.upd', topic: `s:${f.medical}` });
  assert.equal(serverEv.length, 1, 'server members are told the channel went private');
  assert.equal(serverEv[0].payload.channel.visibility, 'private');
  assert.equal(serverEv[0].payload.channel.topic, null, 'but not the topic written in the same patch');
  const memberEv = await since(db, b2, { event: 'chan.upd', topic: `u:${f.bob}` });
  assert.equal(memberEv[0].payload.channel.topic, 'Secret plans', 'members get the new state');
  await expectError(db.call(f.owner, 'update_channel', { p_channel: f.general, p_patch: { visibility: 'public' } }),
    'invalid_input');

  await expectError(db.call(f.alice, 'update_channel', { p_channel: f.grants, p_patch: { auto_join: true } }), 'forbidden');
  assert.equal((await db.call(f.owner, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'Set by an admin' } }))
    .topic, 'Set by an admin', 'server admins manage private channels they are not in');
  // auto_join is for public channels only; going private ends it
  await expectError(db.call(f.owner, 'update_channel', { p_channel: f.grants, p_patch: { auto_join: true } }),
    'invalid_input');
  const lobby = await db.call(f.owner, 'create_channel', { p_server: f.medical, p_name: 'lobby', p_auto_join: true });
  assert.equal(lobby.auto_join, true);
  assert.equal((await db.call(f.owner, 'update_channel', { p_channel: lobby.id, p_patch: { visibility: 'private' } }))
    .auto_join, false);
  await expectError(db.call(f.owner, 'update_channel', {
    p_channel: lobby.id, p_patch: { auto_join: true } }), 'invalid_input');
  await expectError(db.call(f.alice, 'update_channel', { p_channel: f.grants, p_patch: { name: 'leadership' } }), 'conflict');
  for (const p of [{ kind: 'audio' }, { allow_replies: 'no' }, { posting_policy: 'all' }, { position: 1.5 }, { name: null }]) {
    await expectError(db.call(f.alice, 'update_channel', { p_channel: f.grants, p_patch: p }), 'invalid_input');
  }
  await expectError(db.call(f.carol, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'forbidden');
  await expectError(db.call(f.guest, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'forbidden');
  await expectError(db.call(f.bob, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'not_found');
  await expectError(db.call(f.alice, 'update_channel', { p_channel: f.dmAliceBob, p_patch: { topic: 'x' } }), 'forbidden');
  await expectError(db.call(f.suspended, 'update_channel', { p_channel: f.general, p_patch: { topic: 'x' } }), 'suspended');
  await expectError(db.call(f.eve, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'not_found');
  await expectError(db.call(f.stranger, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'not_found');
}));

test('archive_channel: read only, reversible, owner or server admins', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  assert.equal((await db.call(f.alice, 'archive_channel', { p_channel: f.grants, p_archived: true })).archived, true);
  assert.equal((await since(db, before, { event: 'chan.upd' })).length, 3, 'each member of the private channel');
  await expectError(db.safe('select dek.assert_post($1, $2)', [f.carol, f.grants]), 'archived');
  assert.equal(await canRead(db, f.carol, f.grants), true, 'history stays readable');
  await expectError(db.call(f.alice, 'update_channel', { p_channel: f.grants, p_patch: { topic: 'x' } }), 'archived');
  await expectError(db.call(f.alice, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.bob] }), 'archived');
  // a new live channel took the name: unarchive refuses until it is renamed
  const clash = await db.call(f.alice, 'create_channel', { p_server: f.medical, p_name: 'Grants', p_visibility: 'private' });
  await expectError(db.call(f.alice, 'archive_channel', { p_channel: f.grants, p_archived: false }), 'conflict');
  await db.call(f.alice, 'update_channel', { p_channel: clash.id, p_patch: { name: 'grants-new' } });
  assert.equal((await db.call(f.owner, 'archive_channel', { p_channel: f.grants, p_archived: false })).archived, false);
  assert.deepEqual((await db.q(
    "select action from dek.audit_log where org_id = $1 and action like 'channel.%archived' order by id", [f.org]))
    .map((r) => r.action), ['channel.archived', 'channel.unarchived']);

  await expectError(db.call(f.alice, 'archive_channel', { p_channel: f.grants, p_archived: null }), 'invalid_input');
  await expectError(db.call(f.carol, 'archive_channel', { p_channel: f.grants, p_archived: true }), 'forbidden');
  await expectError(db.call(f.bob, 'archive_channel', { p_channel: f.general, p_archived: true }), 'forbidden');
  await expectError(db.call(f.bob, 'archive_channel', { p_channel: f.grants, p_archived: true }), 'not_found');
  await expectError(db.call(f.guest, 'archive_channel', { p_channel: f.grants, p_archived: true }), 'forbidden');
  await expectError(db.call(f.suspended, 'archive_channel', { p_channel: f.general, p_archived: true }), 'suspended');
  await expectError(db.call(f.eve, 'archive_channel', { p_channel: f.grants, p_archived: true }), 'not_found');
}));

test('join_channel and leave_channel: public channels of my servers; leaving a private channel revokes', () => tx(async (db) => {
  const f = await db.fixture();
  const design = await db.channel(f.medical, 'design', { members: [f.alice] });
  await db.message(design, f.alice, 'one');
  await db.message(design, f.alice, 'two');
  const before = await mark(db);
  const j = await db.call(f.bob, 'join_channel', { p_channel: design });
  assert.equal(j.member, true);
  assert.equal(j.my_role, 'member');
  assert.equal(j.last_read_seq, 2, 'joining does not make the history unread');
  assert.equal(j.unread, 0);
  const ev = await since(db, before, { event: 'member.upd', topic: `u:${f.bob}` });
  assert.equal(ev[0].payload.scope, 'channel');
  assert.equal((await db.call(f.bob, 'join_channel', { p_channel: design })).member, true, 'idempotent');
  for (const [u, ch] of [[f.carol, f.general], [f.guest, f.general], [f.bob, f.grants], [f.carol, f.dmAliceBob],
                         [f.eve, f.general], [f.stranger, f.general]]) {
    await expectError(db.call(u, 'join_channel', { p_channel: ch }), 'not_found');
  }
  await expectError(db.call(f.suspended, 'join_channel', { p_channel: design }), 'suspended');

  // leaving a public channel of my server is only "leave the sidebar"
  const b2 = await mark(db);
  assert.deepEqual(await db.call(f.bob, 'leave_channel', { p_channel: design }), { channel_id: design, left: true });
  assert.equal(await channelRow(db, design, f.bob), undefined);
  assert.equal(await canRead(db, f.bob, design), true);
  const bobEv = await since(db, b2, { topic: `u:${f.bob}` });
  assert.deepEqual(bobEv.map((e) => [e.event, e.payload.change]), [['member.upd', 'removed']]);
  assert.deepEqual(await db.call(f.bob, 'leave_channel', { p_channel: design }), { channel_id: design, left: true });
  // leaving a private channel revokes it
  const b3 = await mark(db);
  await db.call(f.carol, 'leave_channel', { p_channel: f.grants });
  assert.equal(await canRead(db, f.carol, f.grants), false);
  assert.equal((await since(db, b3, { event: 'access.revoked', topic: `u:${f.carol}` }))[0].payload.scope, 'channel');
  await expectError(db.call(f.carol, 'leave_channel', { p_channel: f.grants }), 'not_found');
  await expectError(db.call(f.alice, 'leave_channel', { p_channel: f.dmAliceBob }), 'invalid_input');
  await expectError(db.call(f.suspended, 'leave_channel', { p_channel: f.general }), 'suspended');
  await expectError(db.call(f.eve, 'leave_channel', { p_channel: f.general }), 'not_found');
}));

test('add_channel_members: private needs owner or server admin; public members add server members only', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const r = await db.call(f.alice, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.bob, f.carol] });
  assert.deepEqual(r, { channel_id: f.grants, added: [f.bob], already_members: [f.carol] });
  assert.equal(await canRead(db, f.bob, f.grants), true);
  const ev = await since(db, before, { event: 'member.upd', topic: `u:${f.bob}` });
  assert.equal(ev[0].payload.change, 'added');
  assert.equal((await auditRows(db, f.org, 'channel.members_added')).length, 1);
  await expectError(db.call(f.carol, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.admin] }), 'forbidden');
  assert.deepEqual((await db.call(f.owner, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.admin] })).added,
    [f.admin], 'server admins manage private channels');

  // a public channel: members may add people already in the server, nobody else
  const design = await db.channel(f.medical, 'design', { owner: f.alice });
  await expectError(db.call(f.bob, 'add_channel_members', { p_channel: design, p_user_ids: [f.admin] }), 'forbidden');
  await db.call(f.bob, 'join_channel', { p_channel: design });
  assert.deepEqual((await db.call(f.bob, 'add_channel_members', { p_channel: design, p_user_ids: [f.admin] })).added, [f.admin]);
  await expectError(db.call(f.bob, 'add_channel_members', { p_channel: design, p_user_ids: [f.carol] }), 'forbidden');
  await expectError(db.call(f.bob, 'add_channel_members', { p_channel: design, p_user_ids: [f.guest] }), 'forbidden');
  await db.call(f.alice, 'add_channel_members', { p_channel: design, p_user_ids: [f.carol, f.guest] });
  assert.equal(await canRead(db, f.carol, design), true);
  assert.equal(await canRead(db, f.carol, f.general), false, 'still nothing else (DEKA04)');

  for (const list of [[f.eve], [f.suspended], [], [f.stranger]]) {
    await expectError(db.call(f.alice, 'add_channel_members', { p_channel: f.grants, p_user_ids: list }), 'invalid_input');
  }
  await expectError(db.call(f.alice, 'add_channel_members', { p_channel: f.dmAliceBob, p_user_ids: [f.carol] }), 'invalid_input');
  await expectError(db.call(f.carol, 'add_channel_members', { p_channel: f.dmAliceBob, p_user_ids: [f.bob] }), 'not_found');
  await expectError(db.call(f.guest, 'add_channel_members', { p_channel: f.general, p_user_ids: [f.bob] }), 'not_found');
  await expectError(db.call(f.suspended, 'add_channel_members', { p_channel: f.general, p_user_ids: [f.bob] }), 'suspended');
  await expectError(db.call(f.eve, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.eve] }), 'not_found');
  await expectError(db.call(f.stranger, 'add_channel_members', { p_channel: f.grants, p_user_ids: [f.bob] }), 'not_found');
}));

test('remove_channel_member: owner or server admins; private removal revokes, public only leaves the sidebar', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  assert.deepEqual(await db.call(f.alice, 'remove_channel_member', { p_channel: f.grants, p_user: f.carol }),
    { channel_id: f.grants, user_id: f.carol, removed: true });
  assert.equal(await canRead(db, f.carol, f.grants), false);
  assert.equal((await since(db, before, { event: 'access.revoked', topic: `u:${f.carol}` }))[0].payload.scope, 'channel');
  assert.equal((await auditRows(db, f.org, 'channel.member_removed')).length, 1);
  await db.call(f.owner, 'remove_channel_member', { p_channel: f.grants, p_user: f.guest });
  assert.equal(await canRead(db, f.guest, f.grants), false);
  const b2 = await mark(db);
  await db.call(f.owner, 'remove_channel_member', { p_channel: f.general, p_user: f.bob });
  assert.equal(await canRead(db, f.bob, f.general), true, 'still a public channel of his server');
  assert.deepEqual((await since(db, b2, { topic: `u:${f.bob}` })).map((e) => e.event), ['member.upd']);

  await expectError(db.call(f.alice, 'remove_channel_member', { p_channel: f.grants, p_user: f.carol }), 'not_found');
  await db.channelMember(f.grants, f.carol);
  await expectError(db.call(f.carol, 'remove_channel_member', { p_channel: f.grants, p_user: f.alice }), 'forbidden');
  await expectError(db.call(f.bob, 'remove_channel_member', { p_channel: f.grants, p_user: f.carol }), 'not_found');
  await expectError(db.call(f.bob, 'remove_channel_member', { p_channel: f.general, p_user: f.alice }), 'forbidden');
  await expectError(db.call(f.suspended, 'remove_channel_member', { p_channel: f.general, p_user: f.bob }), 'suspended');
  await expectError(db.call(f.eve, 'remove_channel_member', { p_channel: f.grants, p_user: f.carol }), 'not_found');
  await expectError(db.call(f.stranger, 'remove_channel_member', { p_channel: f.grants, p_user: f.carol }), 'not_found');
}));

test('list_channel_members: readers (and server moderators of team channels); owners first; DMs stay private', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await db.call(f.carol, 'list_channel_members', { p_channel: f.grants });
  assert.equal(r.total, 3);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['joined_at', 'profile', 'role']);
  assert.deepEqual(r.items.map((i) => [i.profile.display_name, i.role]),
    [['Alice', 'owner'], ['Carol', 'member'], ['Guest', 'member']]);
  assert.deepEqual((await db.call(f.alice, 'list_channel_members', { p_channel: f.grants, p_query: 'gue' }))
    .items.map((i) => i.profile.id), [f.guest]);
  assert.deepEqual((await db.call(f.alice, 'list_channel_members', { p_channel: f.grants, p_limit: 1, p_offset: 2 }))
    .items.map((i) => i.profile.id), [f.guest]);
  assert.equal((await db.call(f.owner, 'list_channel_members', { p_channel: f.grants })).total, 3,
    'a server admin may see who is in a private channel of the server');
  assert.equal((await db.call(f.alice, 'list_channel_members', { p_channel: f.general })).total, 4,
    'suspended members are left out');
  assert.equal((await db.call(f.alice, 'list_channel_members', { p_channel: f.dmAliceBob })).total, 2);
  await expectError(db.call(f.admin, 'list_channel_members', { p_channel: f.dmAliceBob }), 'not_found');
  await expectError(db.call(f.bob, 'list_channel_members', { p_channel: f.grants }), 'not_found');
  await expectError(db.call(f.suspended, 'list_channel_members', { p_channel: f.general }), 'suspended');
  await expectError(db.call(f.eve, 'list_channel_members', { p_channel: f.grants }), 'not_found');
  await expectError(db.call(f.stranger, 'list_channel_members', { p_channel: f.grants }), 'not_found');
}));

test('set_channel_notify: per member level and mute; members only', () => tx(async (db) => {
  const f = await db.fixture();
  const until = new Date(Date.now() + 3600 * 1000).toISOString();
  const r = await db.call(f.carol, 'set_channel_notify', { p_channel: f.grants, p_level: 'mentions', p_muted_until: until });
  assert.equal(r.channel_id, f.grants);
  assert.equal(r.notify, 'mentions');
  assert.equal(new Date(r.muted_until).getTime(), new Date(until).getTime());
  const row = await channelRow(db, f.grants, f.carol);
  assert.equal(row.notify, 'mentions');
  const past = await db.call(f.carol, 'set_channel_notify', {
    p_channel: f.grants, p_level: 'all', p_muted_until: '2020-01-01T00:00:00Z' });
  assert.equal(past.muted_until, null);
  assert.equal((await db.call(f.bob, 'set_channel_notify', { p_channel: f.dmAliceBob, p_level: 'none' })).notify, 'none');
  await expectError(db.call(f.carol, 'set_channel_notify', { p_channel: f.grants, p_level: 'loud' }), 'invalid_input');
  const random = await db.channel(f.medical, 'random');
  await expectError(db.call(f.bob, 'set_channel_notify', { p_channel: random, p_level: 'all' }), 'forbidden');
  await expectError(db.call(f.bob, 'set_channel_notify', { p_channel: f.grants, p_level: 'all' }), 'not_found');
  await expectError(db.call(f.suspended, 'set_channel_notify', { p_channel: f.general, p_level: 'all' }), 'suspended');
  await expectError(db.call(f.eve, 'set_channel_notify', { p_channel: f.grants, p_level: 'all' }), 'not_found');
  await expectError(db.call(f.stranger, 'set_channel_notify', { p_channel: f.grants, p_level: 'all' }), 'not_found');
}));
