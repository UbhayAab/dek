// The transform on a small synthetic legacy extract (no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from '../lib/transform.mjs';
import { ORGS } from '../lib/config.mjs';

const JCF = ORGS[0].id;
const SS = ORGS[1].id;
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = (min) => `2026-09-01 10:${String(min).padStart(2, '0')}:00.123456+00`;

function user(n, name, email = `p${n}@example.org`) {
  return { real_member: true, auth: { id: u(n), email, encrypted_password: '$2a$10$x', created_at: T(0),
    last_sign_in_at: T(1), confirmation_token: '', recovery_token: 'pending', email_change: '' },
  profile: { username: name.toLowerCase(), display_name: name, title: null, timezone: 'Asia/Kolkata', created_at: T(0), updated_at: T(0) } };
}

function fixture() {
  const msg = (n, ch, seq, author, text, extra = {}) => ({ id: id(n), channel_id: ch, thread_id: null, author_id: u(author),
    seq, client_msg_id: id(900 + n), body: { text }, body_text: text, attachments: [], mention_user_ids: [],
    mention_scope: 'none', reply_to_id: null, created_at: T(n), edited_at: null, deleted_at: null, also_send_to_channel: false, ...extra });
  const general = id(100);
  const secret = id(101);
  return {
    snapshot: { at: T(59), encoding: 'UTF8', digest_is_sha256_utf8: true },
    orgs: [{ id: JCF, created_at: T(0) }, { id: SS, created_at: T(0) }],
    users: [user(1, 'Asha'), user(2, 'Ram'), user(3, 'Lin')],
    excludedUsers: [{ reason: 'test_domain', n: 4 }],
    identities: [], sessions: [], refreshTokens: [], amrClaims: [],
    sessionCounts: { sessions: 0, expired: 0, without_live_token: 0 },
    orgMembers: [{ org_id: JCF, user_id: u(1), org_role: 'admin', joined_at: T(0) },
      { org_id: JCF, user_id: u(2), org_role: 'member', joined_at: T(0) },
      { org_id: JCF, user_id: u(3), org_role: 'member', joined_at: T(0) }],
    platformAdmins: [],
    workspaces: [{ id: id(50), org_id: JCF, name: 'Team', created_by: u(1), created_at: T(0), archived_at: null,
      scheduled_delete_at: null, requires_approval: false, join_policy: 'invite', default_channel_id: null, rules_text: null }],
    wsMembers: [{ workspace_id: id(50), user_id: u(1), member_type: 'member', joined_at: T(0) },
      { workspace_id: id(50), user_id: u(2), member_type: 'moderator', joined_at: T(0) },
      { workspace_id: id(50), user_id: u(3), member_type: 'member', joined_at: T(0) }],
    memberRoles: [{ workspace_id: id(50), user_id: u(3), role_id: id(60), name: 'Lead', permissions: '1942' }],
    channels: [
      { id: general, workspace_id: id(50), kind: 'text', name: 'general', topic: null, position: '1000', is_private: false, readonly: false, created_at: T(0), archived_at: null, category: 'General' },
      { id: secret, workspace_id: id(50), kind: 'text', name: 'Secret', topic: null, position: '2000', is_private: true, readonly: false, created_at: T(0), archived_at: null, category: null },
      { id: id(102), workspace_id: id(50), kind: 'voice', name: 'Lounge', topic: null, position: '3000', is_private: false, readonly: false, created_at: T(0), archived_at: null, category: 'General' },
    ],
    channelMembers: [{ channel_id: secret, user_id: u(2) }],
    channelOverwrites: 0,
    messages: [
      msg(1, general, 3, 1, 'hello @Ram', { mention_user_ids: [u(2)] }),
      msg(2, general, 7, 2, 'root'),
      msg(3, general, 8, 1, 'reply one', { thread_id: id(70) }),
      msg(4, general, 10, 3, 'reply two', { thread_id: id(70), also_send_to_channel: true }),
      msg(5, general, 12, 2, '', { deleted_at: T(30), body: {} }),
      msg(6, general, 14, 3, 'quoting', { reply_to_id: id(1) }),
      msg(7, secret, 1, 2, 'only me @Asha', { mention_user_ids: [u(1)] }),
    ].map((m) => (m.id === id(2) ? { ...m, thread_id: id(70) } : m)),
    threads: [{ id: id(70), channel_id: general, root_message_id: id(2), reply_count: 2, created_at: T(2) }],
    threadFollowers: [{ thread_id: id(70), user_id: u(1), created_at: T(3) }],
    conversations: [
      { id: id(80), workspace_id: id(50), org_id: JCF, kind: 'dm', created_at: T(1) },
      { id: id(81), workspace_id: id(51), org_id: JCF, kind: 'dm', created_at: T(5) },
    ],
    convMembers: [
      { conversation_id: id(80), user_id: u(1), last_read_seq: 2, last_read_at: T(9) },
      { conversation_id: id(80), user_id: u(2), last_read_seq: 1, last_read_at: T(9) },
      { conversation_id: id(81), user_id: u(2), last_read_seq: 1, last_read_at: T(9) },
      { conversation_id: id(81), user_id: u(1), last_read_seq: 0, last_read_at: null },
    ],
    dmMessages: [
      { id: id(200), conversation_id: id(80), author_id: u(1), seq: 1, client_msg_id: id(300), body: { text: 'a' }, body_text: 'a', attachments: [], reply_to_id: null, created_at: T(2), edited_at: null, deleted_at: null, mention_user_ids: [] },
      { id: id(201), conversation_id: id(81), author_id: u(2), seq: 1, client_msg_id: id(301), body: { text: 'b' }, body_text: 'b', attachments: [], reply_to_id: null, created_at: T(6), edited_at: null, deleted_at: null, mention_user_ids: [] },
      { id: id(202), conversation_id: id(80), author_id: u(2), seq: 2, client_msg_id: id(302), body: { text: 'c' }, body_text: 'c', attachments: [], reply_to_id: null, created_at: T(8), edited_at: null, deleted_at: null, mention_user_ids: [] },
    ],
    reactions: [{ message_id: id(1), user_id: u(2), emoji: '👍', created_at: T(4) },
      { message_id: id(5), user_id: u(1), emoji: '👍', created_at: T(31) }],
    dmReactions: [], pins: [], saved: [{ user_id: u(1), message_id: id(1), created_at: T(5), state: 'done', remind_at: null }],
    readState: [
      { user_id: u(1), scope_type: 'channel', scope_id: general, last_read_seq: 9, notify_level: 'mentions', muted_until: null, updated_at: T(20) },
      { user_id: u(3), scope_type: 'channel', scope_id: secret, last_read_seq: 1, notify_level: 'inherit', muted_until: null, updated_at: T(20) },
      { user_id: u(2), scope_type: 'thread', scope_id: id(70), last_read_seq: 8, notify_level: 'inherit', muted_until: null, updated_at: T(21) },
    ],
    attachmentRows: [], objects: [],
    invites: [{ id: id(400), org_id: JCF, workspace_id: id(50), token_sha256: 'ab'.repeat(32), grant_role_id: null,
      max_uses: null, uses: 3, created_by: u(1), expires_at: null, revoked_at: null, created_at: T(1) }],
    orgInvites: [{ id: id(401), org_id: JCF, token_sha256: 'cd'.repeat(32), grant_role: 'admin', max_uses: 5, uses: 1,
      created_by: u(1), expires_at: T(50), revoked_at: null, created_at: T(1) }],
    notificationPrefs: [{ user_id: u(2), quiet_start: 23, quiet_end: 7, updated_at: T(3) }],
    pushSubs: [{ user_id: u(1), endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'k', auth: 'a', ua: null, created_at: T(1), last_ok_at: null, fail_count: 0 }],
    joinRequests: [], bans: [{ workspace_id: id(50), org_id: JCF, user_id: u(3), banned_by: u(1), has_reason: false, created_at: T(9) }],
    archive: {},
  };
}

const plan = transform(fixture());
const msgs = new Map(plan.rows.messages.map((m) => [m.id, m]));

test('seq is renumbered from 1 per channel in legacy order, gaps closed', () => {
  const general = plan.rows.messages.filter((m) => m.channel_id === id(100)).map((m) => [m.meta.legacy.seq, m.seq]);
  assert.deepEqual(general, [[3, 1], [7, 2], [8, 3], [10, 4], [12, 5], [14, 6]]);
  const state = plan.rows.channel_state.find((s) => s.channel_id === id(100));
  assert.equal(state.last_seq, 6);
  assert.equal(state.last_top_seq, 6);
});

test('threads: replies point at the root; also_send_to_channel stays in the timeline', () => {
  assert.equal(msgs.get(id(2)).thread_root_id, null);
  assert.equal(msgs.get(id(3)).thread_root_id, id(2));
  assert.equal(msgs.get(id(3)).in_timeline, false);
  assert.equal(msgs.get(id(4)).also_in_channel, true);
  assert.equal(msgs.get(id(4)).in_timeline, true);
  assert.equal(msgs.get(id(2)).reply_count, 2);
  assert.deepEqual(msgs.get(id(2)).reply_user_ids, [u(1), u(3)]);
});

test('mentions become tokens, readers only, and mention rows skip non-readers', () => {
  assert.equal(msgs.get(id(1)).body, `hello <@${u(2)}>`);
  assert.deepEqual(msgs.get(id(1)).mentions, [u(2)]);
  // Asha is not a member of the private channel: the token stays, the mention does not.
  assert.equal(msgs.get(id(7)).body, `only me <@${u(1)}>`);
  assert.deepEqual(msgs.get(id(7)).mentions, []);
  assert.equal(plan.rows.mentions.filter((m) => m.message_id === id(7)).length, 0);
});

test('deleted messages are tombstones without reactions; quotes lead the reply', () => {
  assert.equal(msgs.get(id(5)).body, '');
  assert.deepEqual(msgs.get(id(5)).reactions, {});
  assert.equal(plan.rows.reactions.filter((r) => r.message_id === id(5)).length, 0);
  assert.deepEqual(msgs.get(id(1)).reactions, { '👍': [u(2)] });
  assert.equal(msgs.get(id(6)).body, '> Asha: hello @Ram\nquoting');
  assert.equal(msgs.get(id(6)).meta.legacy.reply_to, id(1));
});

test('public channels hold every server member; private channels their legacy members', () => {
  const members = (ch) => plan.rows.channel_members.filter((m) => m.channel_id === ch).map((m) => m.user_id).sort();
  assert.deepEqual(members(id(100)), [u(1), u(2), u(3)]);
  assert.deepEqual(members(id(102)), [u(1), u(2), u(3)]);
  assert.deepEqual(members(id(101)), [u(2)]);
  const secret = plan.rows.channels.find((c) => c.id === id(101));
  assert.equal(secret.created_by, u(2));
  assert.equal(plan.rows.channel_members.find((m) => m.channel_id === id(101)).role, 'owner');
  assert.equal(plan.rows.channels.find((c) => c.id === id(100)).auto_join, true);
  assert.equal(plan.rows.channels.find((c) => c.id === id(102)).kind, 'audio');
});

test('server roles: creator admin, member_type moderator, manage-messages role moderator', () => {
  const role = (n) => plan.rows.server_members.find((m) => m.user_id === u(n)).role;
  assert.equal(role(1), 'admin');
  assert.equal(role(2), 'moderator');
  assert.equal(role(3), 'moderator');
});

test('two conversations of one pair merge into the older one, renumbered by time', () => {
  const dms = plan.rows.channels.filter((c) => c.kind === 'dm');
  assert.equal(dms.length, 1);
  assert.equal(dms[0].id, id(80));
  assert.equal(dms[0].dm_key, `${JCF}:${[u(1), u(2)].sort().join(':')}`);
  const order = plan.rows.messages.filter((m) => m.channel_id === id(80)).map((m) => [m.id, m.seq]);
  assert.deepEqual(order, [[id(200), 1], [id(201), 2], [id(202), 3]]);
  assert.ok(plan.idMap.some((e) => e.kind === 'conversation' && e.legacy_key === id(81) && e.new_id === id(80)));
});

test('read cursors map through the seq map; invalid rows are dropped', () => {
  const row = (ch, user) => plan.rows.channel_members.find((m) => m.channel_id === ch && m.user_id === user);
  // Legacy cursor 9 covers legacy seqs 3, 7 and 8, which are new seqs 1 to 3.
  assert.equal(row(id(100), u(1)).last_read_seq, 3);
  assert.equal(row(id(100), u(1)).notify, 'mentions');
  assert.equal(plan.stats.read_state.channel_rows_invalid_or_not_member, 1);
  // Asha read both of her messages in conversation 80 but none of 81: prefix = 1.
  assert.equal(row(id(80), u(1)).last_read_seq, 1);
  // Ram read 1 in 80 and 1 in 81: messages 200 (80/1) and 201 (81/1) read, 202 (80/2) not.
  assert.equal(row(id(80), u(2)).last_read_seq, 2);
});

test('thread follows from followers and thread read state', () => {
  const f = plan.rows.thread_follows;
  assert.equal(f.find((r) => r.user_id === u(1)).following, true);
  const ram = f.find((r) => r.user_id === u(2));
  assert.equal(ram.following, false);
  assert.equal(ram.last_read_reply_seq, 3);
});

test('invites keep their hash; no expiry is far future; admin grants become member', () => {
  const ws = plan.rows.invites.find((i) => i.id === id(400));
  assert.equal(ws.code, null);
  assert.equal(ws.code_sha256, `\\x${'ab'.repeat(32)}`);
  assert.equal(ws.server_id, id(50));
  assert.equal(ws.expires_at, '2100-01-01T00:00:00+00:00');
  const org = plan.rows.invites.find((i) => i.id === id(401));
  assert.equal(org.server_id, null);
  assert.equal(org.role, 'member');
  assert.equal(plan.stats.invites.admin_role_downgraded, 1);
});

test('devices go in disabled; quiet hours; ban note; pending tokens blanked', () => {
  assert.equal(plan.rows.push_devices[0].enabled, false);
  assert.equal(plan.rows.push_devices[0].label, 'Chrome');
  const ram = plan.rows.notification_prefs.find((p) => p.user_id === u(2));
  assert.deepEqual([ram.quiet_start, ram.quiet_end], ['23:00', '07:00']);
  assert.equal(plan.rows.audit_notes.length, 1);
  assert.equal(plan.rows.auth_users[0].recovery_token, '');
  assert.ok(plan.warnings.some((w) => w.includes('no owner account')));
});

test('the transform is deterministic', () => {
  const again = transform(fixture());
  assert.equal(JSON.stringify(again.rows), JSON.stringify(plan.rows));
});
