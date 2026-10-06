// [lead] 0915 delete_channel (Fixboard #16). The file is re-run inside each rolled-back
// transaction, so the test also covers it before it is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tx, expectError } from './_harness.mjs';
import { mark, since } from './org-lib.mjs';

const SQL = readFileSync(new URL('../migrations/0915_channel_delete.sql', import.meta.url), 'utf8');

test('delete_channel: owner or server admins, typed name, everything inside goes, members told', () => tx(async (db) => {
  await db.q(SQL);
  const f = await db.fixture();
  await db.message(f.grants, f.alice, 'one');
  const before = await mark(db);

  await expectError(db.call(f.alice, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'wrong' }), 'invalid_input');
  await expectError(db.call(f.alice, 'delete_channel', { p_channel: f.grants, p_confirm_name: null }), 'invalid_input');
  await expectError(db.call(f.carol, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'forbidden');
  await expectError(db.call(f.bob, 'delete_channel', { p_channel: f.general, p_confirm_name: 'general' }), 'forbidden');
  await expectError(db.call(f.bob, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'not_found');
  await expectError(db.call(f.guest, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'forbidden');
  await expectError(db.call(f.eve, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'not_found');
  await expectError(db.call(f.stranger, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'not_found');
  await expectError(db.call(f.suspended, 'delete_channel', { p_channel: f.general, p_confirm_name: 'general' }), 'suspended');
  await expectError(db.call(f.alice, 'delete_channel', { p_channel: f.dmAliceBob, p_confirm_name: '' }), 'forbidden');

  const members = (await db.q('select user_id from dek.channel_members where channel_id = $1', [f.grants])).map((r) => r.user_id);
  assert.deepEqual(await db.call(f.alice, 'delete_channel', { p_channel: f.grants, p_confirm_name: ' grants ' }),
    { channel_id: f.grants, deleted: true });
  assert.equal((await db.q('select count(*)::int n from dek.channels where id = $1', [f.grants]))[0].n, 0);
  assert.equal((await db.q('select count(*)::int n from dek.messages where channel_id = $1', [f.grants]))[0].n, 0);
  const ev = await since(db, before, { event: 'access.revoked' });
  assert.deepEqual(ev.map((e) => e.topic).sort(), members.map((u) => `u:${u}`).sort(), 'every member is told');
  assert.equal(ev[0].payload.scope, 'channel');
  const audit = await db.q("select details from dek.audit_log where org_id = $1 and action = 'channel.deleted'", [f.org]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.messages, 1);
  await expectError(db.call(f.alice, 'delete_channel', { p_channel: f.grants, p_confirm_name: 'Grants' }), 'not_found');

  // a server admin (and org admins through is_server_admin) may delete a public channel they do not own
  assert.equal((await db.call(f.owner, 'delete_channel', { p_channel: f.general, p_confirm_name: 'general' })).deleted, true);
}));
