// [org] team servers: listing, creating, updating, archiving, joining, leaving, members.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { mark, since, setSettings, canRead, serverRole, channelRow, auditRows, sorted } from './org-lib.mjs';

// 'access' added by 0900 (member | partial | browse)
const SERVER_KEYS = ['access', 'archived', 'description', 'icon_emoji', 'id', 'join_policy', 'member_count', 'my_role', 'name',
  'org_id', 'position', 'requested'];

const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('list_servers: member, partial and browsable servers; org admins see all; never another org', () => tx(async (db) => {
  const f = await db.fixture();
  const open = await db.server(f.org, 'Open Team', { joinPolicy: 'open', admins: [f.owner] });
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  const archivedOpen = await db.server(f.org, 'Old Open', { joinPolicy: 'open' });
  await db.q('update dek.servers set archived_at = now() where id = $1', [archivedOpen]);

  const alice = byId(await db.call(f.alice, 'list_servers', { p_org: f.org }));
  assert.deepEqual(sorted(Object.keys(alice)), sorted([f.medical, f.tech, open, approval]));
  assert.deepEqual(Object.keys(alice[f.medical]).sort(), SERVER_KEYS);
  assert.equal(alice[f.medical].my_role, 'member');
  assert.equal(alice[f.medical].member_count, 5);
  assert.equal(alice[open].my_role, null, 'browsable, not joined');

  const carol = byId(await db.call(f.carol, 'list_servers', { p_org: f.org }));
  assert.deepEqual(sorted(Object.keys(carol)), sorted([f.medical, f.tech, open, approval]));
  assert.equal(carol[f.tech].my_role, 'member');
  assert.equal(carol[f.medical].my_role, null, 'partial: reached only through Grants (DEK02)');

  const guest = await db.call(f.guest, 'list_servers', { p_org: f.org });
  assert.deepEqual(guest.map((s) => [s.id, s.my_role]), [[f.medical, null]], 'guests never browse');

  const admin = byId(await db.call(f.admin, 'list_servers', { p_org: f.org }));
  assert.deepEqual(sorted(Object.keys(admin)), sorted([f.medical, f.tech, open, approval, archivedOpen]));
  assert.equal(admin[archivedOpen].archived, true);

  const eve = await db.call(f.eve, 'list_servers', { p_org: f.otherOrg });
  assert.deepEqual(eve.map((s) => s.id), [f.otherServer]);
  await expectError(db.call(f.eve, 'list_servers', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_servers', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'list_servers', { p_org: f.org }), 'suspended');
}));

test('create_server: creator is server admin and owns a public auto_join #general', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const s = await db.call(f.alice, 'create_server', {
    p_org: f.org, p_name: ' Design ', p_description: 'Line one\nLine two', p_join_policy: 'open', p_icon_emoji: '🎨' });
  assert.deepEqual(Object.keys(s).sort(), SERVER_KEYS);
  assert.equal(s.name, 'Design');
  assert.equal(s.description, 'Line one\nLine two');
  assert.equal(s.join_policy, 'open');
  assert.equal(s.my_role, 'admin');
  assert.equal(s.member_count, 1);
  assert.equal(s.archived, false);
  const general = await db.one('select * from dek.channels where server_id = $1', [s.id]);
  assert.equal(general.name, 'general');
  assert.equal(general.visibility, 'public');
  assert.equal(general.auto_join, true);
  assert.equal((await channelRow(db, general.id, f.alice)).role, 'owner');
  const mu = await since(db, before, { event: 'member.upd' });
  assert.deepEqual(sorted(mu.map((e) => e.topic)), sorted([`u:${f.alice}`, `s:${s.id}`]));
  assert.ok(mu.every((e) => e.payload.scope === 'server' && e.payload.change === 'added' && e.payload.user_id === f.alice));
  const cu = await since(db, before, { event: 'chan.upd' });
  assert.deepEqual(cu.map((e) => [e.topic, e.payload.channel.id, e.payload.channel.name]),
    [[`s:${s.id}`, general.id, 'general']]);
  assert.equal(cu[0].payload.channel.member, undefined, 'events carry only the public channel fields');
  assert.equal((await auditRows(db, f.org, 'server.created')).length, 1);

  await expectError(db.call(f.bob, 'create_server', { p_org: f.org, p_name: 'DESIGN' }), 'conflict');
  await expectError(db.call(f.bob, 'create_server', { p_org: f.org, p_name: '' }), 'invalid_input');
  await expectError(db.call(f.bob, 'create_server', { p_org: f.org, p_name: 'X', p_join_policy: 'closed' }), 'invalid_input');
  await expectError(db.call(f.bob, 'create_server', { p_org: f.org, p_name: 'Two\nLines' }), 'invalid_input');
  await expectError(db.call(f.guest, 'create_server', { p_org: f.org, p_name: 'Guest Team' }), 'forbidden');
  await expectError(db.call(f.suspended, 'create_server', { p_org: f.org, p_name: 'S Team' }), 'suspended');
  await expectError(db.call(f.eve, 'create_server', { p_org: f.org, p_name: 'Eve Team' }), 'not_found');
  await expectError(db.call(f.stranger, 'create_server', { p_org: f.org, p_name: 'Str Team' }), 'not_found');
  await setSettings(db, f.org, { member_can_create_channels: false });
  await expectError(db.call(f.bob, 'create_server', { p_org: f.org, p_name: 'Bob Team' }), 'forbidden');
  assert.equal((await db.call(f.admin, 'create_server', { p_org: f.org, p_name: 'Admin Team' })).position, 2);
}));

test('update_server: server and org admins only; validated patch; unique names', () => tx(async (db) => {
  const f = await db.fixture();
  const s = await db.call(f.owner, 'update_server', { p_server: f.medical, p_patch: {
    name: 'Medical', description: 'Partnerships with hospitals', icon_emoji: '🏥', join_policy: 'approval', position: 5 } });
  assert.equal(s.name, 'Medical');
  assert.equal(s.description, 'Partnerships with hospitals');
  assert.equal(s.icon_emoji, '🏥');
  assert.equal(s.join_policy, 'approval');
  assert.equal(s.position, 5);
  assert.equal(s.my_role, 'admin');
  // the org admin is a plain server member but administers every server of the org
  assert.equal((await db.call(f.admin, 'update_server', { p_server: f.medical, p_patch: { description: null } })).description, null);
  assert.equal((await auditRows(db, f.org, 'server.updated')).length, 2);

  await expectError(db.call(f.owner, 'update_server', { p_server: f.medical, p_patch: { name: 'tech' } }), 'conflict');
  for (const p of [{ archived: true }, { join_policy: 'closed' }, { position: 'first' }, { name: '' }, { icon_emoji: 7 }]) {
    await expectError(db.call(f.owner, 'update_server', { p_server: f.medical, p_patch: p }), 'invalid_input');
  }
  await expectError(db.call(f.alice, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'forbidden');
  await expectError(db.call(f.carol, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'forbidden');
  await expectError(db.call(f.guest, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'forbidden');
  await expectError(db.call(f.alice, 'update_server', { p_server: f.tech, p_patch: { name: 'A' } }), 'forbidden');
  await expectError(db.call(f.suspended, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'suspended');
  await expectError(db.call(f.eve, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'not_found');
  await expectError(db.call(f.stranger, 'update_server', { p_server: f.medical, p_patch: { name: 'A' } }), 'not_found');
}));

test('archive_server: read only while archived, reversible, admins only', () => tx(async (db) => {
  const f = await db.fixture();
  assert.equal((await db.call(f.owner, 'archive_server', { p_server: f.medical, p_archived: true })).archived, true);
  await expectError(db.safe('select dek.assert_post($1, $2)', [f.alice, f.general]), 'archived');
  await expectError(db.call(f.owner, 'update_server', { p_server: f.medical, p_patch: { name: 'X' } }), 'archived');
  await expectError(db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [f.carol] }), 'archived');
  await expectError(db.call(f.owner, 'create_channel', { p_server: f.medical, p_name: 'new' }), 'archived');
  assert.equal(await canRead(db, f.alice, f.general), true, 'history stays readable');
  // archiving twice is a no-op
  assert.equal((await db.call(f.admin, 'archive_server', { p_server: f.medical, p_archived: true })).archived, true);
  // a live server took the name meanwhile: unarchive refuses
  const clash = await db.call(f.admin, 'create_server', { p_org: f.org, p_name: 'Medical Partnerships' });
  await expectError(db.call(f.owner, 'archive_server', { p_server: f.medical, p_archived: false }), 'conflict');
  await db.call(f.admin, 'update_server', { p_server: clash.id, p_patch: { name: 'Medical 2' } });
  assert.equal((await db.call(f.owner, 'archive_server', { p_server: f.medical, p_archived: false })).archived, false);
  await db.safe('select dek.assert_post($1, $2)', [f.alice, f.general]);
  assert.deepEqual((await db.q(
    "select action from dek.audit_log where org_id = $1 and action like 'server.%archived' order by id", [f.org]))
    .map((r) => r.action), ['server.archived', 'server.unarchived']);

  await expectError(db.call(f.owner, 'archive_server', { p_server: f.medical, p_archived: null }), 'invalid_input');
  await expectError(db.call(f.alice, 'archive_server', { p_server: f.medical, p_archived: true }), 'forbidden');
  await expectError(db.call(f.guest, 'archive_server', { p_server: f.medical, p_archived: true }), 'forbidden');
  await expectError(db.call(f.suspended, 'archive_server', { p_server: f.medical, p_archived: true }), 'suspended');
  await expectError(db.call(f.eve, 'archive_server', { p_server: f.medical, p_archived: true }), 'not_found');
}));

test('join_server: open joins (with auto_join channels), approval files a request, invite refuses', () => tx(async (db) => {
  const f = await db.fixture();
  const open = await db.call(f.admin, 'create_server', { p_org: f.org, p_name: 'Open', p_join_policy: 'open' });
  const openGeneral = (await db.one('select id from dek.channels where server_id = $1', [open.id])).id;
  const before = await mark(db);
  assert.deepEqual(await db.call(f.alice, 'join_server', { p_server: open.id }), { status: 'joined' });
  assert.equal(await serverRole(db, open.id, f.alice), 'member');
  assert.equal((await channelRow(db, openGeneral, f.alice)).role, 'member', 'auto_join channel joined');
  const ev = await since(db, before, { event: 'member.upd' });
  assert.deepEqual(sorted(ev.map((e) => `${e.topic}|${e.payload.scope}`)),
    sorted([`u:${f.alice}|server`, `s:${open.id}|server`, `u:${f.alice}|channel`]));
  assert.deepEqual(await db.call(f.alice, 'join_server', { p_server: open.id }), { status: 'joined' });

  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  assert.deepEqual(await db.call(f.bob, 'join_server', { p_server: approval }), { status: 'pending' });
  assert.deepEqual(await db.call(f.bob, 'join_server', { p_server: approval }), { status: 'pending' });
  const reqs = await db.q('select status from dek.join_requests where server_id = $1 and user_id = $2', [approval, f.bob]);
  assert.deepEqual(reqs, [{ status: 'pending' }]);
  assert.equal(await serverRole(db, approval, f.bob), null);

  // Invite-only metadata is discoverable, but joining still requires an invitation.
  // Carol's partial channel membership also cannot join; org admins may join, audited.
  await expectError(db.call(f.alice, 'join_server', { p_server: f.tech }), 'forbidden');
  await expectError(db.call(f.carol, 'join_server', { p_server: f.medical }), 'forbidden');
  assert.deepEqual(await db.call(f.admin, 'join_server', { p_server: f.tech }), { status: 'joined' }, 'org admins may join');
  assert.deepEqual((await auditRows(db, f.org, 'server.admin_joined')).map((a) => [a.actor_id, a.target_id]),
    [[f.admin, f.tech]]);
  // guests never join: invisible servers are not_found, a server they reach through a channel is forbidden
  await expectError(db.call(f.guest, 'join_server', { p_server: open.id }), 'not_found');
  await expectError(db.call(f.guest, 'join_server', { p_server: f.medical }), 'forbidden');
  // archived: not browsable for members (not_found); an org admin, who sees it, is told it is archived
  await db.q('update dek.servers set archived_at = now() where id = $1', [approval]);
  await expectError(db.call(f.carol, 'join_server', { p_server: approval }), 'not_found');
  await expectError(db.call(f.owner, 'join_server', { p_server: approval }), 'archived');
  await expectError(db.call(f.suspended, 'join_server', { p_server: open.id }), 'suspended');
  await expectError(db.call(f.eve, 'join_server', { p_server: open.id }), 'not_found');
  await expectError(db.call(f.stranger, 'join_server', { p_server: open.id }), 'not_found');
}));

test('leave_server: the server and every channel in it go at once (DEKA06); cross-team leave per channel', () => tx(async (db) => {
  const f = await db.fixture();
  await db.channelMember(f.secret, f.bob);
  assert.equal(await canRead(db, f.bob, f.general), true);
  const before = await mark(db);
  assert.deepEqual(await db.call(f.bob, 'leave_server', { p_server: f.medical }), { server_id: f.medical, left: true });
  assert.equal(await serverRole(db, f.medical, f.bob), null);
  assert.equal(await canRead(db, f.bob, f.general), false, 'public channel gone');
  assert.equal(await canRead(db, f.bob, f.secret), false, 'private channel in that server gone');
  assert.equal(await channelRow(db, f.secret, f.bob), undefined);
  const revoked = await since(db, before, { event: 'access.revoked', topic: `u:${f.bob}` });
  assert.equal(revoked[0].payload.scope, 'server');
  const removed = await since(db, before, { event: 'member.upd', topic: `s:${f.medical}` });
  assert.equal(removed[0].payload.change, 'removed');
  assert.equal((await db.call(f.bob, 'list_servers', { p_org: f.org })).find((s) => s.id === f.medical).access, 'browse');
  assert.deepEqual(await db.call(f.bob, 'list_channels', { p_server: f.medical }), []);
  assert.deepEqual(await db.call(f.bob, 'leave_server', { p_server: f.medical }), { server_id: f.medical, left: true });

  // cross-team: Carol only holds Grants in Medical
  const b2 = await mark(db);
  await db.call(f.carol, 'leave_server', { p_server: f.medical });
  assert.equal(await canRead(db, f.carol, f.grants), false);
  const cr = await since(db, b2, { event: 'access.revoked', topic: `u:${f.carol}` });
  assert.equal(cr[0].payload.scope, 'channel');
  assert.equal(await serverRole(db, f.tech, f.carol), 'member', 'her own server is untouched');

  // a pending request to join is withdrawn by leaving
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  await db.call(f.alice, 'join_server', { p_server: approval });
  await db.call(f.alice, 'leave_server', { p_server: approval });
  assert.equal((await db.one('select status from dek.join_requests where server_id = $1', [approval])).status, 'withdrawn');

  await expectError(db.call(f.suspended, 'leave_server', { p_server: f.medical }), 'suspended');
  await expectError(db.call(f.eve, 'leave_server', { p_server: f.medical }), 'not_found');
  await expectError(db.call(f.stranger, 'leave_server', { p_server: f.medical }), 'not_found');
}));

test('list_server_members: admins first, active members only, guests refused', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await db.call(f.alice, 'list_server_members', { p_server: f.medical });
  assert.equal(r.total, 4, 'the suspended member is left out');
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['joined_at', 'profile', 'role']);
  assert.deepEqual(r.items.map((i) => [i.profile.display_name, i.role]),
    [['Owner', 'admin'], ['Admin', 'member'], ['Alice', 'member'], ['Bob', 'member']]);
  const q = await db.call(f.alice, 'list_server_members', { p_server: f.medical, p_query: 'bo' });
  assert.deepEqual(q.items.map((i) => i.profile.id), [f.bob]);
  const page = await db.call(f.alice, 'list_server_members', { p_server: f.medical, p_limit: 1, p_offset: 1 });
  assert.deepEqual(page.items.map((i) => i.profile.id), [f.admin]);
  assert.equal(page.total, 4);
  // people who reach Medical only through a channel, or only browse a server, see no roster (DEK02)
  await expectError(db.call(f.carol, 'list_server_members', { p_server: f.medical }), 'forbidden');
  await expectError(db.call(f.guest, 'list_server_members', { p_server: f.medical }), 'forbidden');
  const open = await db.server(f.org, 'Open Team', { joinPolicy: 'open', members: [f.bob] });
  await expectError(db.call(f.alice, 'list_server_members', { p_server: open }), 'forbidden');
  assert.equal((await db.call(f.admin, 'list_server_members', { p_server: f.tech })).total, 1,
    'org admins see the roster of any server');
  await expectError(db.call(f.alice, 'list_server_members', { p_server: f.tech }), 'forbidden');
  await expectError(db.call(f.suspended, 'list_server_members', { p_server: f.medical }), 'suspended');
  await expectError(db.call(f.eve, 'list_server_members', { p_server: f.medical }), 'not_found');
  await expectError(db.call(f.stranger, 'list_server_members', { p_server: f.medical }), 'not_found');
}));

test('add_server_members: server admins add active non-guest members, who auto-join auto_join channels', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q('update dek.channels set auto_join = true where id = $1', [f.general]);
  // a private channel flagged auto_join (legacy data) must never absorb new server members
  await db.q('update dek.channels set auto_join = true where id = $1', [f.secret]);
  const before = await mark(db);
  const r = await db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [f.carol, f.alice, f.carol] });
  assert.deepEqual(r, { server_id: f.medical, added: [f.carol], already_members: [f.alice] });
  assert.equal(await serverRole(db, f.medical, f.carol), 'member');
  assert.equal(await canRead(db, f.carol, f.general), true);
  assert.ok(await channelRow(db, f.general, f.carol), 'auto_join channel joined');
  assert.equal(await channelRow(db, f.secret, f.carol), undefined, 'private auto_join channel not joined');
  assert.equal(await canRead(db, f.carol, f.secret), false);
  const ev = await since(db, before, { event: 'member.upd' });
  assert.deepEqual(sorted(ev.map((e) => `${e.topic}|${e.payload.scope}|${e.payload.user_id === f.carol}`)),
    sorted([`u:${f.carol}|server|true`, `s:${f.medical}|server|true`, `u:${f.carol}|channel|true`]));
  assert.equal((await auditRows(db, f.org, 'server.members_added')).length, 1);

  const mod = await db.user('Mod');
  await db.member(f.org, mod);
  await db.call(f.admin, 'add_server_members', { p_server: f.medical, p_user_ids: [mod], p_role: 'moderator' });
  assert.equal(await serverRole(db, f.medical, mod), 'moderator');

  await expectError(db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [f.guest] }), 'invalid_input');
  await expectError(db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [f.eve] }), 'invalid_input');
  await expectError(db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [f.suspended] }), 'invalid_input');
  await expectError(db.call(f.owner, 'add_server_members', { p_server: f.medical, p_user_ids: [] }), 'invalid_input');
  await expectError(db.call(f.owner, 'add_server_members', {
    p_server: f.medical, p_user_ids: [f.bob], p_role: 'owner' }), 'invalid_input');
  await expectError(db.call(f.alice, 'add_server_members', { p_server: f.medical, p_user_ids: [f.bob] }), 'forbidden');
  await expectError(db.call(mod, 'add_server_members', { p_server: f.medical, p_user_ids: [f.bob] }), 'forbidden');
  await expectError(db.call(f.guest, 'add_server_members', { p_server: f.medical, p_user_ids: [f.bob] }), 'forbidden');
  await expectError(db.call(f.suspended, 'add_server_members', { p_server: f.medical, p_user_ids: [f.bob] }), 'suspended');
  await expectError(db.call(f.eve, 'add_server_members', { p_server: f.medical, p_user_ids: [f.eve] }), 'not_found');
  await expectError(db.call(f.stranger, 'add_server_members', { p_server: f.medical, p_user_ids: [f.bob] }), 'not_found');
}));

test('remove_server_member: moderators remove members but never admins; cross-team removal per channel', () => tx(async (db) => {
  const f = await db.fixture();
  const mod = await db.user('Mod');
  await db.member(f.org, mod);
  await db.serverMember(f.medical, mod, 'moderator');
  const before = await mark(db);
  assert.deepEqual(await db.call(mod, 'remove_server_member', { p_server: f.medical, p_user: f.alice }),
    { server_id: f.medical, user_id: f.alice, removed: true });
  assert.equal(await serverRole(db, f.medical, f.alice), null);
  assert.equal(await canRead(db, f.alice, f.general), false);
  assert.equal(await canRead(db, f.alice, f.grants), false, 'her private channel in that server goes too');
  const ev = await since(db, before, { event: 'access.revoked', topic: `u:${f.alice}` });
  assert.equal(ev[0].payload.scope, 'server');
  assert.equal((await auditRows(db, f.org, 'server.member_removed')).length, 1);

  await expectError(db.call(mod, 'remove_server_member', { p_server: f.medical, p_user: f.owner }), 'forbidden');
  await expectError(db.call(mod, 'remove_server_member', { p_server: f.medical, p_user: f.admin }), 'forbidden');
  // nor strip an org admin's channels in a server the admin only reaches through a channel
  const techMod = await db.user('Tech Mod');
  await db.member(f.org, techMod);
  await db.serverMember(f.tech, techMod, 'moderator');
  await db.channelMember(f.techGeneral, f.admin);
  await expectError(db.call(techMod, 'remove_server_member', { p_server: f.tech, p_user: f.admin }), 'forbidden');
  assert.ok(await channelRow(db, f.techGeneral, f.admin));
  // cross-team: Carol is only in Grants
  await db.call(f.owner, 'remove_server_member', { p_server: f.medical, p_user: f.carol });
  assert.equal(await canRead(db, f.carol, f.grants), false);
  await expectError(db.call(f.owner, 'remove_server_member', { p_server: f.medical, p_user: f.carol }), 'not_found');
  await expectError(db.call(f.owner, 'remove_server_member', { p_server: f.medical, p_user: f.eve }), 'not_found');
  await db.call(f.owner, 'remove_server_member', { p_server: f.medical, p_user: mod });
  await expectError(db.call(f.bob, 'remove_server_member', { p_server: f.medical, p_user: f.admin }), 'forbidden');
  await expectError(db.call(f.guest, 'remove_server_member', { p_server: f.medical, p_user: f.bob }), 'forbidden');
  await expectError(db.call(f.suspended, 'remove_server_member', { p_server: f.medical, p_user: f.bob }), 'suspended');
  await expectError(db.call(f.eve, 'remove_server_member', { p_server: f.medical, p_user: f.bob }), 'not_found');
  await expectError(db.call(f.stranger, 'remove_server_member', { p_server: f.medical, p_user: f.bob }), 'not_found');
}));

test('set_server_role: server admins change roles; member.upd on the user and the server topic', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const r = await db.call(f.owner, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'moderator' });
  assert.equal(r.role, 'moderator');
  assert.equal(r.profile.id, f.alice);
  const ev = await since(db, before, { event: 'member.upd' });
  assert.deepEqual(sorted(ev.map((e) => e.topic)), sorted([`u:${f.alice}`, `s:${f.medical}`]));
  assert.ok(ev.every((e) => e.payload.change === 'role' && e.payload.scope === 'server'));
  assert.equal((await auditRows(db, f.org, 'server.role_changed'))[0].details.to, 'moderator');
  // the same role again: no event
  const b2 = await mark(db);
  await db.call(f.admin, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'moderator' });
  assert.equal((await since(db, b2)).length, 0);
  assert.equal((await db.call(f.admin, 'set_server_role', { p_server: f.medical, p_user: f.bob, p_role: 'admin' })).role, 'admin');
  // a server admin who is a plain org member can now manage roles too
  assert.equal((await db.call(f.bob, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'member' })).role,
    'member');

  await expectError(db.call(f.owner, 'set_server_role', { p_server: f.medical, p_user: f.carol, p_role: 'admin' }), 'not_found');
  await expectError(db.call(f.owner, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'owner' }), 'invalid_input');
  await expectError(db.call(f.alice, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'admin' }), 'forbidden');
  await expectError(db.call(f.guest, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'admin' }), 'forbidden');
  await expectError(db.call(f.suspended, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'admin' }), 'suspended');
  await expectError(db.call(f.eve, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'admin' }), 'not_found');
}));
