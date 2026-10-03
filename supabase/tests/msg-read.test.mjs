// Read state, threads, mentions and the unread feed: api.mark_read, mark_unread,
// mark_all_read, follow_thread, mark_thread_read, list_threads, list_mentions,
// unread_feed. Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, events, expectAnonDenied } from './msg-lib.mjs';

const readSeq = async (db, channel, user) =>
  Number((await db.one('select last_read_seq from dek.channel_members where channel_id = $1 and user_id = $2',
    [channel, user])).last_read_seq);

const channelFor = async (db, uid, channel) =>
  (await db.one('select dek.channel_json(c, $2) as j from dek.channels c where c.id = $1', [channel, uid])).j;

test('read: mark_read is monotonic, capped at the last seq, and tells only the caller\'s own devices (DEKA10)', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 1; i <= 5; i += 1) await send(db, f.bob, f.general, `b${i}`);
  assert.equal((await channelFor(db, f.alice, f.general)).unread, 5);
  const r1 = await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: 3 });
  assert.deepEqual(r1, { channel_id: f.general, last_read_seq: 3 });
  const ev = await events(db, 'read');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].topic, `u:${f.alice}`, 'only the reader\'s personal topic');
  assert.deepEqual({ ...ev[0].payload, id: undefined }, { channel_id: f.general, last_read_seq: 3, v: 1, id: undefined });
  const back = await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: 2 });
  assert.equal(back.last_read_seq, 3, 'never moves back');
  assert.equal((await events(db, 'read')).length, 1, 'no change, no event');
  const far = await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: 99 });
  assert.equal(far.last_read_seq, 5, 'capped at the channel\'s last seq');
  assert.equal(await readSeq(db, f.general, f.alice), 5);
  assert.equal((await channelFor(db, f.alice, f.general)).unread, 0);
  const prof = await db.one('select last_active_at from dek.profiles where id = $1', [f.alice]);
  assert.ok(prof.last_active_at, 'reading marks the person active');
  await expectError(db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: null }), 'invalid_input');
  await expectError(db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: -1 }), 'invalid_input');

  // a public channel the caller can read but never joined: a no-op
  const lobby = await db.channel(f.medical, 'lobby');
  await send(db, f.owner, lobby, 'welcome');
  const none = await db.call(f.alice, 'mark_read', { p_channel: lobby, p_seq: 1 });
  assert.deepEqual(none, { channel_id: lobby, last_read_seq: 0 });
  assert.equal((await db.q('select 1 from dek.channel_members where channel_id = $1 and user_id = $2', [lobby, f.alice])).length, 0);
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'mark_read', { p_channel: f.general, p_seq: 1 }), 'not_found');
  }
  await expectAnonDenied(db.call(null, 'mark_read', { p_channel: f.general, p_seq: 1 }));
}));

test('read: mark_unread moves back; mark_all_read reads every membership in one org only', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 1; i <= 5; i += 1) await send(db, f.bob, f.general, `b${i}`);
  await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: 5 });
  const u = await db.call(f.alice, 'mark_unread', { p_channel: f.general, p_seq: 3 });
  assert.deepEqual(u, { channel_id: f.general, last_read_seq: 2 });
  assert.equal((await channelFor(db, f.alice, f.general)).unread, 3);
  const last = (await events(db, 'read')).at(-1);
  assert.equal(last.topic, `u:${f.alice}`);
  assert.equal(last.payload.last_read_seq, 2);
  await expectError(db.call(f.alice, 'mark_unread', { p_channel: f.general, p_seq: 0 }), 'invalid_input');

  // alice also belongs to the other organization, with unread there
  await db.member(f.otherOrg, f.alice);
  await db.serverMember(f.otherServer, f.alice);
  await db.channelMember(f.otherChannel, f.alice);
  await send(db, f.eve, f.otherChannel, 'from the other org');
  await send(db, f.carol, f.grants, 'grants news');
  await send(db, f.bob, f.dmAliceBob, 'dm news');
  const before = (await events(db, 'read')).length;
  const all = await db.call(f.alice, 'mark_all_read', { p_org: f.org });
  assert.deepEqual(all, { count: 3 }, 'general, grants and the DM');
  for (const ch of [f.general, f.grants, f.dmAliceBob]) {
    assert.equal((await channelFor(db, f.alice, ch)).unread, 0);
  }
  assert.equal((await channelFor(db, f.alice, f.otherChannel)).unread, 1, 'the other org is untouched');
  const evs = (await events(db, 'read')).slice(before);
  assert.equal(evs.length, 3);
  assert.ok(evs.every((e) => e.topic === `u:${f.alice}`));
  assert.deepEqual(await db.call(f.alice, 'mark_all_read', { p_org: f.org }), { count: 0 });
  await expectError(db.call(f.eve, 'mark_all_read', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'mark_all_read', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'mark_all_read', { p_org: f.org }), 'suspended');
}));

test('threads: follow, unfollow, mark_thread_read and list_threads (unread replies, newest first, readable only)', () => tx(async (db) => {
  const f = await db.fixture();
  const t1 = await send(db, f.alice, f.general, 'thread one');
  const t2 = await send(db, f.alice, f.grants, 'thread two');
  const t3 = await send(db, f.bob, f.general, 'thread three');
  await send(db, f.bob, f.general, 'r1', { p_thread_root: t1.id });
  const r2 = await send(db, f.owner, f.general, 'r2', { p_thread_root: t1.id });
  await send(db, f.carol, f.grants, 'g1', { p_thread_root: t2.id });
  await db.q("update dek.messages set last_reply_at = now() - interval '1 hour' where id = $1", [t1.id]);

  let list = await db.call(f.alice, 'list_threads', { p_org: f.org });
  assert.deepEqual(list.threads.map((t) => t.root.id), [t2.id, t1.id], 'newest activity first; t3 has no follow');
  const one = list.threads.find((t) => t.root.id === t1.id);
  assert.equal(one.unread_replies, 2);
  assert.equal(one.channel.id, f.general);
  assert.ok(one.last_reply_at);

  const rd = await db.call(f.alice, 'mark_thread_read', { p_root: t1.id, p_seq: r2.seq });
  assert.deepEqual(rd, { root_id: t1.id, last_read_reply_seq: r2.seq });
  const ev = (await events(db, 'read')).at(-1);
  assert.equal(ev.topic, `u:${f.alice}`);
  assert.equal(ev.payload.root_id, t1.id);
  assert.equal(ev.payload.last_read_reply_seq, r2.seq);
  const again = await db.call(f.alice, 'mark_thread_read', { p_root: t1.id, p_seq: 1 });
  assert.equal(again.last_read_reply_seq, r2.seq, 'monotonic');
  list = await db.call(f.alice, 'list_threads', { p_org: f.org });
  assert.equal(list.threads.find((t) => t.root.id === t1.id).unread_replies, 0);

  assert.deepEqual(await db.call(f.alice, 'follow_thread', { p_root: t3.id, p_follow: true }), { root_id: t3.id, following: true });
  assert.deepEqual(await db.call(f.alice, 'follow_thread', { p_root: t1.id, p_follow: false }), { root_id: t1.id, following: false });
  list = await db.call(f.alice, 'list_threads', { p_org: f.org, p_limit: 10 });
  assert.deepEqual(list.threads.map((t) => t.root.id).sort(), [t2.id, t3.id].sort());
  // a thread never followed has no read position, and reading it does not follow it
  const bobRead = await db.call(f.bob, 'mark_thread_read', { p_root: t2.id, p_seq: 1 }).catch((e) => e);
  assert.equal(bobRead.code, 'not_found', 'bob cannot read grants');
  const ownerRead = await db.call(f.owner, 'mark_thread_read', { p_root: t3.id, p_seq: 3 });
  assert.equal(ownerRead.last_read_reply_seq, 0);
  assert.equal((await db.q('select 1 from dek.thread_follows where root_id = $1 and user_id = $2', [t3.id, f.owner])).length, 0);
  // following an existing thread starts read up to its latest reply
  await db.call(f.admin, 'follow_thread', { p_root: t1.id, p_follow: true });
  const adminList = await db.call(f.admin, 'list_threads', { p_org: f.org });
  assert.equal(adminList.threads.find((t) => t.root.id === t1.id).unread_replies, 0);
  // a deleted root whose replies are all gone is not a thread any more
  const t4 = await send(db, f.alice, f.general, 'short lived');
  const r4 = await send(db, f.bob, f.general, 'gone too', { p_thread_root: t4.id });
  assert.ok((await db.call(f.alice, 'list_threads', { p_org: f.org })).threads.some((t) => t.root.id === t4.id));
  await db.call(f.bob, 'delete_message', { p_message: r4.id });
  await db.call(f.alice, 'delete_message', { p_message: t4.id });
  assert.ok(!(await db.call(f.alice, 'list_threads', { p_org: f.org })).threads.some((t) => t.root.id === t4.id));

  // losing access to grants drops its thread from the list at once
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.grants, f.alice]);
  list = await db.call(f.alice, 'list_threads', { p_org: f.org });
  assert.deepEqual(list.threads.map((t) => t.root.id), [t3.id]);
  await expectError(db.call(f.alice, 'follow_thread', { p_root: r2.id, p_follow: true }), 'invalid_input');
  await expectError(db.call(f.alice, 'follow_thread', { p_root: t1.id, p_follow: null }), 'invalid_input');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'follow_thread', { p_root: t1.id, p_follow: true }), 'not_found');
    await expectError(db.call(u, 'mark_thread_read', { p_root: t1.id, p_seq: 1 }), 'not_found');
  }
  await expectError(db.call(f.eve, 'list_threads', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'list_threads', { p_org: f.org }), 'suspended');
}));

test('mentions: direct and <!channel> mentions with read flags, paged by time, never across tenants', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.alice, f.general, 'my own <!here>');   // also reads general up to seq 1
  const m1 = await send(db, f.bob, f.general, `hey <@${f.alice}>`);
  const m2 = await send(db, f.carol, f.grants, `<@${f.alice}> grants question`);
  const m3 = await send(db, f.owner, f.general, 'all hands <!channel>');
  const m5 = await send(db, f.bob, f.dmAliceBob, `<@${f.alice}> in the DM`);
  // m1 two hours ago, m3 one hour ago, m2 ten minutes ago, m5 now
  await db.q("update dek.messages set created_at = now() - interval '2 hours' where id = $1", [m1.id]);
  await db.q("update dek.messages set created_at = now() - interval '1 hour' where id = $1", [m3.id]);
  await db.q("update dek.messages set created_at = now() - interval '10 minutes' where id = $1", [m2.id]);
  await db.q(`update dek.mentions set created_at = m.created_at from dek.messages m
               where m.id = dek.mentions.message_id and m.id = any($1::uuid[])`, [[m1.id, m2.id, m3.id]]);
  await db.call(f.alice, 'mark_read', { p_channel: f.grants, p_seq: m2.seq });

  const all = await db.call(f.alice, 'list_mentions', { p_org: f.org });
  assert.deepEqual(all.items.map((i) => i.message.id), [m5.id, m2.id, m3.id, m1.id],
    'newest first; own <!here> excluded');
  const by = Object.fromEntries(all.items.map((i) => [i.message.id, i]));
  assert.equal(by[m2.id].read, true);
  assert.equal(by[m1.id].read, false);
  assert.equal(by[m3.id].channel.id, f.general);
  assert.equal(all.has_more, false);

  const page1 = await db.call(f.alice, 'list_mentions', { p_org: f.org, p_limit: 2 });
  assert.deepEqual(page1.items.map((i) => i.message.id), [m5.id, m2.id]);
  assert.equal(page1.has_more, true);
  const page2 = await db.call(f.alice, 'list_mentions',
    { p_org: f.org, p_limit: 2, p_before: page1.items.at(-1).message.created_at });
  assert.deepEqual(page2.items.map((i) => i.message.id), [m3.id, m1.id]);

  // a mention from the other org never shows here
  await db.member(f.otherOrg, f.alice);
  await db.channelMember(f.otherChannel, f.alice);
  await send(db, f.eve, f.otherChannel, `<@${f.alice}> hello from Safalta`);
  const again = await db.call(f.alice, 'list_mentions', { p_org: f.org });
  assert.equal(again.items.length, 4);
  const there = await db.call(f.alice, 'list_mentions', { p_org: f.otherOrg });
  assert.equal(there.items.length, 1);
  // after access to grants is gone, its mention is gone too
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.grants, f.alice]);
  const after = await db.call(f.alice, 'list_mentions', { p_org: f.org });
  assert.ok(!after.items.some((i) => i.message.id === m2.id));
  // a public channel bob reads but never joined has no read position to compare with,
  // so the mention counts as read (as in Channel.mentions)
  const lobby = await db.channel(f.medical, 'lobby');
  const inLobby = await send(db, f.owner, lobby, `<@${f.bob}> have a look`);
  const bobs = await db.call(f.bob, 'list_mentions', { p_org: f.org });
  assert.equal(bobs.items.find((i) => i.message.id === inLobby.id).read, true);
  await expectError(db.call(f.eve, 'list_mentions', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'list_mentions', { p_org: f.org }), 'suspended');
  await expectAnonDenied(db.call(null, 'list_mentions', { p_org: f.org }));
}));

test('unread feed: joined channels with unread messages from others, newest unread per channel', () => tx(async (db) => {
  const f = await db.fixture();
  for (let i = 1; i <= 4; i += 1) await send(db, f.bob, f.general, `g${i}`);
  await send(db, f.carol, f.grants, 'grants');
  await send(db, f.bob, f.dmAliceBob, 'dm');
  await send(db, f.alice, f.general, 'mine');   // reads general up to here
  await send(db, f.bob, f.general, 'after mine');
  await db.q("update dek.channel_members set notify = 'none' where channel_id = $1 and user_id = $2", [f.grants, f.alice]);
  const feed = await db.call(f.alice, 'unread_feed', { p_org: f.org, p_limit_per_channel: 3 });
  const byId = Object.fromEntries(feed.channels.map((c) => [c.channel.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [f.general, f.dmAliceBob].sort(), 'muted-to-none grants is left out');
  assert.deepEqual(byId[f.general].messages.map((m) => m.body), ['after mine']);
  assert.deepEqual(byId[f.dmAliceBob].messages.map((m) => m.body), ['dm']);
  await db.call(f.alice, 'mark_all_read', { p_org: f.org });
  assert.deepEqual(await db.call(f.alice, 'unread_feed', { p_org: f.org }), { channels: [] });
  for (let i = 1; i <= 5; i += 1) await send(db, f.bob, f.general, `n${i}`);
  const capped = await db.call(f.alice, 'unread_feed', { p_org: f.org, p_limit_per_channel: 3 });
  assert.deepEqual(capped.channels[0].messages.map((m) => m.body), ['n3', 'n4', 'n5'], 'newest unread, ascending');
  await expectError(db.call(f.eve, 'unread_feed', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.stranger, 'unread_feed', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'unread_feed', { p_org: f.org }), 'suspended');
}));
