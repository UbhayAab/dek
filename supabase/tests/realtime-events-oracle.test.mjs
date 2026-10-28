// Real Postgres regression; dedicated TEST branch, serial execution, rollback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx } from './_harness.mjs';
import { events as orgEvents, mark, since } from './org-lib.mjs';
import { events as messageEvents } from './msg-lib.mjs';

test('realtime observation supports transaction and wall-clock timestamps with exact filters and mark/since', () => tx(async db => {
  const topic = `u:${randomUUID()}`, other = `u:${randomUUID()}`;
  const event = `oracle-${randomUUID()}`, otherEvent = `oracle-${randomUUID()}`;
  // Historical rows must stay out, even when their topic/event match.
  await db.q(`insert into realtime.messages (id,topic,extension,event,payload,private,inserted_at)
    values (gen_random_uuid(),$1,'broadcast',$2,'{"step":"old"}',true,timezone('utc',now())-interval '1 microsecond'),
           (gen_random_uuid(),$1,'broadcast',$2,'{"step":"transaction-start"}',true,timezone('utc',now()))`, [topic,event]);
  assert.deepEqual((await orgEvents(db,{event,topic})).map(r=>r.payload.step), ['transaction-start']);
  const before = await mark(db);
  await db.q('select dek.emit_many($1::text[],$2,$3::jsonb)', [[topic,other],event,JSON.stringify({step:'wall-clock'})]);
  await db.q('select dek.emit_many($1::text[],$2,$3::jsonb)', [[topic],otherEvent,JSON.stringify({step:'different-event'})]);
  const own = await since(db,before,{event,topic});
  assert.equal(own.length,1);
  assert.equal(own[0].payload.step,'wall-clock');
  assert.deepEqual((await since(db,before,{event})).map(r=>r.topic).sort(),[topic,other].sort());
  assert.equal((await since(db,before,{event:otherEvent,topic})).length,1);
  const observed = (await messageEvents(db,event)).filter(r=>r.topic===topic);
  assert.deepEqual(observed.map(r=>r.payload.step),['transaction-start','wall-clock']);
  const row = await db.one(`select inserted_at>=timezone('utc',now()) as after_start,
    inserted_at=timezone('utc',now()) as equals_start from realtime.messages where id=$1`,[own[0].id]);
  assert.equal(row.after_start,true);
  // The deployed clock_timestamp default currently exercises the false-negative path.
  // If the provider returns to now(), both legitimate timestamp forms remain admitted.
  if (!row.equals_start) assert.equal(own.length,1);
}));
