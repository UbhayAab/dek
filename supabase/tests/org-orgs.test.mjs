// [org] organizations: create, update, members, roles, suspension, removal, leaving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import {
  events, mark, since, platformAdmin, setSettings, canRead, orgMember, serverRole, auditRows,
} from './org-lib.mjs';

const ORG_SUMMARY_KEYS = ['brand_color', 'id', 'logo_path', 'mention_count', 'my_role', 'name', 'short_name',
  'slug', 'unread_channels'];

test('create_org: platform admins only, caller becomes owner, slug lowercased and unique', () => tx(async (db) => {
  const f = await db.fixture();
  const pa = await db.user('Platform Admin');
  await platformAdmin(db, pa);
  const slug = `New-Org-${randomUUID().slice(0, 8)}`;
  const o = await db.call(pa, 'create_org', {
    p_name: '  New Org  ', p_slug: slug, p_short_name: 'NO', p_brand_color: '#123ABC' });
  assert.deepEqual(Object.keys(o).sort(), ORG_SUMMARY_KEYS);
  assert.equal(o.slug, slug.toLowerCase());
  assert.equal(o.name, 'New Org');
  assert.equal(o.short_name, 'NO');
  assert.equal(o.brand_color, '#123ABC');
  assert.equal(o.my_role, 'owner');
  assert.deepEqual(await orgMember(db, o.id, pa), { role: 'owner', status: 'active', suspended_reason: null });
  assert.equal((await auditRows(db, o.id, 'org.created')).length, 1);
  const ev = await events(db, { event: 'member.upd', topic: `u:${pa}` });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.scope, 'org');
  assert.equal(ev[0].payload.change, 'added');

  // default colour, duplicate slug in any case, bad input
  const o2 = await db.call(pa, 'create_org', { p_name: 'Second', p_slug: `second-${randomUUID().slice(0, 8)}` });
  assert.equal(o2.brand_color, '#4F46E5');
  await expectError(db.call(pa, 'create_org', { p_name: 'Dup', p_slug: slug.toUpperCase() }), 'conflict');
  await expectError(db.call(pa, 'create_org', { p_name: 'Bad', p_slug: '-bad' }), 'invalid_input');
  await expectError(db.call(pa, 'create_org', { p_name: 'Bad', p_slug: 'x' }), 'invalid_input');
  await expectError(db.call(pa, 'create_org', { p_name: '   ', p_slug: `ok-${randomUUID().slice(0, 8)}` }),
    'invalid_input');
  await expectError(db.call(pa, 'create_org', {
    p_name: 'Colour', p_slug: `ok-${randomUUID().slice(0, 8)}`, p_brand_color: 'red' }), 'invalid_input');

  // nobody else, whatever their role anywhere
  for (const u of [f.owner, f.admin, f.alice, f.guest, f.suspended, f.eve, f.stranger]) {
    await expectError(db.call(u, 'create_org', { p_name: 'Nope', p_slug: `nope-${u.slice(0, 8)}` }), 'forbidden');
  }
  await expectError(db.call(null, 'create_org', { p_name: 'Anon', p_slug: 'anon-org' }));
}));

test('update_org: org admins patch name, colour, logo and partial settings; strict validation', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await db.call(f.admin, 'update_org', { p_org: f.org, p_patch: {
    name: 'JCF Renamed', short_name: 'JCF', brand_color: '#00AA88', logo_path: `${f.admin}/logo.webp`,
    settings: { member_can_invite: true, default_invite_hours: 48, edit_window_minutes: null } } });
  assert.equal(r.name, 'JCF Renamed');
  assert.equal(r.short_name, 'JCF');
  assert.equal(r.brand_color, '#00AA88');
  assert.equal(r.logo_path, `${f.admin}/logo.webp`);
  assert.equal(r.my_role, 'admin');
  assert.deepEqual(r.settings, {
    edit_window_minutes: null, allow_guests: true, member_can_create_channels: true,
    member_can_invite: true, default_invite_hours: 48 });
  // a later partial patch keeps the earlier keys
  const r2 = await db.call(f.owner, 'update_org', { p_org: f.org, p_patch: { settings: { allow_guests: false } } });
  assert.equal(r2.settings.member_can_invite, true);
  assert.equal(r2.settings.allow_guests, false);
  assert.equal(r2.name, 'JCF Renamed');
  // short_name can be cleared
  assert.equal((await db.call(f.owner, 'update_org', { p_org: f.org, p_patch: { short_name: null } })).short_name, null);
  assert.equal((await auditRows(db, f.org, 'org.updated')).length, 3);

  const bad = [
    { slug: 'x' }, { name: '' }, { name: 42 }, { brand_color: 'blue' }, { logo_path: '../../etc/passwd' },
    { settings: { unknown: true } }, { settings: { allow_guests: 'yes' } }, { settings: { default_invite_hours: 721 } },
    { settings: { default_invite_hours: 1.5 } }, { settings: { edit_window_minutes: -1 } }, { settings: 'x' },
  ];
  for (const p of bad) {
    await expectError(db.call(f.admin, 'update_org', { p_org: f.org, p_patch: p }), 'invalid_input');
  }
  await expectError(db.call(f.admin, 'update_org', { p_org: f.org, p_patch: null }), 'invalid_input');
  await expectError(db.call(f.alice, 'update_org', { p_org: f.org, p_patch: { name: 'X' } }), 'forbidden');
  await expectError(db.call(f.guest, 'update_org', { p_org: f.org, p_patch: { name: 'X' } }), 'forbidden');
  await expectError(db.call(f.suspended, 'update_org', { p_org: f.org, p_patch: { name: 'X' } }), 'suspended');
  await expectError(db.call(f.eve, 'update_org', { p_org: f.org, p_patch: { name: 'X' } }), 'not_found');
  await expectError(db.call(f.stranger, 'update_org', { p_org: f.org, p_patch: { name: 'X' } }), 'not_found');
  assert.equal((await db.one('select name from dek.orgs where id = $1', [f.org])).name, 'JCF Renamed');
}));

test('list_org_members: members see active people, admins also suspended; search, role filter, paging', () => tx(async (db) => {
  const f = await db.fixture();
  const all = await db.call(f.alice, 'list_org_members', { p_org: f.org });
  assert.equal(all.total, 6, 'the suspended member is hidden from members');
  assert.ok(all.items.every((i) => i.status === 'active'));
  assert.deepEqual(Object.keys(all.items[0]).sort(), ['joined_at', 'profile', 'role', 'status']);
  assert.deepEqual(all.items.map((i) => i.profile.display_name),
    ['Admin', 'Alice', 'Bob', 'Carol', 'Guest', 'Owner'], 'ordered by name');
  const adm = await db.call(f.admin, 'list_org_members', { p_org: f.org });
  assert.equal(adm.total, 7);
  assert.equal(adm.items.find((i) => i.profile.id === f.suspended).status, 'suspended');
  const q = await db.call(f.guest, 'list_org_members', { p_org: f.org, p_query: 'ALI' });
  assert.deepEqual(q.items.map((i) => i.profile.id), [f.alice]);
  const wild = await db.call(f.alice, 'list_org_members', { p_org: f.org, p_query: '%' });
  assert.equal(wild.total, 0, 'wildcards in the query are literal');
  const guests = await db.call(f.alice, 'list_org_members', { p_org: f.org, p_role: 'guest' });
  assert.deepEqual(guests.items.map((i) => [i.profile.id, i.role]), [[f.guest, 'guest']]);
  const p1 = await db.call(f.alice, 'list_org_members', { p_org: f.org, p_limit: 2 });
  const p2 = await db.call(f.alice, 'list_org_members', { p_org: f.org, p_limit: 2, p_offset: 2 });
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 6);
  assert.deepEqual(p2.items.map((i) => i.profile.display_name), ['Bob', 'Carol']);
  const capped = await db.call(f.alice, 'list_org_members', { p_org: f.org, p_limit: 100000 });
  assert.equal(capped.items.length, 6);
  await expectError(db.call(f.alice, 'list_org_members', { p_org: f.org, p_role: 'king' }), 'invalid_input');
  await expectError(db.call(f.suspended, 'list_org_members', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'list_org_members', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_org_members', { p_org: f.org }), 'not_found');
}));

test('set_org_role: owners set any role, admins only member and guest, the last owner stays', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const r = await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'admin' });
  assert.equal(r.role, 'admin');
  assert.equal(r.profile.id, f.alice);
  const ev = await since(db, before, { event: 'member.upd', topic: `u:${f.alice}` });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.scope, 'org');
  assert.equal(ev[0].payload.user_id, f.alice);
  assert.equal(ev[0].payload.change, 'role');
  assert.equal((await auditRows(db, f.org, 'org.role_changed'))[0].details.to, 'admin');

  // admins: member and guest only, never on admins or owners
  await expectError(db.call(f.admin, 'set_org_role', { p_org: f.org, p_user: f.bob, p_role: 'admin' }), 'forbidden');
  await expectError(db.call(f.admin, 'set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'member' }), 'forbidden');
  await expectError(db.call(f.admin, 'set_org_role', { p_org: f.org, p_user: f.owner, p_role: 'member' }), 'forbidden');
  // plain members, guests, suspended, other tenant
  await expectError(db.call(f.bob, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'guest' }), 'forbidden');
  await expectError(db.call(f.guest, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'guest' }), 'forbidden');
  await expectError(db.call(f.suspended, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'guest' }), 'suspended');
  await expectError(db.call(f.eve, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'guest' }), 'not_found');
  await expectError(db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.eve, p_role: 'member' }), 'not_found');
  await expectError(db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.bob, p_role: 'king' }), 'invalid_input');

  // becoming a guest drops server memberships and the channels inside them (DEK02)
  assert.equal(await canRead(db, f.bob, f.general), true);
  const b2 = await mark(db);
  assert.equal((await db.call(f.admin, 'set_org_role', { p_org: f.org, p_user: f.bob, p_role: 'guest' })).role, 'guest');
  assert.equal(await serverRole(db, f.medical, f.bob), null);
  assert.equal(await canRead(db, f.bob, f.general), false);
  assert.equal(await canRead(db, f.bob, f.dmAliceBob), true, 'DMs stay');
  const revoked = await since(db, b2, { event: 'access.revoked', topic: `u:${f.bob}` });
  assert.ok(revoked.some((e) => e.payload.scope === 'server'));
  assert.equal((await db.call(f.admin, 'set_org_role', { p_org: f.org, p_user: f.bob, p_role: 'member' })).role, 'member');

  // guests can be turned off
  await setSettings(db, f.org, { allow_guests: false });
  await expectError(db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'guest' }), 'forbidden');

  // the last owner cannot be demoted, not even by themselves; with a second owner it works
  await expectError(db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.owner, p_role: 'admin' }), 'conflict');
  await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'owner' });
  assert.equal((await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.owner, p_role: 'admin' })).role, 'admin');
  await expectError(db.call(f.alice, 'set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'member' }), 'conflict');
  // setting the same role again is a no-op
  assert.equal((await db.call(f.alice, 'set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'member' })).role, 'member');
}));

test('suspend_org_member: access stops at once, reason kept, restore works, ranks respected', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  const r = await db.call(f.admin, 'suspend_org_member', {
    p_org: f.org, p_user: f.bob, p_suspended: true, p_reason: 'Spamming the channel' });
  assert.equal(r.status, 'suspended');
  assert.deepEqual(await orgMember(db, f.org, f.bob),
    { role: 'member', status: 'suspended', suspended_reason: 'Spamming the channel' });
  const ev = await since(db, before, { event: 'access.revoked', topic: `u:${f.bob}` });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.scope, 'org');
  assert.equal(await canRead(db, f.bob, f.general), false);
  await expectError(db.call(f.bob, 'list_servers', { p_org: f.org }), 'suspended');
  assert.equal((await auditRows(db, f.org, 'org.member_suspended'))[0].details.reason, 'Spamming the channel');
  // repeating it changes nothing and emits nothing
  const again = await mark(db);
  await db.call(f.admin, 'suspend_org_member', {
    p_org: f.org, p_user: f.bob, p_suspended: true, p_reason: 'Spamming the channel' });
  assert.equal((await since(db, again)).length, 0);
  // restore
  const b2 = await mark(db);
  assert.equal((await db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: false })).status,
    'active');
  assert.equal(await canRead(db, f.bob, f.general), true);
  const up = await since(db, b2, { event: 'member.upd', topic: `u:${f.bob}` });
  assert.equal(up[0].payload.change, 'added');
  assert.equal((await orgMember(db, f.org, f.bob)).suspended_reason, null);

  // ranks: admins cannot touch owners or admins; nobody suspends themselves
  await expectError(db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.owner, p_suspended: true }), 'forbidden');
  await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'admin' });
  await expectError(db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.alice, p_suspended: true }), 'forbidden');
  await expectError(db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.admin, p_suspended: true }), 'forbidden');
  assert.equal((await db.call(f.owner, 'suspend_org_member', { p_org: f.org, p_user: f.alice, p_suspended: true })).status,
    'suspended');
  await expectError(db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: null }), 'invalid_input');
  await expectError(db.call(f.carol, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: true }), 'forbidden');
  await expectError(db.call(f.guest, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: true }), 'forbidden');
  await expectError(db.call(f.suspended, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: true }), 'suspended');
  await expectError(db.call(f.eve, 'suspend_org_member', { p_org: f.org, p_user: f.bob, p_suspended: true }), 'not_found');
  await expectError(db.call(f.admin, 'suspend_org_member', { p_org: f.org, p_user: f.stranger, p_suspended: true }), 'not_found');
}));

test('remove_org_member: memberships go through revoke_org_membership, optional ban, ranks and last owner', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q("insert into dek.join_requests (org_id, server_id, user_id) values ($1, $2, $3)", [f.org, f.tech, f.bob]);
  const before = await mark(db);
  const r = await db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.bob, p_reason: 'Left the team' });
  assert.deepEqual(r, { org_id: f.org, user_id: f.bob, removed: true, banned: false });
  assert.equal(await orgMember(db, f.org, f.bob), undefined);
  assert.equal(await serverRole(db, f.medical, f.bob), null);
  assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id = $1 and user_id = $2',
    [f.general, f.bob])).n, 0);
  assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id = $1 and user_id = $2',
    [f.dmAliceBob, f.bob])).n, 1, 'DM history keeps its members');
  assert.equal(await canRead(db, f.bob, f.dmAliceBob), false, 'but nothing in the org is readable');
  const ev = await since(db, before, { event: 'access.revoked', topic: `u:${f.bob}` });
  assert.ok(ev.some((e) => e.payload.scope === 'org'));
  assert.equal((await db.one("select status from dek.join_requests where user_id = $1", [f.bob])).status, 'withdrawn');
  assert.equal((await auditRows(db, f.org, 'org.member_removed')).length, 1);

  // ban
  await db.call(f.owner, 'remove_org_member', { p_org: f.org, p_user: f.carol, p_ban: true, p_reason: 'Abuse' });
  const ban = await db.one('select reason, banned_by from dek.org_bans where org_id = $1 and user_id = $2', [f.org, f.carol]);
  assert.deepEqual(ban, { reason: 'Abuse', banned_by: f.owner });
  assert.equal((await auditRows(db, f.org, 'org.member_banned')).length, 1);

  // ranks, self, last owner, strangers
  await expectError(db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.owner }), 'forbidden');
  await expectError(db.call(f.owner, 'remove_org_member', { p_org: f.org, p_user: f.owner }), 'forbidden');
  await expectError(db.call(f.alice, 'remove_org_member', { p_org: f.org, p_user: f.guest }), 'forbidden');
  await expectError(db.call(f.guest, 'remove_org_member', { p_org: f.org, p_user: f.alice }), 'forbidden');
  await expectError(db.call(f.suspended, 'remove_org_member', { p_org: f.org, p_user: f.alice }), 'suspended');
  await expectError(db.call(f.eve, 'remove_org_member', { p_org: f.org, p_user: f.alice }), 'not_found');
  await expectError(db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.eve }), 'not_found');
  const owner2 = await db.user('Second Owner');
  await db.member(f.org, owner2, 'owner');
  await db.call(f.owner, 'remove_org_member', { p_org: f.org, p_user: owner2 });
  assert.equal(await orgMember(db, f.org, owner2), undefined);
}));

test('leave_org: cleanup for the caller, the last owner stays, suspended members cannot leave', () => tx(async (db) => {
  const f = await db.fixture();
  const before = await mark(db);
  assert.deepEqual(await db.call(f.bob, 'leave_org', { p_org: f.org }), { org_id: f.org, left: true });
  assert.equal(await orgMember(db, f.org, f.bob), undefined);
  assert.equal(await serverRole(db, f.medical, f.bob), null);
  const ev = await since(db, before, { event: 'access.revoked', topic: `u:${f.bob}` });
  assert.ok(ev.some((e) => e.payload.scope === 'org'));
  assert.equal((await auditRows(db, f.org, 'org.member_left')).length, 1);
  await expectError(db.call(f.bob, 'leave_org', { p_org: f.org }), 'not_found');

  const err = await expectError(db.call(f.owner, 'leave_org', { p_org: f.org }), 'conflict');
  assert.match(err.hint, /last owner/);
  await expectError(db.call(f.suspended, 'leave_org', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'leave_org', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'leave_org', { p_org: f.org }), 'not_found');
  // guests can leave; an owner with a co-owner can leave
  await db.call(f.guest, 'leave_org', { p_org: f.org });
  assert.equal(await canRead(db, f.guest, f.grants), false);
  await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.admin, p_role: 'owner' });
  await db.call(f.owner, 'leave_org', { p_org: f.org });
  assert.equal(await orgMember(db, f.org, f.owner), undefined);
}));
