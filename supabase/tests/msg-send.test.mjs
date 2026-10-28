// api.send_message: durability, idempotency, ordering, threads, attachments,
// mentions, posting rules, side effects and realtime. Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import { send, events, attachment, fillRate, messageRow, seqs, expectAnonDenied } from './msg-lib.mjs';

test('send: a retry with the same client_id returns the original message and seq (DEK06, DEKA03)', () => tx(async (db) => {
  const f = await db.fixture();
  const cid = randomUUID();
  const a = await db.call(f.alice, 'send_message', { p_channel: f.general, p_client_id: cid, p_body: 'hello team' });
  const b = await db.call(f.alice, 'send_message', { p_channel: f.general, p_client_id: cid, p_body: 'hello team' });
  assert.equal(b.id, a.id);
  assert.equal(b.seq, a.seq);
  assert.equal(a.client_id, cid);
  const n = await db.one('select count(*)::int as n from dek.messages where channel_id = $1', [f.general]);
  assert.equal(n.n, 1, 'one durable row');
  const st = await db.one('select last_seq from dek.channel_state where channel_id = $1', [f.general]);
  assert.equal(Number(st.last_seq), 1, 'the retry burned no seq');
  assert.equal((await events(db, 'msg.new')).length, 1, 'one broadcast');
  const intents = await db.one('select count(*)::int as n from dek.notification_intents where message_id = $1', [a.id]);
  assert.equal(intents.n, 1, 'one notification intent');

  // the same client_id aimed at another conversation is a conflict, not a second message
  await expectError(db.call(f.alice, 'send_message', { p_channel: f.grants, p_client_id: cid, p_body: 'x' }), 'conflict');
  // client ids are per author
  const c = await db.call(f.bob, 'send_message', { p_channel: f.general, p_client_id: cid, p_body: 'mine' });
  assert.notEqual(c.id, a.id);
  assert.equal(c.seq, 2);
  await expectError(db.call(f.alice, 'send_message', { p_channel: f.general, p_client_id: null, p_body: 'x' }), 'invalid_input');
  // a retry after losing access is refused like any read
  await db.q('delete from dek.server_members where server_id = $1 and user_id = $2', [f.medical, f.alice]);
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.general, f.alice]);
  await expectError(db.call(f.alice, 'send_message', { p_channel: f.general, p_client_id: cid, p_body: 'hello team' }), 'not_found');
}));

test('send: several senders share one gapless, ordered sequence per channel', () => tx(async (db) => {
  const f = await db.fixture();
  const order = [f.alice, f.bob, f.owner, f.bob, f.alice, f.admin, f.alice, f.bob, f.owner];
  const sent = [];
  for (const [i, u] of order.entries()) sent.push(await send(db, u, f.general, `m${i}`));
  assert.deepEqual(seqs(sent), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const other = await send(db, f.alice, f.grants, 'elsewhere');
  assert.equal(other.seq, 1, 'each channel has its own sequence');
  const page = await db.call(f.bob, 'list_messages', { p_channel: f.general });
  assert.deepEqual(page.messages.map((m) => m.body), order.map((_, i) => `m${i}`));
  assert.equal(page.last_seq, 9);
}));

test('send: body is trimmed, 1 to 8000 characters, empty only with attachments', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, '  \n  padded text \t\n ');
  assert.equal(m.body, 'padded text');
  assert.equal(m.kind, 'user');
  assert.equal(m.author_id, f.alice);
  await expectError(send(db, f.alice, f.general, '   \n\t '), 'invalid_input');
  await expectError(send(db, f.alice, f.general, null), 'invalid_input');
  await expectError(send(db, f.alice, f.general, 'x'.repeat(8001)), 'invalid_input');
  const max = await send(db, f.alice, f.general, `  ${'y'.repeat(8000)}  `);
  assert.equal(max.body.length, 8000);
}));

test('send: replies stay out of the timeline but are in the thread and in sync; also_in_channel shows in both', () => tx(async (db) => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'root');
  await send(db, f.bob, f.general, 'reply one', { p_thread_root: root.id });
  const r2 = await send(db, f.owner, f.general, 'reply two', { p_thread_root: root.id, p_also_in_channel: true });
  await send(db, f.bob, f.general, 'after');
  assert.equal(r2.also_in_channel, true);
  assert.equal(r2.thread_root_id, root.id);

  const page = await db.call(f.alice, 'list_messages', { p_channel: f.general });
  assert.deepEqual(page.messages.map((m) => m.body), ['root', 'reply two', 'after']);
  assert.equal(page.messages[0].reply_count, 2);
  assert.deepEqual(page.messages[0].reply_user_ids, [f.owner, f.bob], 'newest replier first');
  assert.ok(page.messages[0].last_reply_at);

  const th = await db.call(f.alice, 'list_thread', { p_root: root.id });
  assert.deepEqual(th.replies.map((m) => m.body), ['reply one', 'reply two']);

  const sync = await db.call(f.alice, 'sync_channel',
    { p_channel: f.general, p_after_seq: 1, p_changed_since: new Date(Date.now() + 3600e3).toISOString() });
  assert.deepEqual(sync.new.map((m) => m.body), ['reply one', 'reply two', 'after']);

  const st = await db.one('select last_seq, last_top_seq from dek.channel_state where channel_id = $1', [f.general]);
  assert.equal(Number(st.last_seq), 4);
  assert.equal(Number(st.last_top_seq), 4, 'an also_in_channel reply moves the timeline cursor');
  // also_in_channel without a thread is meaningless and ignored
  const plain = await send(db, f.alice, f.general, 'plain', { p_also_in_channel: true });
  assert.equal(plain.also_in_channel, false);
}));

test('send: thread roots must be top level, alive and in the same channel; replies need allow_replies', () => tx(async (db) => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'root');
  const reply = await send(db, f.bob, f.general, 'reply', { p_thread_root: root.id });
  await expectError(send(db, f.alice, f.grants, 'x', { p_thread_root: root.id }), 'not_found');
  await expectError(send(db, f.alice, f.general, 'x', { p_thread_root: randomUUID() }), 'not_found');
  await expectError(send(db, f.alice, f.general, 'x', { p_thread_root: reply.id }), 'invalid_input');
  const lonely = await send(db, f.alice, f.general, 'will go');
  await db.call(f.alice, 'delete_message', { p_message: lonely.id });
  await expectError(send(db, f.bob, f.general, 'x', { p_thread_root: lonely.id }), 'conflict');
  await db.q('update dek.channels set allow_replies = false where id = $1', [f.general]);
  await expectError(send(db, f.bob, f.general, 'x', { p_thread_root: root.id }), 'forbidden');
}));

test('send: reply counters keep the five latest distinct repliers; follows for author, root author and mentioned', () => tx(async (db) => {
  const f = await db.fixture();
  const extra = [];
  for (let i = 0; i < 3; i += 1) {
    const u = await db.user(`Extra ${i}`);
    await db.member(f.org, u);
    await db.serverMember(f.medical, u);
    extra.push(u);
  }
  const root = await send(db, f.alice, f.general, 'root');
  const repliers = [f.bob, f.owner, f.admin, ...extra, f.bob];
  let last;
  for (const u of repliers) last = await send(db, u, f.general, 'r', { p_thread_root: root.id });
  const row = await messageRow(db, root.id);
  assert.equal(row.reply_count, repliers.length);
  assert.deepEqual(row.reply_user_ids, [f.bob, extra[2], extra[1], extra[0], f.admin]);
  assert.equal(new Date(row.last_reply_at).getTime(), new Date(last.created_at).getTime());

  // carol (cannot read general) mentioned: ignored; owner explicitly unfollowed: stays unfollowed
  await db.call(f.owner, 'follow_thread', { p_root: root.id, p_follow: false });
  const m = await send(db, f.bob, f.general, `ping <@${f.owner}> <@${f.carol}>`, { p_thread_root: root.id });
  assert.deepEqual(m.mentions, [f.owner]);
  const follows = await db.q(
    'select user_id, following, last_read_reply_seq from dek.thread_follows where root_id = $1', [root.id]);
  const by = Object.fromEntries(follows.map((r) => [r.user_id, r]));
  assert.equal(by[f.alice].following, true, 'root author follows');
  assert.equal(by[f.bob].following, true, 'author follows');
  assert.equal(Number(by[f.bob].last_read_reply_seq), m.seq, 'own reply is read');
  assert.equal(by[f.owner].following, false, 'an explicit unfollow is respected');
  assert.equal(by[f.carol], undefined);
}));

test('send: attachments must be ready, the sender\'s own, in this channel and unattached', () => tx(async (db) => {
  const f = await db.fixture();
  const ok = await attachment(db, { org: f.org, channel: f.general, uploader: f.alice, name: 'minutes.pdf' });
  const m = await send(db, f.alice, f.general, '', { p_attachment_ids: [ok, ok] });
  assert.equal(m.body, '');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].id, ok);
  assert.equal(m.attachments[0].file_name, 'minutes.pdf');
  assert.equal((await messageRow(db, m.id)).attachment_count, 1);
  assert.equal((await db.one('select message_id from dek.attachments where id = $1', [ok])).message_id, m.id);

  await expectError(send(db, f.alice, f.general, 'again', { p_attachment_ids: [ok] }), 'invalid_input');
  const pending = await attachment(db, { org: f.org, channel: f.general, uploader: f.alice, status: 'pending' });
  await expectError(send(db, f.alice, f.general, 'x', { p_attachment_ids: [pending] }), 'invalid_input');
  const bobs = await attachment(db, { org: f.org, channel: f.general, uploader: f.bob });
  await expectError(send(db, f.alice, f.general, 'x', { p_attachment_ids: [bobs] }), 'invalid_input');
  const elsewhere = await attachment(db, { org: f.org, channel: f.grants, uploader: f.alice });
  await expectError(send(db, f.alice, f.general, 'x', { p_attachment_ids: [elsewhere] }), 'invalid_input');
  await expectError(send(db, f.alice, f.general, 'x', { p_attachment_ids: [randomUUID()] }), 'invalid_input');
  const many = [];
  for (let i = 0; i < 11; i += 1) many.push(await attachment(db, { org: f.org, channel: f.general, uploader: f.alice }));
  await expectError(send(db, f.alice, f.general, 'x', { p_attachment_ids: many }), 'invalid_input');
  const ten = await send(db, f.alice, f.general, 'ten', { p_attachment_ids: many.slice(0, 10) });
  assert.equal(ten.attachments.length, 10);
}));

test('send: mentions keep only people who can read the channel; blocks and self get no mention row', () => tx(async (db) => {
  const f = await db.fixture();
  const ghost = randomUUID();
  const body = `hi <@${f.bob}> <@${f.carol}> <@${f.eve}> <@${ghost}> <@${f.bob}> <@${f.alice}> <@${f.owner.toUpperCase()}>`;
  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.owner, f.alice]);
  const m = await send(db, f.alice, f.general, body);
  assert.deepEqual(m.mentions, [f.bob, f.alice, f.owner], 'readers only, deduped, in order of appearance');
  const rows = await db.q('select user_id, seq, channel_id from dek.mentions where message_id = $1', [m.id]);
  assert.deepEqual(rows.map((r) => r.user_id), [f.bob], 'no row for the author or for someone who blocked the author');
  assert.equal(Number(rows[0].seq), m.seq);
  // in the private Grants channel, the guest and carol are readers; bob is not
  const g = await send(db, f.alice, f.grants, `<@${f.guest}> <@${f.carol}> <@${f.bob}>`);
  assert.deepEqual(g.mentions, [f.guest, f.carol]);
  // junk tokens cannot crowd out a real mention: readability is checked before the cap
  const junk = Array.from({ length: 120 }, () => `<@${randomUUID()}>`).join(' ');
  const crowded = await send(db, f.alice, f.general, `${junk} <@${f.bob}>`);
  assert.deepEqual(crowded.mentions, [f.bob]);
}));

test('send: <!channel> and <!here> count for moderators, or anyone in a channel of 50 or fewer', () => tx(async (db) => {
  const f = await db.fixture();
  const small = await send(db, f.bob, f.general, 'all of you <!channel>');
  assert.equal(small.mention_all, true, 'general has 5 members');
  for (let i = 0; i < 46; i += 1) {
    const u = await db.user(`Member ${i}`);
    await db.member(f.org, u);
    await db.channelMember(f.general, u);
  }
  const big = await send(db, f.bob, f.general, 'everyone <!here>');
  assert.equal(big.mention_all, false, '51 members: a plain member cannot');
  const mod = await send(db, f.owner, f.general, 'everyone <!channel>');
  assert.equal(mod.mention_all, true, 'a server admin can');
  const orgAdmin = await send(db, f.admin, f.general, '<!here> standup');
  assert.equal(orgAdmin.mention_all, true, 'an org admin can');
}));

test('send: announcement channels take top-level posts from moderators only; replies stay open', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q("update dek.channels set posting_policy = 'admins' where id = $1", [f.general]);
  await expectError(send(db, f.alice, f.general, 'can I?'), 'forbidden');
  const post = await send(db, f.owner, f.general, 'Announcement');
  const reply = await send(db, f.alice, f.general, 'thanks', { p_thread_root: post.id });
  assert.equal(reply.thread_root_id, post.id);
  await expectError(send(db, f.alice, f.general, 'loud', { p_thread_root: post.id, p_also_in_channel: true }), 'forbidden');
  const modEcho = await send(db, f.admin, f.general, 'noted', { p_thread_root: post.id, p_also_in_channel: true });
  assert.equal(modEcho.also_in_channel, true);
  await db.q('update dek.channels set allow_replies = false where id = $1', [f.general]);
  await expectError(send(db, f.alice, f.general, 'thanks', { p_thread_root: post.id }), 'forbidden');
}));

test('send: archived channels and servers are read only; blocked DMs refuse; hidden DMs come back', () => tx(async (db) => {
  const f = await db.fixture();
  await db.q('update dek.channels set archived_at = now() where id = $1', [f.grants]);
  await expectError(send(db, f.alice, f.grants, 'x'), 'archived');
  await db.q('update dek.servers set archived_at = now() where id = $1', [f.medical]);
  await expectError(send(db, f.alice, f.general, 'x'), 'archived');

  await db.q('update dek.channel_members set hidden = true where channel_id = $1', [f.dmAliceBob]);
  const dm = await send(db, f.alice, f.dmAliceBob, 'still there?');
  assert.equal(dm.seq, 1);
  const hidden = await db.q('select hidden from dek.channel_members where channel_id = $1', [f.dmAliceBob]);
  assert.deepEqual(hidden.map((r) => r.hidden), [false, false], 'a new message unhides the DM for both');

  await db.q('insert into dek.user_blocks (blocker_id, blocked_id) values ($1, $2)', [f.bob, f.alice]);
  await expectError(send(db, f.alice, f.dmAliceBob, 'hello?'), 'blocked');
  await expectError(send(db, f.bob, f.dmAliceBob, 'hello?'), 'blocked');
}));

test('send: author read position, notification intent and realtime fanout', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.bob, f.general, 'first');
  const m = await send(db, f.alice, f.general, 'second');
  const cm = await db.one('select last_read_seq from dek.channel_members where channel_id = $1 and user_id = $2',
    [f.general, f.alice]);
  assert.equal(Number(cm.last_read_seq), m.seq, 'own messages are never unread');
  const intent = await db.one(
    "select kind, org_id, channel_id, actor_id, status from dek.notification_intents where message_id = $1", [m.id]);
  assert.deepEqual(intent, { kind: 'message', org_id: f.org, channel_id: f.general, actor_id: f.alice, status: 'pending' });

  // a thread reply does not move the channel read position
  const r = await send(db, f.alice, f.general, 'in thread', { p_thread_root: m.id });
  const after = await db.one('select last_read_seq from dek.channel_members where channel_id = $1 and user_id = $2',
    [f.general, f.alice]);
  assert.equal(Number(after.last_read_seq), m.seq);

  const pub = await events(db, 'msg.new');
  assert.ok(pub.length >= 3);
  assert.ok(pub.every((e) => e.topic === `s:${f.medical}`), 'public channel: the server topic only');
  const newReply = pub.find((e) => e.payload.message.id === r.id);
  assert.equal(newReply.payload.v, 1);
  assert.equal(newReply.payload.message.thread_root_id, m.id);
  const upd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === m.id);
  assert.equal(upd.length, 1, 'the root update is broadcast');
  assert.equal(upd[0].payload.message.reply_count, 1);

  const p = await send(db, f.carol, f.grants, 'private');
  const priv = (await events(db, 'msg.new')).filter((e) => e.payload.message.id === p.id);
  assert.deepEqual(priv.map((e) => e.topic).sort(), [`u:${f.alice}`, `u:${f.carol}`, `u:${f.guest}`].sort());
  const touched = await db.one('select last_active_at from dek.profiles where id = $1', [f.carol]);
  assert.ok(touched.last_active_at, 'sending marks the person active');
}));

test('send: denied to strangers, the other tenant, guests on public channels and suspended members', () => tx(async (db) => {
  const f = await db.fixture();
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(send(db, u, f.general, 'let me in'), 'not_found');
  }
  await expectError(send(db, f.alice, f.otherChannel, 'cross tenant'), 'not_found');
  await expectError(send(db, f.bob, f.grants, 'private'), 'not_found');
  await expectAnonDenied(send(db, null, f.general, 'anon'));
  await expectError(send(db, f.alice, randomUUID(), 'nowhere'), 'not_found');
  await expectError(send(db, f.alice, null, 'nowhere'), 'not_found');
  const n = await db.one('select count(*)::int as n from dek.messages where channel_id = $1', [f.general]);
  assert.equal(n.n, 0);
}));

test('send: rate limit is 30 per 10 seconds', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.alice, f.general, 'fine');
  await fillRate(db, f.alice, 'send', 30, 10);
  await expectError(send(db, f.alice, f.general, 'too fast'), 'rate_limited');
  await send(db, f.bob, f.general, 'others are unaffected');
}));
