// [org] invites and join requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import { mark, since, setSettings, canRead, orgMember, serverRole, channelRow, auditRows, sorted } from './org-lib.mjs';

const PREVIEW_KEYS = ['inviter_name', 'org_brand_color', 'org_name', 'reason', 'requires_approval', 'server_name', 'valid'];
const INVITE_ITEM_KEYS = ['code', 'created_at', 'created_by', 'email', 'expires_at', 'id', 'max_uses', 'requires_approval',
  'revoked_at', 'role', 'server_id', 'use_count'];
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hours = (iso) => (new Date(iso).getTime() - Date.now()) / 3600000;

test('create_invite: admins, server admins for their server, members only when allowed; code and hash', () => tx(async (db) => {
  const f = await db.fixture();
  const r = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical });
  assert.deepEqual(Object.keys(r).sort(), ['code', 'expires_at', 'id', 'url_path']);
  assert.match(r.code, /^[0-9A-Za-z]{22}$/);
  assert.equal(r.url_path, `/invite/${r.code}`);
  assert.ok(Math.abs(hours(r.expires_at) - 168) < 0.1, 'default expiry is the org setting (7 days)');
  const row = await db.one("select encode(code_sha256, 'hex') h, role, server_id, created_by from dek.invites where id = $1", [r.id]);
  assert.deepEqual(row, { h: sha256(r.code), role: 'member', server_id: f.medical, created_by: f.admin });
  const audit = await auditRows(db, f.org, 'invite.created');
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes(r.code), 'the code is never written to the audit log');
  const r2 = await db.call(f.admin, 'create_invite', {
    p_org: f.org, p_expires_hours: 2, p_max_uses: 5, p_email: ' Person@Example.ORG ', p_requires_approval: true });
  assert.notEqual(r2.code, r.code);
  assert.ok(Math.abs(hours(r2.expires_at) - 2) < 0.1);
  assert.deepEqual(await db.one('select email, max_uses, requires_approval from dek.invites where id = $1', [r2.id]),
    { email: 'person@example.org', max_uses: 5, requires_approval: true });
  await setSettings(db, f.org, { default_invite_hours: 24 });
  assert.ok(Math.abs(hours((await db.call(f.owner, 'create_invite', { p_org: f.org })).expires_at) - 24) < 0.1);

  for (const a of [{ p_expires_hours: 721 }, { p_expires_hours: 0 }, { p_max_uses: 0 }, { p_email: 'not-an-email' },
    { p_role: 'admin' }]) {
    await expectError(db.call(f.admin, 'create_invite', { p_org: f.org, ...a }), 'invalid_input');
  }

  // plain members only with member_can_invite, and only for servers they are in
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org }), 'forbidden');
  await setSettings(db, f.org, { member_can_invite: true });
  assert.match((await db.call(f.alice, 'create_invite', { p_org: f.org })).code, /^[0-9A-Za-z]{22}$/);
  assert.ok((await db.call(f.alice, 'create_invite', { p_org: f.org, p_server: f.medical })).id);
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_server: f.tech }), 'forbidden');
  const open = await db.server(f.org, 'Open', { joinPolicy: 'open' });
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_server: open }), 'forbidden');
  await setSettings(db, f.org, { member_can_invite: false });
  // a server admin who is a plain org member invites to their server only
  await db.serverMember(f.medical, f.bob, 'admin');
  assert.ok((await db.call(f.bob, 'create_invite', { p_org: f.org, p_server: f.medical })).id);
  await expectError(db.call(f.bob, 'create_invite', { p_org: f.org }), 'forbidden');

  await expectError(db.call(f.guest, 'create_invite', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.suspended, 'create_invite', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'create_invite', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'create_invite', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.otherServer }), 'not_found');
}));

test('create_invite: channels the inviter could add people to; guest invites name channels, never servers', () => tx(async (db) => {
  const f = await db.fixture();
  await setSettings(db, f.org, { member_can_invite: true });
  // Alice owns Grants: she may invite people into it, cross-team or not
  assert.ok((await db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.grants] })).id);
  // a public channel of her server: only together with that server
  assert.ok((await db.call(f.alice, 'create_invite', { p_org: f.org, p_server: f.medical, p_channel_ids: [f.general] })).id);
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.general] }), 'forbidden');
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.secret] }), 'not_found');
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.otherChannel] }), 'not_found');
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.dmAliceBob] }), 'not_found');
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.grants]);
  await expectError(db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.grants] }), 'archived');
  const many = Array.from({ length: 21 }, () => f.general);
  assert.ok((await db.call(f.admin, 'create_invite', { p_org: f.org, p_channel_ids: many })).id, 'duplicates collapse');

  // guests: channels only, and only while the org allows guests
  const g = await db.call(f.admin, 'create_invite', { p_org: f.org, p_role: 'guest', p_channel_ids: [f.general] });
  assert.equal((await db.one('select role from dek.invites where id = $1', [g.id])).role, 'guest');
  await expectError(db.call(f.admin, 'create_invite', { p_org: f.org, p_role: 'guest', p_server: f.medical }), 'invalid_input');
  await setSettings(db, f.org, { allow_guests: false });
  await expectError(db.call(f.admin, 'create_invite', { p_org: f.org, p_role: 'guest', p_channel_ids: [f.general] }),
    'forbidden');
}));

test('preview_invite: anon sees only what the invite page shows, never ids; every reason', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q("update dek.orgs set brand_color = '#AA0000' where id = $1", [f.org]);
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  const inv = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical });
  const p = await db.call(null, 'preview_invite', { p_code: inv.code });
  assert.deepEqual(Object.keys(p).sort(), PREVIEW_KEYS);
  assert.deepEqual(p, { valid: true, reason: null, org_name: 'JCF Test', org_brand_color: '#AA0000',
    server_name: 'Medical Partnerships', inviter_name: 'Admin', requires_approval: false });
  const text = JSON.stringify(p);
  for (const id of [f.org, f.medical, f.admin, inv.id]) assert.ok(!text.includes(id), 'no ids leak');
  assert.deepEqual(await db.call(f.eve, 'preview_invite', { p_code: ` ${inv.code} ` }), p, 'signed in works too');

  const ap = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: approval });
  assert.equal((await db.call(null, 'preview_invite', { p_code: ap.code })).requires_approval, true);
  const org = await db.call(f.admin, 'create_invite', { p_org: f.org, p_requires_approval: true });
  const po = await db.call(null, 'preview_invite', { p_code: org.code });
  assert.equal(po.requires_approval, true);
  assert.equal(po.server_name, null);

  const notFound = { valid: false, reason: 'not_found', org_name: null, org_brand_color: null, server_name: null,
    inviter_name: null, requires_approval: false };
  for (const code of ['NoSuchInviteCode123456', '', 'x'.repeat(500), null]) {
    assert.deepEqual(await db.call(null, 'preview_invite', { p_code: code }), notFound);
  }
  const reason = async (code) => (await db.call(null, 'preview_invite', { p_code: code })).reason;
  await db.q("update dek.invites set expires_at = now() - interval '1 minute' where id = $1", [inv.id]);
  assert.equal(await reason(inv.code), 'expired');
  await db.call(f.admin, 'revoke_invite', { p_invite: org.id });
  assert.equal(await reason(org.code), 'revoked');
  const once = await db.call(f.admin, 'create_invite', { p_org: f.org, p_max_uses: 1 });
  await db.q('update dek.invites set use_count = 1 where id = $1', [once.id]);
  assert.equal(await reason(once.code), 'used_up');
  await db.q('update dek.servers set archived_at = now() where id = $1', [approval]);
  assert.equal(await reason(ap.code), 'revoked', 'an archived server closes its invites');
  assert.equal((await db.call(null, 'preview_invite', { p_code: once.code })).valid, false);
  // anon can call nothing else
  await expectError(db.call(null, 'accept_invite', { p_code: once.code }));
  await expectError(db.call(null, 'list_invites', { p_org: f.org }));
}));

test('accept_invite: joins the org, the server (with auto_join channels) and the invite channels; idempotent', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q('update dek.channels set auto_join = true where id = $1', [f.general]);
  const inv = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical, p_channel_ids: [f.grants] });
  const priya = await db.user('Priya');
  const before = await mark(db);
  assert.deepEqual(await db.call(priya, 'accept_invite', { p_code: inv.code }),
    { status: 'joined', org_id: f.org, server_id: f.medical });
  assert.deepEqual(await orgMember(db, f.org, priya), { role: 'member', status: 'active', suspended_reason: null });
  assert.equal((await db.one('select invited_by from dek.org_members where org_id = $1 and user_id = $2', [f.org, priya]))
    .invited_by, f.admin);
  assert.equal(await serverRole(db, f.medical, priya), 'member');
  assert.ok(await channelRow(db, f.general, priya), 'auto_join channel');
  assert.ok(await channelRow(db, f.grants, priya), 'invite channel');
  assert.equal(await canRead(db, priya, f.secret), false);
  const use = await db.one('select use_count from dek.invites where id = $1', [inv.id]);
  assert.equal(use.use_count, 1);
  assert.equal((await db.q('select 1 from dek.invite_uses where invite_id = $1 and user_id = $2', [inv.id, priya])).length, 1);
  const ev = await since(db, before, { event: 'member.upd', topic: `u:${priya}` });
  assert.deepEqual(sorted(ev.map((e) => e.payload.scope)), ['channel', 'channel', 'org', 'server']);
  assert.equal((await since(db, before, { event: 'member.upd', topic: `s:${f.medical}` })).length, 1);
  assert.equal((await auditRows(db, f.org, 'invite.accepted')).length, 1);

  // nothing new to give: already_member, no use counted
  assert.deepEqual(await db.call(priya, 'accept_invite', { p_code: inv.code }),
    { status: 'already_member', org_id: f.org, server_id: f.medical });
  assert.equal((await db.one('select use_count from dek.invites where id = $1', [inv.id])).use_count, 1);

  // existing members keep their role and gain only what is new
  const tech = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.tech });
  assert.equal((await db.call(f.alice, 'accept_invite', { p_code: tech.code })).status, 'joined');
  assert.equal(await serverRole(db, f.tech, f.alice), 'member');
  assert.equal((await orgMember(db, f.org, f.alice)).role, 'member');
  assert.equal((await db.call(f.admin, 'accept_invite', { p_code: tech.code })).status, 'joined');
  assert.equal((await orgMember(db, f.org, f.admin)).role, 'admin', 'an admin is not demoted by a member invite');
  // an existing guest never becomes a server member through an invite
  assert.equal((await db.call(f.guest, 'accept_invite', { p_code: tech.code })).status, 'already_member');
  assert.equal(await serverRole(db, f.tech, f.guest), null);

  // a guest invite gives channels only
  const gi = await db.call(f.admin, 'create_invite', { p_org: f.org, p_role: 'guest', p_channel_ids: [f.general] });
  const vendor = await db.user('Vendor');
  assert.deepEqual(await db.call(vendor, 'accept_invite', { p_code: gi.code }),
    { status: 'joined', org_id: f.org, server_id: null });
  assert.equal((await orgMember(db, f.org, vendor)).role, 'guest');
  assert.equal(await canRead(db, vendor, f.general), true);
  assert.equal(await serverRole(db, f.medical, vendor), null);
  assert.deepEqual((await db.call(vendor, 'list_channels', { p_server: f.medical })).map((c) => c.id), [f.general]);
}));

test('accept_invite refusals: unknown, expired, revoked, used up (max_uses), banned, wrong email, suspended', () => tx(async (db) => {
  const f = await db.fixture();
  const newUser = (name) => db.user(name);
  await expectError(db.call(f.eve, 'accept_invite', { p_code: 'GuessedGuessedGuessed1' }), 'not_found');
  await expectError(db.call(f.eve, 'accept_invite', { p_code: '' }), 'not_found');

  const exp = await db.call(f.admin, 'create_invite', { p_org: f.org });
  await db.q("update dek.invites set expires_at = now() - interval '1 second' where id = $1", [exp.id]);
  const e1 = await expectError(db.call(await newUser('Late'), 'accept_invite', { p_code: exp.code }), 'conflict');
  assert.equal(e1.hint, 'expired');

  const rev = await db.call(f.admin, 'create_invite', { p_org: f.org });
  await db.call(f.admin, 'revoke_invite', { p_invite: rev.id });
  assert.equal((await expectError(db.call(await newUser('R'), 'accept_invite', { p_code: rev.code }), 'conflict')).hint,
    'revoked');

  // max_uses 1: the first accept wins, the second is refused and nothing is granted
  const once = await db.call(f.admin, 'create_invite', { p_org: f.org, p_max_uses: 1 });
  const first = await newUser('First');
  const second = await newUser('Second');
  assert.equal((await db.call(first, 'accept_invite', { p_code: once.code })).status, 'joined');
  assert.equal((await expectError(db.call(second, 'accept_invite', { p_code: once.code }), 'conflict')).hint, 'used_up');
  assert.equal(await orgMember(db, f.org, second), undefined);
  assert.equal((await db.one('select use_count from dek.invites where id = $1', [once.id])).use_count, 1);

  // banned: removed with a ban, a fresh invite does not let them back
  await db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.bob, p_ban: true });
  const again = await db.call(f.admin, 'create_invite', { p_org: f.org });
  await expectError(db.call(f.bob, 'accept_invite', { p_code: again.code }), 'forbidden');
  assert.equal(await orgMember(db, f.org, f.bob), undefined);

  // targeted invites: the caller's confirmed email must match, case-insensitively
  const t = await db.call(f.admin, 'create_invite', { p_org: f.org, p_email: 'Target.Person@Example.org' });
  await expectError(db.call(await newUser('Someone Else'), 'accept_invite', { p_code: t.code }), 'forbidden');
  const unconfirmed = await db.user('Unconfirmed', 'target.person@example.org');
  await db.q('update auth.users set email_confirmed_at = null where id = $1', [unconfirmed]);
  await expectError(db.call(unconfirmed, 'accept_invite', { p_code: t.code }), 'forbidden');
  await db.q("update auth.users set email = 'old@example.org' where id = $1", [unconfirmed]);
  const target = await db.user('Target', 'TARGET.person@example.org');
  assert.equal((await db.call(target, 'accept_invite', { p_code: t.code })).status, 'joined');

  // a suspended member cannot use an invite to lift the suspension
  await expectError(db.call(f.suspended, 'accept_invite', { p_code: again.code }), 'suspended');
  assert.equal((await orgMember(db, f.org, f.suspended)).status, 'suspended');
}));

test('accept_invite with approval: a pending request counted once; legacy hash-only links still work', () => tx(async (db) => {
  const f = await db.fixture();
  const inv = await db.call(f.admin, 'create_invite', {
    p_org: f.org, p_server: f.medical, p_channel_ids: [f.grants], p_requires_approval: true });
  const kim = await db.user('Kim');
  assert.deepEqual(await db.call(kim, 'accept_invite', { p_code: inv.code }),
    { status: 'pending', org_id: f.org, server_id: f.medical });
  assert.deepEqual(await db.call(kim, 'accept_invite', { p_code: inv.code }),
    { status: 'pending', org_id: f.org, server_id: f.medical });
  assert.equal(await orgMember(db, f.org, kim), undefined, 'nothing granted before approval');
  const reqs = await db.q('select status, invite_id, server_id from dek.join_requests where user_id = $1', [kim]);
  assert.deepEqual(reqs, [{ status: 'pending', invite_id: inv.id, server_id: f.medical }]);
  assert.equal((await db.one('select use_count from dek.invites where id = $1', [inv.id])).use_count, 1);
  // a server whose policy is approval holds an ordinary invite for approval too
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  const ai = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: approval });
  assert.equal((await db.call(f.alice, 'accept_invite', { p_code: ai.code })).status, 'pending');
  assert.equal(await serverRole(db, approval, f.alice), null);

  // a migrated legacy invite has only the hash of its old token
  const token = 'legacy_TOKEN-0f9a8b7c6d5e4f3a2b1c';
  await db.q(
    `insert into dek.invites (org_id, server_id, role, code, code_sha256, created_by, expires_at)
     values ($1, $2, 'member', null, sha256(convert_to($3, 'UTF8')), $4, now() + interval '1 day')`,
    [f.org, f.tech, token, f.owner]);
  assert.equal((await db.call(null, 'preview_invite', { p_code: token })).server_name, 'Tech');
  const lee = await db.user('Lee');
  assert.equal((await db.call(lee, 'accept_invite', { p_code: token })).status, 'joined');
  assert.equal(await serverRole(db, f.tech, lee), 'member');
  const listed = (await db.call(f.owner, 'list_invites', { p_org: f.org })).items.find((i) => i.server_id === f.tech);
  assert.equal(listed.code, null, 'legacy invites have no copyable code');
}));

test('an invite carries its creator\'s authority at use time: removal, suspension, settings, demotion', () => tx(async (db) => {
  const f = await db.fixture();
  const reason = async (code) => (await db.call(null, 'preview_invite', { p_code: code })).reason;
  const accept = async (code) => db.call(await db.user('Newcomer'), 'accept_invite', { p_code: code });

  // an admin makes a long-lived invite, is then removed with a ban: the invite dies with
  // the authority (no way back in through a second account)
  const exAdmin = await db.user('Ex Admin');
  await db.member(f.org, exAdmin, 'admin');
  const long = await db.call(exAdmin, 'create_invite', { p_org: f.org, p_server: f.medical, p_max_uses: 10000,
    p_expires_hours: 720 });
  assert.equal(await reason(long.code), null);
  await db.call(f.owner, 'remove_org_member', { p_org: f.org, p_user: exAdmin, p_ban: true });
  assert.equal(await reason(long.code), 'revoked');
  assert.equal((await expectError(accept(long.code), 'conflict')).hint, 'revoked');

  // suspension pauses a creator's invites; restoring brings them back
  const mine = await db.call(f.admin, 'create_invite', { p_org: f.org });
  await db.call(f.owner, 'suspend_org_member', { p_org: f.org, p_user: f.admin, p_suspended: true });
  assert.equal(await reason(mine.code), 'revoked');
  await db.call(f.owner, 'suspend_org_member', { p_org: f.org, p_user: f.admin, p_suspended: false });
  assert.equal(await reason(mine.code), null);

  // a member's invite lives only while members may invite
  await setSettings(db, f.org, { member_can_invite: true });
  const bobs = await db.call(f.bob, 'create_invite', { p_org: f.org, p_server: f.medical });
  await setSettings(db, f.org, { member_can_invite: false });
  assert.equal(await reason(bobs.code), 'revoked');
  await setSettings(db, f.org, { member_can_invite: true });
  assert.equal(await reason(bobs.code), null);
  await db.call(f.bob, 'leave_server', { p_server: f.medical });
  assert.equal(await reason(bobs.code), 'revoked', 'the creator left the invite\'s server');
  await setSettings(db, f.org, { member_can_invite: false });

  // a server admin demoted to member loses the invites made for that server
  await db.serverMember(f.medical, f.alice, 'admin');
  const alices = await db.call(f.alice, 'create_invite', { p_org: f.org, p_server: f.medical });
  await db.call(f.owner, 'set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'member' });
  assert.equal(await reason(alices.code), 'revoked');

  // guest invites stop when the org turns guests off
  const gi = await db.call(f.admin, 'create_invite', { p_org: f.org, p_role: 'guest', p_channel_ids: [f.general] });
  await setSettings(db, f.org, { allow_guests: false });
  assert.equal(await reason(gi.code), 'revoked');
  await setSettings(db, f.org, { allow_guests: true });

  // migrated legacy invites keep working while their creator is an active member
  const token = 'legacy-made-by-a-plain-member';
  await db.q(
    `insert into dek.invites (org_id, server_id, role, code_sha256, created_by, expires_at, legacy_id)
     values ($1, $2, 'member', sha256(convert_to($3, 'UTF8')), $4, now() + interval '1 day', gen_random_uuid())`,
    [f.org, f.medical, token, f.carol]);
  assert.equal(await reason(token), null);
  await db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.carol });
  assert.equal(await reason(token), 'revoked');
}));

test('accept_invite grants only the channels the creator could still add people to', () => tx(async (db) => {
  const f = await db.fixture();
  await setSettings(db, f.org, { member_can_invite: true });
  // Alice owns Grants and invites someone into it; then she loses the ownership
  const inv = await db.call(f.alice, 'create_invite', { p_org: f.org, p_channel_ids: [f.grants] });
  await db.call(f.owner, 'remove_channel_member', { p_channel: f.grants, p_user: f.alice });
  const sam = await db.user('Sam');
  assert.equal((await db.call(sam, 'accept_invite', { p_code: inv.code })).status, 'joined');
  assert.equal((await orgMember(db, f.org, sam)).role, 'member');
  assert.equal(await canRead(db, sam, f.grants), false, 'the channel is no longer hers to give');
  // approvals too: the admin who invited into Leadership is demoted to member (members may
  // still invite here, so the invite lives), and the approval no longer gives Leadership
  const ap = await db.call(f.admin, 'create_invite', {
    p_org: f.org, p_channel_ids: [f.secret], p_requires_approval: true });
  await db.call(f.owner, 'set_org_role', { p_org: f.org, p_user: f.admin, p_role: 'member' });
  const kim = await db.user('Kim');
  assert.equal((await db.call(kim, 'accept_invite', { p_code: ap.code })).status, 'pending');
  const kimReq = (await db.one('select id from dek.join_requests where user_id = $1', [kim])).id;
  await db.call(f.owner, 'decide_join_request', { p_request: kimReq, p_approve: true });
  assert.equal((await orgMember(db, f.org, kim)).role, 'member');
  assert.equal(await canRead(db, kim, f.secret), false, 'the demoted creator can no longer give that channel');
  await setSettings(db, f.org, { member_can_invite: false });

  // two approval invites for the same server: one pending request, one use counted
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  const i1 = await db.call(f.owner, 'create_invite', { p_org: f.org, p_server: approval });
  const i2 = await db.call(f.owner, 'create_invite', { p_org: f.org, p_server: approval });
  const lee = await db.user('Lee');
  assert.equal((await db.call(lee, 'accept_invite', { p_code: i1.code })).status, 'pending');
  assert.equal((await db.call(lee, 'accept_invite', { p_code: i2.code })).status, 'pending');
  const uses = await db.q('select id, use_count from dek.invites where id = any ($1)', [[i1.id, i2.id]]);
  assert.deepEqual(uses.map((u) => u.use_count).sort(), [0, 1]);
  assert.equal((await db.q("select 1 from dek.join_requests where user_id = $1 and status = 'pending'", [lee])).length, 1);
}));

test('list_invites and revoke_invite: admins see and revoke all, others only their own', () => tx(async (db) => {
  const f = await db.fixture();
  await setSettings(db, f.org, { member_can_invite: true });
  const a = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical, p_max_uses: 3 });
  const b = await db.call(f.alice, 'create_invite', { p_org: f.org });
  const all = await db.call(f.owner, 'list_invites', { p_org: f.org });
  assert.deepEqual(sorted(all.items.map((i) => i.id)), sorted([a.id, b.id]));
  assert.deepEqual(Object.keys(all.items[0]).sort(), INVITE_ITEM_KEYS);
  const ai = all.items.find((i) => i.id === a.id);
  assert.equal(ai.code, a.code);
  assert.equal(ai.max_uses, 3);
  assert.equal(ai.use_count, 0);
  assert.equal(ai.revoked_at, null);
  assert.deepEqual((await db.call(f.alice, 'list_invites', { p_org: f.org })).items.map((i) => i.id), [b.id]);
  assert.deepEqual((await db.call(f.guest, 'list_invites', { p_org: f.org })).items, []);
  await expectError(db.call(f.suspended, 'list_invites', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'list_invites', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_invites', { p_org: f.org }), 'not_found');

  // revoke: the creator, org admins, admins of the invite's server; idempotent
  await expectError(db.call(f.bob, 'revoke_invite', { p_invite: b.id }), 'not_found');
  const rb = await db.call(f.alice, 'revoke_invite', { p_invite: b.id });
  assert.ok(rb.revoked_at);
  assert.equal((await db.call(f.alice, 'revoke_invite', { p_invite: b.id })).revoked_at, rb.revoked_at);
  assert.equal((await auditRows(db, f.org, 'invite.revoked')).length, 1);
  await db.serverMember(f.medical, f.bob, 'admin');
  assert.ok((await db.call(f.bob, 'revoke_invite', { p_invite: a.id })).revoked_at, 'server admin, invite for his server');
  const c = await db.call(f.alice, 'create_invite', { p_org: f.org });
  assert.ok((await db.call(f.admin, 'revoke_invite', { p_invite: c.id })).revoked_at);
  // a migrated invite with no creator: still admins only (a NULL creator must not open the check)
  const legacy = (await db.one(
    `insert into dek.invites (org_id, role, code_sha256, created_by, expires_at)
     values ($1, 'member', sha256(convert_to('legacy-no-creator-token', 'UTF8')), null, now() + interval '1 day')
     returning id`, [f.org])).id;
  await expectError(db.call(f.bob, 'revoke_invite', { p_invite: legacy }), 'not_found');
  assert.equal((await db.one('select revoked_at from dek.invites where id = $1', [legacy])).revoked_at, null);
  assert.ok((await db.call(f.owner, 'revoke_invite', { p_invite: legacy })).revoked_at);
  await expectError(db.call(f.guest, 'revoke_invite', { p_invite: c.id }), 'not_found');
  await expectError(db.call(f.suspended, 'revoke_invite', { p_invite: c.id }), 'suspended');
  await expectError(db.call(f.eve, 'revoke_invite', { p_invite: c.id }), 'not_found');
  await expectError(db.call(f.stranger, 'revoke_invite', { p_invite: c.id }), 'not_found');
}));

test('list_join_requests: org admins see all, server admins their servers, everyone else is refused', () => tx(async (db) => {
  const f = await db.fixture();
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  await db.call(f.bob, 'join_server', { p_server: approval });
  const inv = await db.call(f.admin, 'create_invite', { p_org: f.org, p_requires_approval: true });
  const kim = await db.user('Kim', 'kim@example.org');
  await db.call(kim, 'accept_invite', { p_code: inv.code });

  const all = await db.call(f.admin, 'list_join_requests', { p_org: f.org });
  assert.equal(all.items.length, 2);
  assert.deepEqual(Object.keys(all.items[0]).sort(),
    ['created_at', 'email', 'id', 'invite_id', 'note', 'server_id', 'status', 'user']);
  const k = all.items.find((i) => i.user.id === kim);
  assert.equal(k.email, 'kim@example.org');
  assert.equal(k.invite_id, inv.id);
  assert.equal(k.server_id, null);
  assert.equal(k.status, 'pending');
  // a server admin who is a plain org member sees only his server's requests, without emails
  await db.serverMember(approval, f.alice, 'admin');
  const mine = (await db.call(f.alice, 'list_join_requests', { p_org: f.org })).items;
  assert.deepEqual(mine.map((i) => i.user.id), [f.bob]);
  assert.equal(mine[0].email, null, 'emails are for org admins only');
  assert.ok(all.items.find((i) => i.user.id === f.bob).email, 'org admins see the email');
  assert.equal((await db.call(f.admin, 'list_join_requests', { p_org: f.org, p_status: 'approved' })).items.length, 0);
  assert.equal((await db.call(f.admin, 'list_join_requests', { p_org: f.org, p_status: null })).items.length, 2);
  await expectError(db.call(f.admin, 'list_join_requests', { p_org: f.org, p_status: 'maybe' }), 'invalid_input');
  await expectError(db.call(f.bob, 'list_join_requests', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.guest, 'list_join_requests', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.suspended, 'list_join_requests', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'list_join_requests', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_join_requests', { p_org: f.org }), 'not_found');
}));

test('decide_join_request: approve grants what was asked, reject records, deciding twice is a conflict', () => tx(async (db) => {
  const f = await db.fixture();
  const approval = await db.call(f.admin, 'create_server', { p_org: f.org, p_name: 'Approval', p_join_policy: 'approval' });
  const approvalGeneral = (await db.one('select id from dek.channels where server_id = $1', [approval.id])).id;
  await db.call(f.bob, 'join_server', { p_server: approval.id });
  const bobReq = (await db.one('select id from dek.join_requests where user_id = $1', [f.bob])).id;
  await db.serverMember(approval.id, f.alice, 'admin');

  await expectError(db.call(f.carol, 'decide_join_request', { p_request: bobReq, p_approve: true }), 'forbidden');
  await expectError(db.call(f.alice, 'decide_join_request', { p_request: bobReq, p_approve: null }), 'invalid_input');
  const r = await db.call(f.alice, 'decide_join_request', { p_request: bobReq, p_approve: true });
  assert.deepEqual(r, { id: bobReq, status: 'approved', org_id: f.org, server_id: approval.id, user_id: f.bob });
  assert.equal(await serverRole(db, approval.id, f.bob), 'member');
  assert.ok(await channelRow(db, approvalGeneral, f.bob), 'auto_join channel of the server');
  await expectError(db.call(f.admin, 'decide_join_request', { p_request: bobReq, p_approve: false }), 'conflict');
  assert.equal((await auditRows(db, f.org, 'join_request.approved')).length, 1);

  // an invite request: approval makes the person a member with the invite's channels
  const inv = await db.call(f.admin, 'create_invite', {
    p_org: f.org, p_server: f.medical, p_channel_ids: [f.grants], p_requires_approval: true });
  const kim = await db.user('Kim');
  await db.call(kim, 'accept_invite', { p_code: inv.code });
  const kimReq = (await db.one('select id from dek.join_requests where user_id = $1', [kim])).id;
  await expectError(db.call(f.alice, 'decide_join_request', { p_request: kimReq, p_approve: true }), 'forbidden');
  await db.call(f.owner, 'decide_join_request', { p_request: kimReq, p_approve: true });
  assert.equal((await orgMember(db, f.org, kim)).role, 'member');
  assert.equal(await serverRole(db, f.medical, kim), 'member');
  assert.equal(await canRead(db, kim, f.grants), true);

  // reject grants nothing
  const lee = await db.user('Lee');
  await db.call(lee, 'accept_invite', { p_code: inv.code });
  const leeReq = (await db.one('select id from dek.join_requests where user_id = $1', [lee])).id;
  assert.equal((await db.call(f.admin, 'decide_join_request', { p_request: leeReq, p_approve: false })).status, 'rejected');
  assert.equal(await orgMember(db, f.org, lee), undefined);
  assert.equal((await auditRows(db, f.org, 'join_request.rejected')).length, 1);

  // banned meanwhile, suspended meanwhile, archived server
  const mo = await db.user('Mo');
  await db.call(mo, 'accept_invite', { p_code: inv.code });
  const moReq = (await db.one('select id from dek.join_requests where user_id = $1', [mo])).id;
  await db.q('insert into dek.org_bans (org_id, user_id) values ($1, $2)', [f.org, mo]);
  await expectError(db.call(f.admin, 'decide_join_request', { p_request: moReq, p_approve: true }), 'forbidden');
  await db.q("insert into dek.join_requests (org_id, server_id, user_id) values ($1, $2, $3)", [f.org, approval.id, f.suspended]);
  const susReq = (await db.one('select id from dek.join_requests where user_id = $1', [f.suspended])).id;
  await expectError(db.call(f.admin, 'decide_join_request', { p_request: susReq, p_approve: true }), 'conflict');
  await db.call(f.carol, 'join_server', { p_server: approval.id });
  const carolReq = (await db.one('select id from dek.join_requests where user_id = $1', [f.carol])).id;
  await db.call(f.admin, 'archive_server', { p_server: approval.id, p_archived: true });
  await expectError(db.call(f.admin, 'decide_join_request', { p_request: carolReq, p_approve: true }), 'archived');

  await expectError(db.call(f.guest, 'decide_join_request', { p_request: carolReq, p_approve: true }), 'forbidden');
  await expectError(db.call(f.suspended, 'decide_join_request', { p_request: carolReq, p_approve: true }), 'suspended');
  await expectError(db.call(f.eve, 'decide_join_request', { p_request: carolReq, p_approve: true }), 'not_found');
  await expectError(db.call(f.stranger, 'decide_join_request', { p_request: carolReq, p_approve: true }), 'not_found');
}));
