import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, expectAnonDenied } from './msg-lib.mjs';

const page = (db, uid, fn, org, before = null, unread = false, limit = 2) => db.call(uid, fn, {
  p_org: org, p_cursor: before,
  p_unread_only: unread, p_limit: limit,
});

test('inbox threads: older than 30 remain reachable with equal-time stable cursors', () => tx(async db => {
  const f = await db.fixture();
  const roots = [];
  for (let i = 0; i < 36; i++) {
    if (i % 12 === 0) await db.q('delete from dek.rate_buckets where user_id=$1', [f.alice]);
    const root = await send(db, f.alice, f.general, `discussion ${i}`);
    roots.push(root);
    await send(db, f.alice, f.general, `read reply ${i}`, { p_thread_root: root.id });
  }
  await send(db, f.bob, f.general, 'older unread reply', { p_thread_root: roots[0].id });
  await db.q("update dek.messages set last_reply_at=now()-interval '1 day' where id=$1", [roots[0].id]);
  await db.q("update dek.messages set created_at=now()-interval '1 day' where thread_root_id=$1", [roots[0].id]);
  const seen = [];
  let cursor = null;
  do {
    const res = await page(db, f.alice, 'list_thread_inbox', f.org, cursor, false, 30);
    seen.push(...res.items.map(it => it.root.id));
    cursor = res.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 36);
  assert.deepEqual(seen, [...roots.slice(1).map(r => r.id).sort().reverse(), roots[0].id]);
  const old = await db.call(f.alice, 'list_threads', { p_org: f.org });
  assert.equal(old.threads.length, 30, 'old API unchanged');
  assert.ok(!old.threads.some(it => it.root.id === roots[0].id), 'reproduces the old cutoff hiding an older unread thread');
  const unread = await page(db, f.alice, 'list_thread_inbox', f.org, null, true, 30);
  assert.deepEqual(unread.items.map(it => it.root.id), [roots[0].id], 'older unread thread is reachable directly');
}));

test('inbox threads: unread ignores own/deleted replies and marking only the snapshot keeps later replies unread', () => tx(async db => {
  const f = await db.fixture();
  const root = await send(db, f.alice, f.general, 'review');
  await send(db, f.alice, f.general, 'my reply', { p_thread_root: root.id });
  const removed = await send(db, f.bob, f.general, 'removed reply', { p_thread_root: root.id });
  await db.call(f.bob, 'delete_message', { p_message: removed.id });
  assert.deepEqual((await page(db, f.alice, 'list_thread_inbox', f.org, null, true)).items, []);
  const first = await send(db, f.bob, f.general, 'please check', { p_thread_root: root.id });
  const inbox = await page(db, f.alice, 'list_thread_inbox', f.org, null, true);
  assert.equal(inbox.items[0].unread_replies, 1);
  assert.equal(inbox.items[0].last_reply_seq, first.seq);
  const later = await send(db, f.bob, f.general, 'new after snapshot', { p_thread_root: root.id });
  await db.call(f.alice, 'mark_thread_read', { p_root: root.id, p_seq: inbox.items[0].last_reply_seq });
  const fresh = await page(db, f.alice, 'list_thread_inbox', f.org, null, true);
  assert.equal(fresh.items[0].unread_replies, 1);
  assert.equal(fresh.items[0].last_reply_seq, later.seq);
  await db.call(f.alice, 'follow_thread', { p_root: root.id, p_follow: false });
  assert.deepEqual((await page(db, f.alice, 'list_thread_inbox', f.org)).items, []);
}));

test('inbox mentions: direct and channel mentions with the same timestamp page without loss or duplicates', () => tx(async db => {
  const f = await db.fixture();
  const messages = [];
  for (let i = 0; i < 5; i++) messages.push(await send(db, f.owner, f.general, `update ${i} <@${f.alice}> <!channel>`));
  const seen = [];
  let cursor = null;
  do {
    const res = await page(db, f.alice, 'list_mention_inbox', f.org, cursor, true, 2);
    seen.push(...res.items.map(it => it.message.id));
    cursor = res.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, messages.map(m => m.id).sort().reverse());
  await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: messages.at(-1).seq });
  assert.deepEqual((await page(db, f.alice, 'list_mention_inbox', f.org, null, true)).items, []);
  const all = await page(db, f.alice, 'list_mention_inbox', f.org, null, false, 10);
  assert.equal(all.items.length, 5);
  assert.ok(all.items.every(it => it.read));
}));

test('inbox: readable-only for partial guests, revoked users, suspended users and other tenants', () => tx(async db => {
  const f = await db.fixture();
  const root = await send(db, f.carol, f.grants, `limited project <@${f.alice}>`);
  await db.call(f.alice, 'follow_thread', { p_root: root.id, p_follow: true });
  await send(db, f.carol, f.grants, `follow-up <@${f.alice}>`, { p_thread_root: root.id });
  for (const fn of ['list_thread_inbox', 'list_mention_inbox']) {
    const own = await page(db, f.alice, fn, f.org);
    assert.ok(own.items.length > 0, 'partial server contributor keeps explicit channel access');
    for (const uid of [f.stranger, f.eve]) await expectError(page(db, uid, fn, f.org), 'not_found');
    await expectError(page(db, f.suspended, fn, f.org), 'suspended');
    await expectAnonDenied(page(db, null, fn, f.org));
    const guest = await page(db, f.guest, fn, f.org);
    assert.ok(guest.items.every(it => it.channel.id !== f.grants));
  }
  await db.q('delete from dek.channel_members where channel_id=$1 and user_id=$2', [f.grants, f.alice]);
  for (const fn of ['list_thread_inbox', 'list_mention_inbox']) {
    const revoked = await page(db, f.alice, fn, f.org);
    assert.ok(revoked.items.every(it => it.channel.id !== f.grants));
  }
}));

test('inbox: complete cursor required, limits remain bounded, deleted mentions disappear', () => tx(async db => {
  const f = await db.fixture();
  const m = await send(db, f.bob, f.general, `<@${f.alice}> check this`);
  for (const fn of ['list_thread_inbox', 'list_mention_inbox']) {
    await expectError(db.call(f.alice, fn, { p_org: f.org, p_cursor: { at: m.created_at } }), 'invalid_input');
    await expectError(db.call(f.alice, fn, { p_org: f.org, p_cursor: { id: m.id } }), 'invalid_input');
    await expectError(db.call(f.alice, fn, { p_org: f.org, p_unread_only: null }), 'invalid_input');
    assert.ok((await page(db, f.alice, fn, f.org, null, false, 10000)).items.length <= 100);
  }
  await db.call(f.bob, 'delete_message', { p_message: m.id });
  assert.deepEqual((await page(db, f.alice, 'list_mention_inbox', f.org)).items, []);
}));

test('inbox: cursor is bound to user, org, inbox, unread filter and ordering; private queries have no member grants', () => tx(async db => {
  const f = await db.fixture();
  for (let i = 0; i < 3; i++) {
    const root = await send(db, f.bob, f.general, `cursor ${i} <@${f.alice}>`);
    await db.call(f.alice, 'follow_thread', { p_root: root.id, p_follow: true });
    await send(db, f.bob, f.general, 'new reply', { p_thread_root: root.id });
  }
  for (const fn of ['list_thread_inbox', 'list_mention_inbox']) {
    const res = await page(db, f.alice, fn, f.org, null, true, 1);
    assert.equal(res.has_more, true);
    const cursor = res.next_cursor;
    assert.equal(cursor.org, f.org);
    for (const patch of [{ org: f.otherOrg }, { user: f.bob }, { unread: false }, { order: 'oldest' }, { kind: 'wrong' }, { v: 99 }, { at: 'invalid' }, { at: 'infinity' }, { id: 'invalid' }]) {
      await expectError(page(db, f.alice, fn, f.org, { ...cursor, ...patch }, true, 1), 'invalid_input');
    }
    await expectError(page(db, f.alice, fn, f.org, cursor, false, 1), 'invalid_input');
    await expectError(page(db, f.bob, fn, f.org, cursor, true, 1), 'invalid_input');
    await expectError(page(db, f.alice, fn, f.otherOrg, cursor, true, 1), 'not_found');
    const signature = `dek.${fn}(uuid,timestamptz,uuid,boolean,integer)`;
    assert.equal((await db.one("select has_function_privilege('authenticated', $1, 'EXECUTE') as allowed", [signature])).allowed, false);
  }
}));

test('inbox mentions: two device snapshots and exact read boundary keep unrelated later messages unread', () => tx(async db => {
  const f = await db.fixture();
  const first = await send(db, f.bob, f.general, `<@${f.alice}> first`);
  const later = await send(db, f.bob, f.general, `<@${f.alice}> later`);
  const deviceA = await page(db, f.alice, 'list_mention_inbox', f.org, null, true, 30);
  const deviceB = await page(db, f.alice, 'list_mention_inbox', f.org, null, true, 30);
  assert.equal(deviceA.items.length, 2);
  assert.equal(deviceB.items.length, 2);
  await db.call(f.alice, 'mark_read', { p_channel: f.general, p_seq: first.seq });
  const refreshedB = await page(db, f.alice, 'list_mention_inbox', f.org, null, true, 30);
  assert.deepEqual(refreshedB.items.map(it => it.message.id), [later.id]);
}));

test('inbox: deleted roots keep surviving discussions; unjoined public mentions are read; guests see only explicit access', () => tx(async db => {
  const f = await db.fixture();
  const root = await send(db, f.bob, f.general, 'original root');
  await db.call(f.alice, 'follow_thread', { p_root: root.id, p_follow: true });
  await send(db, f.bob, f.general, 'surviving discussion', { p_thread_root: root.id });
  await db.call(f.bob, 'delete_message', { p_message: root.id });
  assert.ok((await page(db, f.alice, 'list_thread_inbox', f.org, null, true)).items.some(it => it.root.id === root.id));
  const lobby = await db.channel(f.medical, 'inbox-public-lobby');
  const mention = await send(db, f.owner, lobby, `hello <@${f.alice}>`);
  const all = await page(db, f.alice, 'list_mention_inbox', f.org, null, false, 100);
  assert.equal(all.items.find(it => it.message.id === mention.id)?.read, true);
  assert.ok(!(await page(db, f.alice, 'list_mention_inbox', f.org, null, true, 100)).items.some(it => it.message.id === mention.id));
  await db.channelMember(f.grants, f.guest);
  const privateRoot = await send(db, f.carol, f.grants, `guest project <@${f.guest}>`);
  await db.call(f.guest, 'follow_thread', { p_root: privateRoot.id, p_follow: true });
  await send(db, f.carol, f.grants, `guest follow-up <@${f.guest}>`, { p_thread_root: privateRoot.id });
  for (const fn of ['list_thread_inbox', 'list_mention_inbox']) {
    const guest = await page(db, f.guest, fn, f.org, null, true, 100);
    assert.ok(guest.items.length > 0);
    assert.ok(guest.items.every(it => it.channel.id === f.grants));
  }
}));
