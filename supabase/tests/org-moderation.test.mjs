// [org] moderation (DEK13): reports, resolution, blocks, the audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { mark, since, orgMember, auditRows } from './org-lib.mjs';

const REPORT_KEYS = ['channel', 'created_at', 'details', 'id', 'kind', 'message', 'reason', 'reporter', 'resolution',
  'resolved_at', 'resolved_by', 'status', 'target_user'];

async function fillRate(db, uid, key, limit, windowSeconds) {
  await db.q(
    `insert into dek.rate_buckets (user_id, key, window_start, hits)
     values ($1, $2, to_timestamp(floor(extract(epoch from now()) / $3) * $3), $4)
     on conflict (user_id, key, window_start) do update set hits = excluded.hits`,
    [uid, key, windowSeconds, limit]);
}

test('report: readable messages and org members only; same open report returned; 20 per hour', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await db.message(f.general, f.alice, 'buy cheap pills');
  const r = await db.call(f.bob, 'report', {
    p_kind: 'message', p_org: f.org, p_message: m.id, p_reason: 'spam', p_details: 'Third time today' });
  assert.deepEqual(Object.keys(r), ['id']);
  const row = await db.one('select * from dek.reports where id = $1', [r.id]);
  assert.equal(row.kind, 'message');
  assert.equal(row.channel_id, f.general);
  assert.equal(row.target_user_id, f.alice);
  assert.equal(row.reporter_id, f.bob);
  assert.equal(row.details, 'Third time today');
  assert.equal(row.status, 'open');
  assert.equal((await db.call(f.bob, 'report', { p_kind: 'message', p_org: f.org, p_message: m.id, p_reason: 'other' })).id,
    r.id, 'reporting the same open thing again returns the same report');
  const u = await db.call(f.carol, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'harassment' });
  assert.equal((await db.one('select target_user_id, message_id from dek.reports where id = $1', [u.id])).target_user_id, f.bob);
  const inGrants = await db.message(f.grants, f.carol, 'off topic');
  assert.ok((await db.call(f.guest, 'report', {
    p_kind: 'message', p_org: f.org, p_message: inGrants.id, p_reason: 'inappropriate' })).id, 'guests may report');

  const otherMsg = await db.message(f.otherChannel, f.eve, 'other org');
  for (const [uid, args] of [
    [f.bob, { p_kind: 'message', p_message: inGrants.id }],                       // not readable for Bob
    [f.alice, { p_kind: 'message', p_message: otherMsg.id }],                     // another org's message
    [f.alice, { p_kind: 'user', p_user: f.eve }],                                 // not a member of this org
  ]) {
    await expectError(db.call(uid, 'report', { p_org: f.org, p_reason: 'spam', ...args }), 'not_found');
  }
  const sys = await db.one("select (dek.post_system($1, 'Call ended')).id as id", [f.general]);
  for (const args of [
    { p_kind: 'message', p_message: m.id, p_reason: 'rude' }, { p_kind: 'thing', p_message: m.id, p_reason: 'spam' },
    { p_kind: 'message', p_reason: 'spam' }, { p_kind: 'user', p_reason: 'spam' },
    { p_kind: 'user', p_user: f.alice, p_reason: 'spam' }, { p_kind: 'message', p_message: m.id, p_reason: 'spam' },
    { p_kind: 'message', p_message: sys.id, p_reason: 'spam' },
    { p_kind: 'user', p_user: f.bob, p_reason: 'spam', p_details: 'x'.repeat(2001) },
  ]) {
    await expectError(db.call(f.alice, 'report', { p_org: f.org, ...args }), 'invalid_input');
  }
  await expectError(db.call(f.suspended, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'spam' }), 'suspended');
  await expectError(db.call(f.eve, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'spam' }), 'not_found');
  await expectError(db.call(f.stranger, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'spam' }), 'not_found');
  await fillRate(db, f.admin, 'report', 20, 3600);
  await expectError(db.call(f.admin, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'spam' }), 'rate_limited');
}));

test('list_reports: org admins review reports with the message, channel and people', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await db.message(f.grants, f.carol, 'private rudeness');
  const r1 = await db.call(f.guest, 'report', { p_kind: 'message', p_org: f.org, p_message: m.id, p_reason: 'harassment' });
  const r2 = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'spam' });
  const list = await db.call(f.admin, 'list_reports', { p_org: f.org });
  assert.equal(list.total, 2);
  assert.deepEqual(Object.keys(list.items[0]).sort(), REPORT_KEYS);
  const item = list.items.find((i) => i.id === r1.id);
  assert.equal(item.reporter.id, f.guest);
  assert.equal(item.target_user.id, f.carol);
  assert.equal(item.message.body, 'private rudeness', 'the admin sees the reported text in a channel they cannot read');
  assert.equal(item.channel.id, f.grants);
  assert.equal(item.channel.member, false);
  const userItem = list.items.find((i) => i.id === r2.id);
  assert.equal(userItem.message, null);
  assert.equal(userItem.channel, null);
  const page = await db.call(f.admin, 'list_reports', { p_org: f.org, p_limit: 1, p_offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.equal((await db.call(f.owner, 'list_reports', { p_org: f.org, p_status: 'dismissed' })).total, 0);
  assert.equal((await db.call(f.owner, 'list_reports', { p_org: f.org, p_status: null })).total, 2);
  await expectError(db.call(f.owner, 'list_reports', { p_org: f.org, p_status: 'closed' }), 'invalid_input');
  await expectError(db.call(f.alice, 'list_reports', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.guest, 'list_reports', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.suspended, 'list_reports', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'list_reports', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_reports', { p_org: f.org }), 'not_found');
}));

test('resolve_report: dismiss, remove_message (moderation delete), suspend_user, remove_user; audited', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await db.message(f.general, f.alice, 'the offending text');
  const rBob = await db.call(f.bob, 'report', { p_kind: 'message', p_org: f.org, p_message: m.id, p_reason: 'spam' });
  const rAdmin = await db.call(f.admin, 'report', { p_kind: 'message', p_org: f.org, p_message: m.id, p_reason: 'spam' });
  const before = await mark(db);
  const res = await db.call(f.owner, 'resolve_report', { p_report: rBob.id, p_action: 'remove_message', p_note: 'Spam link' });
  assert.equal(res.status, 'actioned');
  assert.equal(res.resolution, 'remove_message: Spam link');
  assert.equal(res.resolved_by, f.owner);
  assert.equal(res.message.body, '');
  assert.ok(res.message.deleted_at);
  const msg = await db.one('select body, deleted_at, deleted_by from dek.messages where id = $1', [m.id]);
  assert.equal(msg.body, '');
  assert.equal(msg.deleted_by, f.owner);
  const removed = await auditRows(db, f.org, 'message.removed');
  assert.equal(removed[0].details.body, 'the offending text', 'the original text is kept for review');
  assert.ok((await since(db, before, { event: 'msg.upd', topic: `s:${f.medical}` })).length >= 1);
  assert.equal((await db.one('select status from dek.reports where id = $1', [rAdmin.id])).status, 'actioned',
    'the other report of the same message is answered too');
  assert.equal((await auditRows(db, f.org, 'report.resolved'))[0].details.action, 'remove_message');
  await expectError(db.call(f.owner, 'resolve_report', { p_report: rBob.id, p_action: 'dismiss' }), 'conflict');

  const d = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.carol, p_reason: 'other' });
  await expectError(db.call(f.admin, 'resolve_report', { p_report: d.id, p_action: 'remove_message' }), 'invalid_input');
  assert.equal((await db.call(f.admin, 'resolve_report', { p_report: d.id, p_action: 'dismiss' })).status, 'dismissed');

  const s = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.bob, p_reason: 'harassment' });
  const b2 = await mark(db);
  await db.call(f.admin, 'resolve_report', { p_report: s.id, p_action: 'suspend_user', p_note: 'Cooling off' });
  assert.deepEqual(await orgMember(db, f.org, f.bob), { role: 'member', status: 'suspended', suspended_reason: 'Cooling off' });
  assert.equal((await since(db, b2, { event: 'access.revoked', topic: `u:${f.bob}` }))[0].payload.scope, 'org');

  const x = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.carol, p_reason: 'spam' });
  await db.call(f.admin, 'resolve_report', { p_report: x.id, p_action: 'remove_user' });
  assert.equal(await orgMember(db, f.org, f.carol), undefined);
  const gone = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.guest, p_reason: 'spam' });
  await db.call(f.admin, 'remove_org_member', { p_org: f.org, p_user: f.guest });
  await expectError(db.call(f.admin, 'resolve_report', { p_report: gone.id, p_action: 'suspend_user' }), 'conflict');

  // rank rules hold through reports too
  const o = await db.call(f.alice, 'report', { p_kind: 'user', p_org: f.org, p_user: f.owner, p_reason: 'spam' });
  await expectError(db.call(f.admin, 'resolve_report', { p_report: o.id, p_action: 'suspend_user' }), 'forbidden');
  await expectError(db.call(f.admin, 'resolve_report', { p_report: o.id, p_action: 'remove_user' }), 'forbidden');
  await expectError(db.call(f.admin, 'resolve_report', { p_report: o.id, p_action: 'ban' }), 'invalid_input');
  await expectError(db.call(f.alice, 'resolve_report', { p_report: o.id, p_action: 'dismiss' }), 'forbidden');
  await expectError(db.call(f.suspended, 'resolve_report', { p_report: o.id, p_action: 'dismiss' }), 'suspended');
  await expectError(db.call(f.eve, 'resolve_report', { p_report: o.id, p_action: 'dismiss' }), 'not_found');
  await expectError(db.call(f.stranger, 'resolve_report', { p_report: o.id, p_action: 'dismiss' }), 'not_found');
}));

test('block_user and list_blocks: blocks stop 1:1 DMs both ways; only people who share an org', () => tx(async (db) => {
  const f = await db.fixture();
  assert.deepEqual(await db.call(f.alice, 'block_user', { p_user: f.bob, p_blocked: true }), { user_id: f.bob, blocked: true });
  assert.deepEqual(await db.call(f.alice, 'block_user', { p_user: f.bob, p_blocked: true }), { user_id: f.bob, blocked: true });
  await db.call(f.alice, 'block_user', { p_user: f.guest, p_blocked: true });
  const list = await db.call(f.alice, 'list_blocks');
  assert.deepEqual(list.items.map((p) => p.id).sort(), [f.bob, f.guest].sort());
  assert.equal(list.items[0].display_name.length > 0, true);
  await expectError(db.safe('select dek.assert_post($1, $2)', [f.bob, f.dmAliceBob]), 'blocked');
  await expectError(db.safe('select dek.assert_post($1, $2)', [f.alice, f.dmAliceBob]), 'blocked');
  assert.deepEqual(await db.call(f.alice, 'block_user', { p_user: f.bob, p_blocked: false }), { user_id: f.bob, blocked: false });
  await db.safe('select dek.assert_post($1, $2)', [f.bob, f.dmAliceBob]);
  assert.deepEqual((await db.call(f.alice, 'list_blocks')).items.map((p) => p.id), [f.guest]);
  assert.deepEqual((await db.call(f.bob, 'list_blocks')).items, []);

  await expectError(db.call(f.alice, 'block_user', { p_user: f.alice, p_blocked: true }), 'invalid_input');
  await expectError(db.call(f.alice, 'block_user', { p_user: f.bob, p_blocked: null }), 'invalid_input');
  await expectError(db.call(f.alice, 'block_user', { p_user: f.eve, p_blocked: true }), 'not_found');
  await expectError(db.call(f.eve, 'block_user', { p_user: f.alice, p_blocked: true }), 'not_found');
  await expectError(db.call(f.stranger, 'block_user', { p_user: f.alice, p_blocked: true }), 'not_found');
  assert.deepEqual(await db.call(f.stranger, 'block_user', { p_user: f.alice, p_blocked: false }),
    { user_id: f.alice, blocked: false }, 'unblocking reveals nothing and needs no shared org');
  assert.deepEqual((await db.call(f.stranger, 'list_blocks')).items, []);
  await expectError(db.call(null, 'list_blocks'));
}));

test('list_audit: org admins page through actions newest first; rows of one transaction never split', () => tx(async (db) => {
  const f = await db.fixture();
  await db.call(f.admin, 'update_org', { p_org: f.org, p_patch: { name: 'Audited' } });
  const first = await db.call(f.owner, 'list_audit', { p_org: f.org });
  assert.equal(first.has_more, false);
  assert.equal(first.items.length, 1);
  assert.deepEqual(Object.keys(first.items[0]).sort(),
    ['action', 'actor', 'created_at', 'details', 'id', 'target_id', 'target_type']);
  assert.equal(first.items[0].action, 'org.updated');
  assert.equal(first.items[0].actor.id, f.admin);
  assert.equal(first.items[0].target_id, f.org);

  // five older rows a minute apart, and three that share one timestamp
  for (let i = 1; i <= 5; i += 1) {
    await db.q(`insert into dek.audit_log (org_id, actor_id, action, target_type, created_at)
                values ($1, $2, $3, 'test', now() - make_interval(mins => $4))`, [f.org, f.owner, `test.${i}`, i * 10]);
  }
  for (const a of ['tie.a', 'tie.b', 'tie.c']) {
    await db.q(`insert into dek.audit_log (org_id, actor_id, action, target_type, created_at)
                values ($1, null, $2, 'test', now() - interval '25 minutes')`, [f.org, a]);
  }
  const p1 = await db.call(f.owner, 'list_audit', { p_org: f.org, p_limit: 3 });
  assert.deepEqual(p1.items.map((i) => i.action), ['org.updated', 'test.1', 'test.2']);
  assert.equal(p1.has_more, true);
  const p2 = await db.call(f.owner, 'list_audit', { p_org: f.org, p_limit: 2, p_before: p1.items[2].created_at });
  assert.deepEqual(p2.items.map((i) => i.action).sort(), ['tie.a', 'tie.b', 'tie.c'],
    'the boundary rows that share a timestamp all come on this page');
  assert.equal(p2.items[0].actor, null);
  const p3 = await db.call(f.owner, 'list_audit', { p_org: f.org, p_limit: 50, p_before: p2.items[2].created_at });
  assert.deepEqual(p3.items.map((i) => i.action), ['test.3', 'test.4', 'test.5']);
  assert.equal(p3.has_more, false);
  assert.equal((await db.call(f.owner, 'list_audit', { p_org: f.org, p_limit: 100000 })).items.length, 9);

  await expectError(db.call(f.alice, 'list_audit', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.guest, 'list_audit', { p_org: f.org }), 'forbidden');
  await expectError(db.call(f.suspended, 'list_audit', { p_org: f.org }), 'suspended');
  await expectError(db.call(f.eve, 'list_audit', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'list_audit', { p_org: f.org }), 'not_found');
}));
