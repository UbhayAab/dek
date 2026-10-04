// Foundation invariants: grants, the access matrix, topic and file authorization,
// sequence allocation, fanout, rate limits. Owner: lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';

const canRead = async (db, uid, ch) =>
  (await db.one('select dek.can_read_channel($1, $2) as ok', [uid, ch])).ok;

test('grants: nothing in dek or dek_meta is callable by API roles except the policy helpers', () => tx(async (db) => {
  const rows = await db.q(`
    select n.nspname, p.proname, r.rolname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
     where n.nspname in ('dek', 'dek_meta')
       and has_function_privilege(r.rolname, p.oid, 'execute')`);
  const allowed = new Set(['can_use_topic', 'can_read_object', 'can_write_object']);
  const bad = rows.filter((r) => !(r.nspname === 'dek' && allowed.has(r.proname) && r.rolname === 'authenticated'));
  assert.deepEqual(bad, [], `unexpected EXECUTE grants: ${JSON.stringify(bad)}`);
}));

test('grants: no API role can read or write a dek table directly', () => tx(async (db) => {
  const rows = await db.q(`
    select c.relname, r.rolname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
     where n.nspname in ('dek', 'dek_meta') and c.relkind in ('r', 'v', 'm')
       and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
            or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete'))`);
  assert.deepEqual(rows, []);
}));

test('grants: every api function is security definer with an empty search_path; svc_ only for service_role', () => tx(async (db) => {
  const rows = await db.q(`
    select p.proname, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authed,
           has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api'`);
  for (const r of rows) {
    assert.ok(r.prosecdef, `${r.proname} must be security definer`);
    assert.ok((r.proconfig ?? []).some((c) => c === 'search_path=""' || c === 'search_path='),
      `${r.proname} must set search_path = ''`);
    if (r.proname.startsWith('svc_')) {
      assert.ok(r.svc && !r.authed && !r.anon, `${r.proname} must be service_role only`);
    } else {
      assert.ok(r.authed, `${r.proname} must be executable by authenticated`);
      assert.equal(r.anon, ['preview_invite', 'report_client_error'].includes(r.proname), `${r.proname} anon grant`);
    }
  }
}));

test('access matrix: who can read which channel', () => tx(async (db) => {
  const f = await db.fixture();
  // public channel of Medical: server members yes; suspended, carol (not in server),
  // guest, other tenant, stranger no
  assert.equal(await canRead(db, f.alice, f.general), true);
  assert.equal(await canRead(db, f.owner, f.general), true);
  assert.equal(await canRead(db, f.suspended, f.general), false, 'suspended member');
  assert.equal(await canRead(db, f.carol, f.general), false, 'cross-team contributor sees only her channel (DEKA04)');
  assert.equal(await canRead(db, f.guest, f.general), false, 'guest');
  assert.equal(await canRead(db, f.eve, f.general), false, 'other tenant (DEKA05)');
  assert.equal(await canRead(db, f.stranger, f.general), false, 'stranger');
  // private Grants: its members only, including the cross-team member and the guest
  assert.equal(await canRead(db, f.alice, f.grants), true);
  assert.equal(await canRead(db, f.carol, f.grants), true);
  assert.equal(await canRead(db, f.guest, f.grants), true);
  assert.equal(await canRead(db, f.bob, f.grants), false, 'server member not in the private channel');
  assert.equal(await canRead(db, f.admin, f.grants), false, 'org admin is not automatically in private channels');
  // a private channel carol was never added to in the same host server stays hidden
  assert.equal(await canRead(db, f.carol, f.secret), false);
  // DM: its two members only
  assert.equal(await canRead(db, f.alice, f.dmAliceBob), true);
  assert.equal(await canRead(db, f.carol, f.dmAliceBob), false);
  // the other org's channel
  assert.equal(await canRead(db, f.eve, f.otherChannel), true);
  assert.equal(await canRead(db, f.alice, f.otherChannel), false);
}));

test('access: leaving a server removes public channel access at once (DEKA06)', () => tx(async (db) => {
  const f = await db.fixture();
  assert.equal(await canRead(db, f.bob, f.general), true);
  await db.q('delete from dek.server_members where server_id = $1 and user_id = $2', [f.medical, f.bob]);
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.general, f.bob]);
  assert.equal(await canRead(db, f.bob, f.general), false);
}));

test('moderation rights', () => tx(async (db) => {
  const f = await db.fixture();
  const mod = async (u, c) => (await db.one('select dek.can_moderate_channel($1, $2) as ok', [u, c])).ok;
  assert.equal(await mod(f.owner, f.general), true, 'server admin');
  assert.equal(await mod(f.admin, f.general), true, 'org admin');
  assert.equal(await mod(f.alice, f.general), false, 'plain member');
  assert.equal(await mod(f.alice, f.grants), true, 'channel owner');
  assert.equal(await mod(f.eve, f.general), false, 'other tenant admin');
}));

test('post rules: archived, announcement, block', () => tx(async (db) => {
  const f = await db.fixture();
  const post = (u, c, reply = false) => db.safe('select dek.assert_post($1, $2, $3)', [u, c, reply]);
  await post(f.alice, f.general);
  await db.q("update dek.channels set posting_policy = 'admins' where id = $1", [f.general]);
  await expectError(post(f.alice, f.general), 'forbidden');
  await post(f.alice, f.general, true);           // replies allowed by default
  await post(f.owner, f.general);                 // server admin may post
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.general]);
  await expectError(post(f.owner, f.general), 'archived');
  await post(f.alice, f.dmAliceBob);
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  await expectError(post(f.alice, f.dmAliceBob), 'blocked');
  await expectError(post(f.eve, f.general), 'not_found');
}));

test('realtime topics: personal, server, view and call', () => tx(async (db) => {
  const f = await db.fixture();
  const can = async (uid, topic, mode = 'read', ext = 'broadcast') =>
    (await db.as(uid, 'select dek.can_use_topic($1, $2, $3) as ok', [topic, mode, ext]))[0].ok;
  assert.equal(await can(f.alice, `u:${f.alice}`), true);
  assert.equal(await can(f.alice, `u:${f.bob}`), false, 'someone else\'s inbox');
  assert.equal(await can(f.alice, `u:${f.alice}`, 'write'), false, 'clients never send to u:');
  assert.equal(await can(f.alice, `s:${f.medical}`), true);
  assert.equal(await can(f.alice, `s:${f.medical}`, 'write'), false);
  assert.equal(await can(f.carol, `s:${f.medical}`), false, 'cross-team member gets no server topic');
  assert.equal(await can(f.guest, `s:${f.medical}`), false);
  assert.equal(await can(f.eve, `s:${f.medical}`), false);
  assert.equal(await can(f.suspended, `s:${f.medical}`), false);
  assert.equal(await can(f.carol, `t:${f.grants}`, 'write'), true);
  assert.equal(await can(f.bob, `t:${f.grants}`), false);
  assert.equal(await can(f.alice, 's:not-a-uuid'), false);
  assert.equal(await can(f.alice, `x:${f.medical}`), false);
  const call = await db.one(
    "insert into dek.calls (org_id, channel_id, kind, started_by) values ($1, $2, 'direct', $3) returning id",
    [f.org, f.dmAliceBob, f.alice]);
  await db.q("insert into dek.call_participants (call_id, user_id, state) values ($1, $2, 'joined'), ($1, $3, 'ringing')",
    [call.id, f.alice, f.bob]);
  // 0900: joined participants send signals; a ringing callee may only listen until it answers
  assert.equal(await can(f.alice, `call:${call.id}`, 'write', 'broadcast'), true);
  assert.equal(await can(f.bob, `call:${call.id}`, 'read', 'broadcast'), true);
  assert.equal(await can(f.bob, `call:${call.id}`, 'write', 'broadcast'), false);
  assert.equal(await can(f.carol, `call:${call.id}`), false);
  await db.q("update dek.call_participants set state = 'joined' where call_id = $1 and user_id = $2", [call.id, f.bob]);
  assert.equal(await can(f.bob, `call:${call.id}`, 'write', 'broadcast'), true);
}));

test('storage: objects readable only when ready and the channel is readable; uploads only by the reserver', () => tx(async (db) => {
  const f = await db.fixture();
  const att = await db.one(
    `insert into dek.attachments (org_id, channel_id, uploader_id, object_path, file_name, declared_mime, mime_type, size_bytes)
     values ($1, $2, $3, 'x', 'photo.jpg', 'image/jpeg', 'image/jpeg', 100) returning id`,
    [f.org, f.grants, f.alice]);
  const path = `${f.org}/${f.grants}/${att.id}/photo.jpg`;
  await db.q('update dek.attachments set object_path = $2, thumb_path = $3 where id = $1',
    [att.id, path, `${f.org}/${f.grants}/${att.id}/thumb.webp`]);
  const read = async (u, p) => (await db.as(u, 'select dek.can_read_object($1) as ok', [p]))[0].ok;
  const write = async (u, p) => (await db.as(u, 'select dek.can_write_object($1) as ok', [p]))[0].ok;
  assert.equal(await write(f.alice, path), true, 'reserver uploads while pending');
  assert.equal(await write(f.bob, path), false, 'nobody else');
  assert.equal(await read(f.carol, path), false, 'pending is never readable');
  await db.q("update dek.attachments set status = 'ready' where id = $1", [att.id]);
  assert.equal(await write(f.alice, path), false, 'no overwrite after ready');
  assert.equal(await read(f.carol, path), true);
  assert.equal(await read(f.carol, `${f.org}/${f.grants}/${att.id}/thumb.webp`), true);
  assert.equal(await read(f.bob, path), false, 'not a member of grants');
  assert.equal(await read(f.eve, path), false, 'other tenant guessing the path (DEKA05)');
  assert.equal(await read(f.carol, `${f.org}/${f.grants}/${att.id}/other.jpg`), false, 'unknown name');
  assert.equal(await read(f.carol, '../../etc/passwd'), false);
}));

test('sequence: gapless per channel, timeline cursor separate from replies', () => tx(async (db) => {
  const f = await db.fixture();
  const a = await db.message(f.general, f.alice, 'one');
  const b = await db.message(f.general, f.bob, 'two');
  const r = await db.message(f.general, f.alice, 'reply', { root: a.id });
  const other = await db.message(f.grants, f.alice, 'elsewhere');
  assert.deepEqual([Number(a.seq), Number(b.seq), Number(r.seq)], [1, 2, 3]);
  assert.equal(Number(other.seq), 1);
  const st = await db.one('select last_seq, last_top_seq from dek.channel_state where channel_id = $1', [f.general]);
  assert.equal(Number(st.last_seq), 3);
  assert.equal(Number(st.last_top_seq), 2);
}));

test('emit: public channel goes to the server topic plus non-server members; private fans out per member', () => tx(async (db) => {
  const f = await db.fixture();
  await db.channelMember(f.general, f.carol);   // a cross-team member in a public channel
  const before = await db.one('select count(*)::int n from realtime.messages');
  await db.q("select dek.emit_channel($1, 'test.event', '{}'::jsonb)", [f.general]);
  const pub = await db.q(
    "select topic from realtime.messages where event = 'test.event' order by topic");
  assert.deepEqual(pub.map((r) => r.topic).sort(), [`s:${f.medical}`, `u:${f.carol}`].sort());
  await db.q("select dek.emit_channel($1, 'test.private', '{}'::jsonb)", [f.grants]);
  const priv = await db.q("select topic from realtime.messages where event = 'test.private'");
  assert.deepEqual(priv.map((r) => r.topic).sort(), [`u:${f.alice}`, `u:${f.carol}`, `u:${f.guest}`].sort());
  const after = await db.one('select count(*)::int n from realtime.messages');
  assert.equal(after.n - before.n, 5);
}));

test('rate limit: the call after the limit raises rate_limited', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 0; i < 3; i += 1) await db.q("select dek.rate_hit($1, 'unit', 3, 60)", [f.alice]);
  await expectError(db.safe("select dek.rate_hit($1, 'unit', 3, 60)", [f.alice]), 'rate_limited');
}));

test('new auth user gets a profile and default notification prefs', () => tx(async (db) => {
  const u = await db.user('Priya Sharma');
  const p = await db.one('select display_name from dek.profiles where id = $1', [u]);
  assert.equal(p.display_name, 'Priya Sharma');
  const n = await db.one('select default_level, dm_level, preview from dek.notification_prefs where user_id = $1', [u]);
  assert.deepEqual(n, { default_level: 'mentions', dm_level: 'all', preview: 'full' });
}));
