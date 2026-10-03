// History, threads, deep links and reconnect sync: api.list_messages,
// list_messages_around, get_message_context, list_thread, sync_channel.
// Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, seqs, expectAnonDenied } from './msg-lib.mjs';

// n messages in one statement, seq allocated the real way, bodies m1..mn,
// last updated an hour ago (so later changes in the test stand out).
async function bulk(db, channel, author, n, { root = null, prefix = 'm' } = {}) {
  return db.q(
    `insert into dek.messages (org_id, channel_id, seq, author_id, body, thread_root_id, in_timeline,
                               created_at, updated_at)
     select c.org_id, c.id, dek.allocate_seq(c.id, $4::uuid is null), $2, $5 || g, $4, $4::uuid is null,
            now() - interval '1 hour' + g * interval '1 millisecond', now() - interval '1 hour'
       from dek.channels c, generate_series(1, $3::int) g
      where c.id = $1
      order by g
     returning id, seq, body`,
    [channel, author, n, root, prefix]);
}

test('history: list_messages pages newest first, each page ascending, with has_more and last_seq (DEK08)', () => tx(async (db) => {
  const f = await db.fixture();
  await bulk(db, f.general, f.bob, 120);
  const p1 = await db.call(f.alice, 'list_messages', { p_channel: f.general });
  assert.equal(p1.messages.length, 50);
  assert.equal(p1.messages[0].body, 'm71');
  assert.equal(p1.messages[49].body, 'm120');
  assert.deepEqual(seqs(p1.messages), Array.from({ length: 50 }, (_, i) => 71 + i));
  assert.equal(p1.has_more, true);
  assert.equal(p1.last_seq, 120);
  const p2 = await db.call(f.alice, 'list_messages', { p_channel: f.general, p_before_seq: p1.messages[0].seq });
  assert.equal(p2.messages[0].body, 'm21');
  assert.equal(p2.messages.at(-1).body, 'm70');
  assert.equal(p2.has_more, true);
  const p3 = await db.call(f.alice, 'list_messages', { p_channel: f.general, p_before_seq: p2.messages[0].seq });
  assert.deepEqual(p3.messages.map((m) => m.body), Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
  assert.equal(p3.has_more, false);
  const big = await db.call(f.alice, 'list_messages', { p_channel: f.general, p_limit: 500 });
  assert.equal(big.messages.length, 100, 'page size is capped at 100');
  const tiny = await db.call(f.alice, 'list_messages', { p_channel: f.general, p_limit: 0 });
  assert.equal(tiny.messages.length, 1);
  const empty = await db.call(f.alice, 'list_messages', { p_channel: f.grants });
  assert.deepEqual(empty, { messages: [], has_more: false, last_seq: 0 });
}));

test('history: list_messages_around centres a page on a sequence number', () => tx(async (db) => {
  const f = await db.fixture();
  await bulk(db, f.general, f.bob, 30);
  const mid = await db.call(f.alice, 'list_messages_around', { p_channel: f.general, p_seq: 15, p_limit: 10 });
  assert.deepEqual(seqs(mid.messages), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(mid.has_more_before, true);
  assert.equal(mid.has_more_after, true);
  assert.equal(mid.last_seq, 30);
  const start = await db.call(f.alice, 'list_messages_around', { p_channel: f.general, p_seq: 2, p_limit: 10 });
  assert.deepEqual(seqs(start.messages), [1, 2, 3, 4, 5, 6]);
  assert.equal(start.has_more_before, false);
  assert.equal(start.has_more_after, true);
  const end = await db.call(f.alice, 'list_messages_around', { p_channel: f.general, p_seq: 30, p_limit: 10 });
  assert.deepEqual(seqs(end.messages), [25, 26, 27, 28, 29, 30]);
  assert.equal(end.has_more_after, false);
  await expectError(db.call(f.alice, 'list_messages_around', { p_channel: f.general, p_seq: null }), 'invalid_input');
}));

test('history: get_message_context gives channel, message and thread root; not_found for anything unreadable', () => tx(async (db) => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'root');
  const reply = await send(db, f.bob, f.general, 'reply', { p_thread_root: root.id });
  const ctx = await db.call(f.owner, 'get_message_context', { p_message: reply.id });
  assert.equal(ctx.channel.id, f.general);
  assert.equal(ctx.channel.name, 'general');
  assert.equal(ctx.message.id, reply.id);
  assert.equal(ctx.thread_root.id, root.id);
  const top = await db.call(f.owner, 'get_message_context', { p_message: root.id });
  assert.equal(top.thread_root, null);
  const secret = await send(db, f.owner, f.secret, 'leadership only');
  await expectError(db.call(f.alice, 'get_message_context', { p_message: secret.id }), 'not_found');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'get_message_context', { p_message: reply.id }), 'not_found');
  }
  const eves = await send(db, f.eve, f.otherChannel, 'safalta');
  await expectError(db.call(f.alice, 'get_message_context', { p_message: eves.id }), 'not_found');
  await expectAnonDenied(db.call(null, 'get_message_context', { p_message: reply.id }));
  // a deleted message still resolves, as a tombstone
  await db.call(f.bob, 'delete_message', { p_message: reply.id });
  const gone = await db.call(f.owner, 'get_message_context', { p_message: reply.id });
  assert.equal(gone.message.body, '');
  assert.ok(gone.message.deleted_at);
}));

test('history: list_thread returns the root and replies ascending, paged by seq, with follow state', () => tx(async (db) => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'root');
  await bulk(db, f.general, f.bob, 120, { root: root.id, prefix: 'r' });
  await db.q('update dek.messages set reply_count = 120 where id = $1', [root.id]);
  await send(db, f.owner, f.general, 'top level in between');
  const t1 = await db.call(f.alice, 'list_thread', { p_root: root.id });
  assert.equal(t1.root.id, root.id);
  assert.equal(t1.replies.length, 100);
  assert.equal(t1.replies[0].body, 'r1');
  assert.equal(t1.has_more, true);
  assert.equal(t1.following, false);
  assert.equal(t1.last_read_reply_seq, 0);
  const t2 = await db.call(f.alice, 'list_thread', { p_root: root.id, p_after_seq: t1.replies.at(-1).seq });
  assert.deepEqual(t2.replies.map((r) => r.body), Array.from({ length: 20 }, (_, i) => `r${101 + i}`));
  assert.equal(t2.has_more, false);
  const mine = await send(db, f.alice, f.general, 'my reply', { p_thread_root: root.id });
  const t3 = await db.call(f.alice, 'list_thread', { p_root: root.id, p_after_seq: t1.replies.at(-1).seq, p_limit: 5 });
  assert.equal(t3.replies.length, 5);
  assert.equal(t3.following, true);
  assert.equal(t3.last_read_reply_seq, mine.seq);
  await expectError(db.call(f.alice, 'list_thread', { p_root: t1.replies[0].id }), 'invalid_input');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'list_thread', { p_root: root.id }), 'not_found');
  }
}));

test('sync: new after the cursor (timeline and replies), changed inside the held window (DEK07)', () => tx(async (db) => {
  const f = await db.fixture();
  const held = await bulk(db, f.general, f.bob, 5);
  const since = (await db.one("select now() - interval '1 minute' as t")).t.toISOString();
  await db.call(f.bob, 'edit_message', { p_message: held[1].id, p_body: 'm2 edited' });
  await db.call(f.alice, 'toggle_reaction', { p_message: held[3].id, p_emoji: '👀', p_on: true });
  await db.call(f.bob, 'delete_message', { p_message: held[4].id });
  const n6 = await send(db, f.alice, f.general, 'six');
  const n7 = await send(db, f.owner, f.general, 'reply', { p_thread_root: held[0].id });
  const s = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 5, p_changed_since: since, p_min_seq: 1 });
  assert.deepEqual(s.new.map((m) => m.id), [n6.id, n7.id], 'replies are included');
  assert.deepEqual(s.changed.map((m) => m.body), ['m1', 'm2 edited', 'm4', ''],
    'edit, reaction, delete, and the root whose reply count moved');
  assert.equal(s.last_seq, 7);
  assert.equal(s.truncated, false);
  const narrow = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 5, p_changed_since: since, p_min_seq: 3 });
  assert.deepEqual(seqs(narrow.changed), [4, 5]);
  const fresh = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 7, p_changed_since: new Date(Date.now() + 3600e3).toISOString() });
  assert.deepEqual(fresh, { new: [], changed: [], last_seq: 7, truncated: false });
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'sync_channel', { p_channel: f.general, p_after_seq: 0, p_changed_since: since }), 'not_found');
  }
}));

test('sync: more than 200 new or changed rows sets truncated; a wide held window walks changes by time', () => tx(async (db) => {
  const f = await db.fixture();
  const rows = await bulk(db, f.general, f.bob, 1300);
  const since = (await db.one("select now() - interval '1 minute' as t")).t.toISOString();
  const s = await db.call(f.alice, 'sync_channel', { p_channel: f.general, p_after_seq: 1000, p_changed_since: since });
  assert.equal(s.new.length, 200);
  assert.equal(s.new[0].seq, 1001);
  assert.equal(s.truncated, true);
  await db.q('update dek.messages set updated_at = now() where id = any($1::uuid[])',
    [[rows[9].id, rows[499].id, rows[1199].id]]);
  const wide = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 1300, p_changed_since: since, p_min_seq: 0 });
  assert.deepEqual(seqs(wide.changed), [10, 500, 1200]);
  assert.equal(wide.truncated, false);
  const window = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 1300, p_changed_since: since, p_min_seq: 600 });
  assert.deepEqual(seqs(window.changed), [1200]);
  await db.q('update dek.messages set updated_at = now() where channel_id = $1 and seq <= 300', [f.general]);
  const many = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 1300, p_changed_since: since });
  assert.equal(many.changed.length, 200);
  assert.equal(many.truncated, true);
}));

test('history: every reader function refuses strangers, the other tenant, guests and suspended members', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.alice, f.general, 'x');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'list_messages', { p_channel: f.general }), 'not_found');
    await expectError(db.call(u, 'list_messages_around', { p_channel: f.general, p_seq: 1 }), 'not_found');
  }
  await expectError(db.call(f.alice, 'list_messages', { p_channel: f.otherChannel }), 'not_found');
  await expectError(db.call(f.alice, 'list_messages', { p_channel: null }), 'not_found');
  await expectAnonDenied(db.call(null, 'list_messages', { p_channel: f.general }));
  // the guest reads the private channel she was added to
  const g = await db.call(f.guest, 'list_messages', { p_channel: f.grants });
  assert.deepEqual(g.messages, []);
}));
