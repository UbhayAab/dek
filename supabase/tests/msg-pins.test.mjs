// Pins and saved messages: api.pin_message, list_pins, save_message, list_saved.
// Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, events, messageRow, expectAnonDenied } from './msg-lib.mjs';

test('pins: channel members pin and unpin, newest pin first, msg.upd broadcast; idempotent', () => tx(async (db) => {
  const f = await db.fixture();
  const a = await send(db, f.bob, f.general, 'first');
  const b = await send(db, f.bob, f.general, 'second');
  assert.deepEqual(await db.call(f.alice, 'pin_message', { p_message: a.id, p_pinned: true }), { message_id: a.id, pinned: true });
  await db.q("update dek.messages set pinned_at = now() - interval '1 minute' where id = $1", [a.id]);
  await db.call(f.bob, 'pin_message', { p_message: b.id, p_pinned: true });
  const row = await messageRow(db, b.id);
  assert.equal(row.pinned_by, f.bob);
  let pins = await db.call(f.alice, 'list_pins', { p_channel: f.general });
  assert.deepEqual(pins.messages.map((m) => m.id), [b.id, a.id]);
  assert.ok(pins.messages.every((m) => m.pinned));
  const upd = (await events(db, 'msg.upd')).filter((e) => e.payload.message.id === b.id);
  assert.equal(upd.length, 1);
  assert.equal(upd[0].payload.message.pinned, true);
  const n = (await events(db, 'msg.upd')).length;
  await db.call(f.alice, 'pin_message', { p_message: b.id, p_pinned: true });
  assert.equal((await events(db, 'msg.upd')).length, n, 'already pinned: no broadcast');
  assert.deepEqual(await db.call(f.alice, 'pin_message', { p_message: a.id, p_pinned: false }), { message_id: a.id, pinned: false });
  pins = await db.call(f.alice, 'list_pins', { p_channel: f.general });
  assert.deepEqual(pins.messages.map((m) => m.id), [b.id]);
  // a deleted message loses its pin and cannot be pinned again
  await db.call(f.bob, 'delete_message', { p_message: b.id });
  assert.deepEqual((await db.call(f.alice, 'list_pins', { p_channel: f.general })).messages, []);
  await expectError(db.call(f.alice, 'pin_message', { p_message: b.id, p_pinned: true }), 'conflict');
}));

test('pins: announcement channels admins only; readers who never joined cannot; archived refuses; 100 max', () => tx(async (db) => {
  const f = await db.fixture();
  const lobby = await db.channel(f.medical, 'lobby', { members: [f.owner] });
  const l = await send(db, f.owner, lobby, 'welcome');
  await expectError(db.call(f.alice, 'pin_message', { p_message: l.id, p_pinned: true }), 'forbidden');
  await db.call(f.owner, 'pin_message', { p_message: l.id, p_pinned: true });

  const post = await send(db, f.owner, f.general, 'rules');
  await db.q("update dek.channels set posting_policy = 'admins' where id = $1", [f.general]);
  await expectError(db.call(f.alice, 'pin_message', { p_message: post.id, p_pinned: true }), 'forbidden');
  await db.call(f.admin, 'pin_message', { p_message: post.id, p_pinned: true });

  await db.q(
    `insert into dek.messages (org_id, channel_id, seq, author_id, body, pinned_at)
     select $1, $2, dek.allocate_seq($2, true), $3, 'p' || g, now() - interval '1 hour'
       from generate_series(1, 99) g`, [f.org, f.general, f.owner]);
  const extra = await send(db, f.owner, f.general, 'one too many');
  await expectError(db.call(f.owner, 'pin_message', { p_message: extra.id, p_pinned: true }), 'invalid_input');
  const pins = await db.call(f.alice, 'list_pins', { p_channel: f.general });
  assert.equal(pins.messages.length, 100);
  assert.equal(pins.messages[0].id, post.id);

  await db.q('update dek.channels set archived_at = now() where id = $1', [f.general]);
  await expectError(db.call(f.owner, 'pin_message', { p_message: post.id, p_pinned: false }), 'archived');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'pin_message', { p_message: post.id, p_pinned: false }), 'not_found');
    await expectError(db.call(u, 'list_pins', { p_channel: f.general }), 'not_found');
  }
  await expectAnonDenied(db.call(null, 'list_pins', { p_channel: f.general }));
}));

test('saved: save, list newest first with paging, unsave; only messages still readable come back', () => tx(async (db) => {
  const f = await db.fixture();
  const a = await send(db, f.bob, f.general, 'keep this');
  const b = await send(db, f.carol, f.grants, 'and this');
  const c = await send(db, f.bob, f.dmAliceBob, 'and the DM');
  assert.deepEqual(await db.call(f.alice, 'save_message', { p_message: a.id, p_saved: true }), { message_id: a.id, saved: true });
  await db.call(f.alice, 'save_message', { p_message: a.id, p_saved: true });   // idempotent
  for (const [m, ago] of [[a, '3 hours'], [b, '2 hours'], [c, '1 hour']]) {
    if (m !== a) await db.call(f.alice, 'save_message', { p_message: m.id, p_saved: true });
    await db.q(`update dek.saved_messages set created_at = now() - $3::interval where user_id = $1 and message_id = $2`,
      [f.alice, m.id, ago]);
  }
  const all = await db.call(f.alice, 'list_saved', { p_org: f.org });
  assert.deepEqual(all.items.map((i) => i.message.id), [c.id, b.id, a.id]);
  assert.equal(all.items[0].channel.id, f.dmAliceBob);
  assert.ok(all.items[0].saved_at);
  assert.equal(all.has_more, false);
  const p1 = await db.call(f.alice, 'list_saved', { p_org: f.org, p_limit: 2 });
  assert.deepEqual(p1.items.map((i) => i.message.id), [c.id, b.id]);
  assert.equal(p1.has_more, true);
  const p2 = await db.call(f.alice, 'list_saved', { p_org: f.org, p_limit: 2, p_before: p1.items.at(-1).saved_at });
  assert.deepEqual(p2.items.map((i) => i.message.id), [a.id]);
  assert.equal(p2.has_more, false);

  // removed from grants: that bookmark no longer comes back
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.grants, f.alice]);
  const after = await db.call(f.alice, 'list_saved', { p_org: f.org });
  assert.deepEqual(after.items.map((i) => i.message.id), [c.id, a.id]);
  assert.deepEqual(await db.call(f.alice, 'save_message', { p_message: c.id, p_saved: false }), { message_id: c.id, saved: false });
  assert.deepEqual((await db.call(f.alice, 'list_saved', { p_org: f.org })).items.map((i) => i.message.id), [a.id]);

  await db.call(f.bob, 'delete_message', { p_message: a.id });
  await expectError(db.call(f.alice, 'save_message', { p_message: a.id, p_saved: true }), 'conflict');
  await expectError(db.call(f.alice, 'save_message', { p_message: b.id, p_saved: true }), 'not_found');
  await expectError(db.call(f.alice, 'save_message', { p_message: c.id, p_saved: null }), 'invalid_input');
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'save_message', { p_message: c.id, p_saved: true }), 'not_found');
  }
  await expectError(db.call(f.eve, 'list_saved', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'list_saved', { p_org: f.org }), 'suspended');
  await expectAnonDenied(db.call(null, 'list_saved', { p_org: f.org }));
}));
