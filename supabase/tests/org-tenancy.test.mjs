// [org] tenancy sweeps: the other tenant and strangers (DEKA05), suspended members,
// plain members and guests on admin calls, and the shape of the function set itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx } from './_harness.mjs';
import { ORG_FUNCTIONS, events } from './org-lib.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every [org] call aimed at JCF, with the ids another tenant would have to guess.
function attacks(f, x) {
  return [
    ['update_org', { p_org: f.org, p_patch: { name: 'Pwned' } }],
    ['list_org_members', { p_org: f.org }],
    ['set_org_role', { p_org: f.org, p_user: f.alice, p_role: 'guest' }],
    ['suspend_org_member', { p_org: f.org, p_user: f.alice, p_suspended: true }],
    ['remove_org_member', { p_org: f.org, p_user: f.alice, p_ban: true }],
    ['leave_org', { p_org: f.org }],
    ['list_servers', { p_org: f.org }],
    ['create_server', { p_org: f.org, p_name: 'Pwned' }],
    ['update_server', { p_server: f.medical, p_patch: { name: 'Pwned' } }],
    ['archive_server', { p_server: f.medical, p_archived: true }],
    ['join_server', { p_server: x.open }],
    ['leave_server', { p_server: f.medical }],
    ['list_server_members', { p_server: f.medical }],
    ['add_server_members', { p_server: f.medical, p_user_ids: [f.alice] }],
    ['remove_server_member', { p_server: f.medical, p_user: f.alice }],
    ['set_server_role', { p_server: f.medical, p_user: f.alice, p_role: 'admin' }],
    ['list_channels', { p_server: f.medical }],
    ['create_channel', { p_server: f.medical, p_name: 'pwned' }],
    ['update_channel', { p_channel: f.grants, p_patch: { topic: 'pwned' } }],
    ['archive_channel', { p_channel: f.general, p_archived: true }],
    ['join_channel', { p_channel: f.general }],
    ['leave_channel', { p_channel: f.general }],
    ['add_channel_members', { p_channel: f.grants, p_user_ids: [f.alice] }],
    ['remove_channel_member', { p_channel: f.grants, p_user: f.carol }],
    ['list_channel_members', { p_channel: f.grants }],
    ['set_channel_notify', { p_channel: f.general, p_level: 'none' }],
    ['open_dm', { p_org: f.org, p_user_ids: [f.alice] }],
    ['hide_dm', { p_channel: f.dmAliceBob }],
    ['create_invite', { p_org: f.org, p_server: f.medical }],
    ['accept_invite', { p_code: 'GuessedGuessedGuessed1' }],
    ['list_invites', { p_org: f.org }],
    ['revoke_invite', { p_invite: x.invite }],
    ['list_join_requests', { p_org: f.org }],
    ['decide_join_request', { p_request: x.request, p_approve: true }],
    ['report', { p_kind: 'message', p_org: f.org, p_message: x.message, p_reason: 'spam' }],
    ['list_reports', { p_org: f.org }],
    ['resolve_report', { p_report: x.report, p_action: 'dismiss' }],
    ['list_audit', { p_org: f.org }],
    ['block_user', { p_user: f.alice, p_blocked: true }],
  ];
}

async function outcome(promise) {
  try {
    return { ok: await promise };
  } catch (e) {
    return { code: e.code, hint: e.hint };
  }
}

// The same call with every id swapped for one that does not exist.
function guessed(args) {
  const swap = (v) => (typeof v === 'string' && UUID.test(v) ? randomUUID() : v);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, Array.isArray(v) ? v.map(swap) : swap(v)]));
}

async function world(db) {
  const f = await db.fixture();
  const open = await db.server(f.org, 'Open Team', { joinPolicy: 'open' });
  const approval = await db.server(f.org, 'Approval Team', { joinPolicy: 'approval' });
  await db.call(f.bob, 'join_server', { p_server: approval });
  const request = (await db.one('select id from dek.join_requests where user_id = $1', [f.bob])).id;
  const inv = await db.call(f.admin, 'create_invite', { p_org: f.org, p_server: f.medical });
  const msg = await db.message(f.grants, f.alice, 'private');
  const rep = await db.call(f.carol, 'report', { p_kind: 'message', p_org: f.org, p_message: msg.id, p_reason: 'spam' });
  return { f, x: { open, request, invite: inv.id, code: inv.code, message: msg.id, report: rep.id } };
}

const SNAPSHOT = `select
  (select count(*) from dek.org_members where org_id = $1)::int as org_members,
  (select count(*) from dek.org_members where org_id = $1 and status = 'suspended')::int as suspended,
  (select count(*) from dek.org_bans where org_id = $1)::int as bans,
  (select count(*) from dek.server_members where org_id = $1)::int as server_members,
  (select string_agg(user_id::text || role, ',' order by server_id, user_id) from dek.server_members where org_id = $1) as roles,
  (select count(*) from dek.channel_members where org_id = $1)::int as channel_members,
  (select count(*) from dek.channel_members where org_id = $1 and (hidden or notify <> 'default'))::int as member_prefs,
  (select string_agg(coalesce(name, '') || coalesce(topic, '') || (archived_at is null)::text, ',' order by id)
     from dek.channels where org_id = $1) as channels,
  (select string_agg(name || (archived_at is null)::text, ',' order by id) from dek.servers where org_id = $1) as servers,
  (select count(*) from dek.invites where org_id = $1 and revoked_at is null)::int as live_invites,
  (select count(*) from dek.join_requests where org_id = $1 and status = 'pending')::int as pending_requests,
  (select count(*) from dek.reports where org_id = $1)::int as reports,
  (select count(*) from dek.reports where org_id = $1 and status = 'open')::int as open_reports,
  (select count(*) from dek.user_blocks)::int as blocks,
  (select count(*) from dek.audit_log where org_id = $1)::int as audit,
  (select name from dek.orgs where id = $1) as org_name`;

test('DEKA05: other tenant and strangers get not_found from every [org] call, identical to a guessed id', () => tx(async (db) => {
  const { f, x } = await world(db);
  const before = await db.one(SNAPSHOT, [f.org]);
  const eventsBefore = (await events(db)).length;
  const list = attacks(f, x);
  for (const [fn, args] of list) {
    for (const [who, uid] of [['eve', f.eve], ['stranger', f.stranger]]) {
      const real = await outcome(db.call(uid, fn, args));
      assert.equal(real.code, 'not_found', `${fn} as ${who}: ${JSON.stringify(real)}`);
      const fake = await outcome(db.call(uid, fn, guessed(args)));
      assert.deepEqual(real, fake, `${fn} as ${who}: a real id must look exactly like a made-up one`);
    }
  }
  assert.deepEqual(await db.one(SNAPSHOT, [f.org]), before, 'nothing in JCF changed');
  assert.equal((await events(db)).length, eventsBefore, 'nothing was broadcast');

  // the three calls that take no JCF id
  assert.equal((await outcome(db.call(f.eve, 'create_org', { p_name: 'X', p_slug: 'eve-x-org' }))).code, 'forbidden');
  assert.deepEqual((await db.call(f.eve, 'list_blocks')).items, []);
  const guess = await db.call(f.eve, 'preview_invite', { p_code: 'GuessedGuessedGuessed1' });
  assert.deepEqual([guess.valid, guess.reason, guess.org_name], [false, 'not_found', null]);

  const covered = new Set([...list.map(([fn]) => fn), 'create_org', 'list_blocks', 'preview_invite']);
  assert.deepEqual([...covered].sort(), [...ORG_FUNCTIONS].sort(), 'the sweep covers every [org] function');
}));

test('suspended members get "suspended" from every [org] call in their org, and change nothing', () => tx(async (db) => {
  const { f, x } = await world(db);
  const before = await db.one(SNAPSHOT, [f.org]);
  for (const [fn, args] of attacks(f, x)) {
    if (fn === 'block_user') continue;   // no org in the call: a suspended member shares no active org
    const call = fn === 'accept_invite' ? { p_code: x.code } : args;
    const r = await outcome(db.call(f.suspended, fn, call));
    assert.equal(r.code, 'suspended', `${fn}: ${JSON.stringify(r)}`);
  }
  assert.equal((await outcome(db.call(f.suspended, 'block_user', { p_user: f.alice, p_blocked: true }))).code, 'not_found');
  assert.deepEqual(await db.one(SNAPSHOT, [f.org]), before);
}));

test('plain members and guests are refused every admin call (forbidden, never success)', () => tx(async (db) => {
  const { f, x } = await world(db);
  const before = await db.one(SNAPSHOT, [f.org]);
  const adminCalls = [
    ['create_org', { p_name: 'X', p_slug: 'member-x-org' }],
    ['update_org', { p_org: f.org, p_patch: { name: 'X' } }],
    ['set_org_role', { p_org: f.org, p_user: f.carol, p_role: 'admin' }],
    ['suspend_org_member', { p_org: f.org, p_user: f.carol, p_suspended: true }],
    ['remove_org_member', { p_org: f.org, p_user: f.carol }],
    ['update_server', { p_server: f.medical, p_patch: { name: 'X' } }],
    ['archive_server', { p_server: f.medical, p_archived: true }],
    ['add_server_members', { p_server: f.medical, p_user_ids: [f.carol] }],
    ['remove_server_member', { p_server: f.medical, p_user: f.bob }],
    ['set_server_role', { p_server: f.medical, p_user: f.bob, p_role: 'admin' }],
    ['create_invite', { p_org: f.org }],
    ['list_join_requests', { p_org: f.org }],
    ['decide_join_request', { p_request: x.request, p_approve: true }],
    ['list_reports', { p_org: f.org }],
    ['resolve_report', { p_report: x.report, p_action: 'dismiss' }],
    ['list_audit', { p_org: f.org }],
  ];
  for (const [who, uid] of [['member', f.alice], ['guest', f.guest]]) {
    for (const [fn, args] of adminCalls) {
      const r = await outcome(db.call(uid, fn, args));
      assert.equal(r.code, 'forbidden', `${fn} as ${who}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(await db.one(SNAPSHOT, [f.org]), before);
}));

test('the [org] function set: one signature each, security definer, empty search_path, require_uid first', () => tx(async (db) => {
  const rows = await db.q(
    `select p.proname, p.prosecdef, p.proconfig, p.prosrc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = any ($1)`, [ORG_FUNCTIONS]);
  assert.deepEqual(rows.map((r) => r.proname).sort(), [...ORG_FUNCTIONS].sort(), 'exactly one overload per name');
  for (const r of rows) {
    assert.ok(r.prosecdef, `${r.proname} security definer`);
    assert.ok((r.proconfig ?? []).some((c) => c === 'search_path=""' || c === 'search_path='), `${r.proname} search_path`);
    if (r.proname === 'preview_invite') continue;   // anon: no user to require
    const body = r.prosrc.split(/\nbegin\n/)[1] ?? '';
    assert.equal(body.trim().split('\n')[0].trim(), 'v_uid := dek.require_uid();', `${r.proname}: require_uid first`);
  }
}));
