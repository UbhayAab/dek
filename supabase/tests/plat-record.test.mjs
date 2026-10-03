// svc_record_deliveries under messy input: what push-dispatch can really send back
// when the world changed between claim and record. Owner: plat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx } from './_harness.mjs';
import { device, message, msgIntent, claim, record, prefs, intentRow } from './plat-lib.mjs';

test('record: a device deleted mid-flight, duplicates, unknown statuses and garbage ids never break the write', () => tx(async (db) => {
  const f = await db.fixture();
  const gone = await device(db, f.bob);
  const dup = await device(db, f.bob);
  await prefs(db, f.bob, { default_level: 'all' });
  const id = await msgIntent(db, await message(db, f.general, f.alice, 'busy day'), f.alice);
  assert.equal((await claim(db, id)).deliveries.length, 2);
  await db.q('delete from dek.push_devices where id = $1', [gone]);   // signed out while we were sending
  const out = await record(db, id, [
    { user_id: f.bob, device_id: gone, status: 'sent', http_status: 201 },
    { user_id: f.bob, device_id: dup, status: 'failed', reason: 'first try', http_status: 500 },
    { user_id: f.bob, device_id: dup, status: 'sent', reason: null, http_status: 201 },
    { user_id: 'not-a-uuid', device_id: 'also-not', status: 'sent' },
    { user_id: f.bob, device_id: null, status: 'teleported', reason: 'unknown status word' },
  ]);
  const rows = await db.q(`select device_id, status, reason, http_status from dek.notification_deliveries
                            where intent_id = $1 order by device_id nulls first, status`, [id]);
  assert.deepEqual(rows, [
    { device_id: null, status: 'failed', reason: 'unknown status word', http_status: null },
    { device_id: null, status: 'sent', reason: null, http_status: 201 },
    { device_id: dup, status: 'sent', reason: null, http_status: 201 },
  ], 'the deleted device is kept as a device-less row; the last result per device wins; garbage is dropped');
  assert.equal(out.recorded, 3);
  assert.equal(out.status, 'pending', 'an unknown status is treated as a retryable failure');
  assert.equal((await intentRow(db, id)).locked_until, null);
  const d = await db.one('select failure_count, last_status from dek.push_devices where id = $1', [dup]);
  assert.deepEqual(d, { failure_count: 0, last_status: 'sent 201' });
}));

test('record: an empty result list finishes the intent', () => tx(async (db) => {
  const f = await db.fixture();
  await device(db, f.bob);
  await prefs(db, f.bob, { default_level: 'all' });
  const id = await msgIntent(db, await message(db, f.general, f.alice, 'x'), f.alice);
  await claim(db, id);
  assert.deepEqual(await record(db, id, []), { intent_id: id, status: 'done', attempts: 1, recorded: 0, revoked: 0 });
}));
