// api.edit_message, api.delete_message, api.toggle_reaction. Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, events, fillRate, messageRow, expectAnonDenied } from './msg-lib.mjs';

const mentionRows = async (db, id) =>
  (await db.q('select user_id, created_at from dek.mentions where message_id = $1 order by user_id', [id]));

// ------------------------------------------------------------------ edit

test('edit: the author edits; mentions are re-parsed and only new ones notify; msg.upd is broadcast', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, `hello <@${f.bob}>`);
  const before = await db.one('select created_at from dek.messages where id = $1', [m.id]);

  const e1 = await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: `hello <@${f.owner}> and <@${f.bob}>` });
  assert.ok(e1.edited_at, 'edited marker');
  assert.deepEqual(e1.mentions, [f.owner, f.bob]);
  const rows = await mentionRows(db, m.id);
  assert.deepEqual(rows.map((r) => r.user_id).sort(), [f.bob, f.owner].sort());
  assert.ok(rows.every((r) => r.created_at.getTime() === before.created_at.getTime()), 'dated like the message');
  const intents = await db.q(
    'select target_user_id from dek.notification_intents where message_id = $1 order by id', [m.id]);
  assert.deepEqual(intents.map((r) => r.target_user_id), [null, f.owner], 'one intent for the send, one targeted at the new mention');
  const upd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === m.id);
  assert.equal(upd.length, 1);
  assert.equal(upd[0].topic, `s:${f.medical}`);
  assert.equal(upd[0].payload.message.body, `hello <@${f.owner}> and <@${f.bob}>`);

  const e2 = await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'just text' });
  assert.deepEqual(e2.mentions, [], 'the message no longer names them');
  assert.deepEqual((await mentionRows(db, m.id)).map((r) => r.user_id).sort(), [f.bob, f.owner].sort(),
    'a mention, once made, stays in their mentions list');
  assert.equal((await db.q('select 1 from dek.notification_intents where message_id = $1', [m.id])).length, 2,
    'removing mentions notifies nobody');

  // same text again: no write, no broadcast (a retried edit)
  const n = (await events(db, 'msg.upd')).length;
  const e3 = await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: '  just text ' });
  assert.equal(e3.updated_at, e2.updated_at);
  assert.equal((await events(db, 'msg.upd')).length, n);

  // re-adding owner does not notify again; admin is new and gets one targeted intent
  await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: `<@${f.admin}> and <@${f.owner}> please` });
  const targeted = await db.q(
    'select target_user_id from dek.notification_intents where message_id = $1 order by id', [m.id]);
  assert.deepEqual(targeted.slice(2).map((r) => r.target_user_id), [f.admin]);
  await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'nobody' });
  await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: `<@${f.admin}> again` });
  assert.equal((await db.q('select 1 from dek.notification_intents where message_id = $1', [m.id])).length, 3,
    'removing and re-adding a mention never notifies twice');

  // <!channel> added by an edit: mention_all and one untargeted intent
  const e4 = await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'everyone <!channel>' });
  assert.equal(e4.mention_all, true);
  const last = await db.one(
    'select target_user_id from dek.notification_intents where message_id = $1 order by id desc limit 1', [m.id]);
  assert.equal(last.target_user_id, null);
}));

test('edit: only the author, only live messages, valid bodies; strangers and other tenants see nothing', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'original');
  await expectError(db.call(f.bob, 'edit_message', { p_message: m.id, p_body: 'hijack' }), 'forbidden');
  await expectError(db.call(f.owner, 'edit_message', { p_message: m.id, p_body: 'moderator edit' }), 'forbidden');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'edit_message', { p_message: m.id, p_body: 'x' }), 'not_found');
  }
  await expectAnonDenied(db.call(null, 'edit_message', { p_message: m.id, p_body: 'x' }));
  await expectError(db.call(f.alice, 'edit_message', { p_message: m.id, p_body: '   ' }), 'invalid_input');
  await expectError(db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'z'.repeat(8001) }), 'invalid_input');
  await db.call(f.alice, 'delete_message', { p_message: m.id });
  await expectError(db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'resurrect' }), 'conflict');
  assert.equal((await messageRow(db, m.id)).body, '');
}));

test('edit: the organization edit window, archived conversations and blocked DMs', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q(`update dek.orgs set settings = '{"edit_window_minutes": 5}' where id = $1`, [f.org]);
  const old = await send(db, f.alice, f.general, 'old');
  await db.q("update dek.messages set created_at = now() - interval '10 minutes' where id = $1", [old.id]);
  await expectError(db.call(f.alice, 'edit_message', { p_message: old.id, p_body: 'too late' }), 'forbidden');
  const fresh = await send(db, f.alice, f.general, 'fresh');
  const e = await db.call(f.alice, 'edit_message', { p_message: fresh.id, p_body: 'fresh, fixed' });
  assert.equal(e.body, 'fresh, fixed');

  const dm = await send(db, f.alice, f.dmAliceBob, 'hey');
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  await expectError(db.call(f.alice, 'edit_message', { p_message: dm.id, p_body: 'hey you' }), 'blocked');
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.general]);
  await expectError(db.call(f.alice, 'edit_message', { p_message: fresh.id, p_body: 'again' }), 'archived');
}));

test('edit: at most 20 targeted notifications per edit; edits are rate limited at 30 a minute', () => tx(async (db) => {
  const f = await db.fixture();
  const people = (await db.q(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
           'reader-' || g || '-' || substr(md5(random()::text), 1, 8) || '@dek-test.invalid', '', now(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
      from generate_series(1, 25) g
    returning id`)).map((r) => r.id);
  await db.q('insert into dek.org_members (org_id, user_id) select $1::uuid, unnest($2::uuid[])', [f.org, people]);
  await db.q(`insert into dek.server_members (server_id, user_id, org_id)
              select $1::uuid, unnest($2::uuid[]), $3::uuid`, [f.medical, people, f.org]);
  const m = await send(db, f.alice, f.general, 'draft');
  await db.call(f.alice, 'edit_message', { p_message: m.id, p_body: people.map((u) => `<@${u}>`).join(' ') });
  assert.equal((await db.q('select 1 from dek.mentions where message_id = $1', [m.id])).length, 25,
    'everyone named gets the mention');
  const targeted = await db.q(
    'select 1 from dek.notification_intents where message_id = $1 and target_user_id is not null', [m.id]);
  assert.equal(targeted.length, 20, 'one edit sends at most 20 targeted notifications');
  await fillRate(db, f.alice, 'edit', 30, 60);
  await expectError(db.call(f.alice, 'edit_message', { p_message: m.id, p_body: 'one more' }), 'rate_limited');
}));

// ------------------------------------------------------------------ delete

test('delete: an author deletes their own message: body purged, tombstone broadcast, no audit; idempotent', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, `secret <@${f.bob}>`);
  await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true });
  await db.call(f.bob, 'save_message', { p_message: m.id, p_saved: true });
  const d = await db.call(f.alice, 'delete_message', { p_message: m.id });
  assert.ok(d.deleted_at);
  assert.equal(d.body, '');
  assert.deepEqual(d.mentions, []);
  assert.deepEqual(d.reactions, {});
  const row = await messageRow(db, m.id);
  assert.equal(row.body, '', 'a self delete purges the text');
  assert.equal(row.deleted_by, f.alice);
  assert.equal((await db.q('select 1 from dek.mentions where message_id = $1', [m.id])).length, 0);
  assert.equal((await db.q('select 1 from dek.saved_messages where message_id = $1', [m.id])).length, 0);
  assert.equal((await db.q("select 1 from dek.audit_log where target_id = $1", [m.id])).length, 0);
  const upd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === m.id);
  assert.ok(upd.some((e) => e.payload.message.deleted_at));
  const again = await db.call(f.alice, 'delete_message', { p_message: m.id });
  assert.equal(again.deleted_at, d.deleted_at);
  const page = await db.call(f.bob, 'list_messages', { p_channel: f.general });
  assert.equal(page.messages.length, 0, 'a deleted message without replies leaves history');
}));

test('delete: moderators delete anyone\'s with the original kept in audit_log; plain members cannot', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.bob, f.general, 'abusive words');
  await expectError(db.call(f.alice, 'delete_message', { p_message: m.id }), 'forbidden');
  const d = await db.call(f.owner, 'delete_message', { p_message: m.id, p_reason: '  spam  ' });
  assert.ok(d.deleted_at);
  const audit = await db.one(
    "select actor_id, action, details from dek.audit_log where target_id = $1 and action = 'message.removed'", [m.id]);
  assert.equal(audit.actor_id, f.owner);
  assert.equal(audit.details.body, 'abusive words');
  assert.equal(audit.details.reason, 'spam');
  assert.equal(audit.details.author_id, f.bob);
  // the owner of a private channel moderates it
  const g = await send(db, f.carol, f.grants, 'off topic');
  await db.call(f.alice, 'delete_message', { p_message: g.id });
  // other tenants, strangers, guests and suspended members cannot even see it
  const live = await send(db, f.bob, f.general, 'live');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'delete_message', { p_message: live.id }), 'not_found');
  }
  await expectAnonDenied(db.call(null, 'delete_message', { p_message: live.id }));
}));

test('delete: a reply lowers the root count; a deleted root that anchors replies stays as a tombstone', () => tx(async (db) => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'root');
  const r1 = await send(db, f.bob, f.general, 'r1', { p_thread_root: root.id });
  await send(db, f.bob, f.general, 'r2', { p_thread_root: root.id });
  await db.call(f.bob, 'delete_message', { p_message: r1.id });
  assert.equal((await messageRow(db, root.id)).reply_count, 1);
  const rootUpd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === root.id);
  assert.equal(rootUpd.at(-1).payload.message.reply_count, 1);
  await db.call(f.alice, 'delete_message', { p_message: root.id });
  const page = await db.call(f.bob, 'list_messages', { p_channel: f.general });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, root.id);
  assert.equal(page.messages[0].body, '');
  assert.ok(page.messages[0].deleted_at, 'tombstone');
  const th = await db.call(f.bob, 'list_thread', { p_root: root.id });
  assert.deepEqual(th.replies.map((r) => r.body), ['r2']);
}));

test('delete: archived conversations: the author cannot, a moderator can', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.bob, f.general, 'archived soon');
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.general]);
  await expectError(db.call(f.bob, 'delete_message', { p_message: m.id }), 'archived');
  const d = await db.call(f.admin, 'delete_message', { p_message: m.id, p_reason: 'cleanup' });
  assert.ok(d.deleted_at);
}));

// ------------------------------------------------------------------ reactions

test('react: add and remove are idempotent; the map lists people in reaction order; msg.upd', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'react to me');
  let r = await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true });
  assert.deepEqual(r, { message_id: m.id, reactions: { '👍': [f.bob] } });
  await db.q("update dek.reactions set created_at = now() - interval '1 minute' where message_id = $1", [m.id]);
  r = await db.call(f.owner, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true });
  r = await db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: ' 🎉 ', p_on: true });
  assert.deepEqual(r.reactions['👍'], [f.bob, f.owner]);
  assert.deepEqual(r.reactions['🎉'], [f.alice]);
  const n = (await events(db, 'msg.upd')).length;
  r = await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true });
  assert.equal((await events(db, 'msg.upd')).length, n, 'no change, no broadcast');
  r = await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: false });
  assert.deepEqual(r.reactions, { '👍': [f.owner], '🎉': [f.alice] });
  r = await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: false });
  assert.deepEqual(r.reactions, { '👍': [f.owner], '🎉': [f.alice] });
  const row = await messageRow(db, m.id);
  assert.deepEqual(row.reactions, r.reactions, 'stored map matches');
  const upd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === m.id);
  assert.equal(upd.length, 4);
  assert.deepEqual(upd.at(-1).payload.message.reactions, r.reactions);
  const family = await db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👨‍👩‍👧', p_on: true });
  assert.deepEqual(family.reactions['👨‍👩‍👧'], [f.bob], 'joined emoji are one reaction');
}));

test('react: at most 20 different emoji per message, each 1 to 64 characters', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'many');
  await db.q(
    `insert into dek.reactions (message_id, emoji, user_id, channel_id, org_id, created_at)
     select $1, 'e' || g, $2, $3, $4, now() - interval '1 minute' from generate_series(1, 20) g`,
    [m.id, f.bob, f.general, f.org]);
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: 'e21', p_on: true }), 'invalid_input');
  const r = await db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: 'e7', p_on: true });
  assert.deepEqual(r.reactions.e7, [f.bob, f.alice], 'an existing emoji can still be added to');
  assert.equal(Object.keys(r.reactions).length, 20);
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: '', p_on: true }), 'invalid_input');
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: 'x'.repeat(65), p_on: true }), 'invalid_input');
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: 'a\nb', p_on: true }), 'invalid_input');
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: null }), 'invalid_input');
}));

test('react: channel settings, announcements, archives, deleted messages and blocked DMs', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.owner, f.general, 'announcement');
  await db.q("update dek.channels set posting_policy = 'admins' where id = $1", [f.general]);
  const r = await db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: '✅', p_on: true });
  assert.deepEqual(r.reactions['✅'], [f.alice], 'announcement channels still take reactions');
  await db.q('update dek.channels set allow_reactions = false where id = $1', [f.general]);
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: '❌', p_on: true }), 'forbidden');
  await db.q('update dek.channels set allow_reactions = true, archived_at = now() where id = $1', [f.general]);
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: m.id, p_emoji: '❌', p_on: true }), 'archived');
  const g = await send(db, f.carol, f.grants, 'soon gone');
  await db.call(f.carol, 'delete_message', { p_message: g.id });
  await expectError(db.call(f.alice, 'toggle_reaction', { p_message: g.id, p_emoji: '👍', p_on: true }), 'conflict');
  const dm = await send(db, f.alice, f.dmAliceBob, 'hi');
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.alice, f.bob]);
  await expectError(db.call(f.bob, 'toggle_reaction', { p_message: dm.id, p_emoji: '👍', p_on: true }), 'blocked');
}));

test('react: denied outside the channel; rate limit 60 per minute', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'react');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true }), 'not_found');
  }
  await expectAnonDenied(db.call(null, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true }));
  await fillRate(db, f.bob, 'react', 60, 60);
  await expectError(db.call(f.bob, 'toggle_reaction', { p_message: m.id, p_emoji: '👍', p_on: true }), 'rate_limited');
}));
