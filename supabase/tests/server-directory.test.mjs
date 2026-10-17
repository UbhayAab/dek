import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';

test('directory lists active invite-only and empty servers without crossing guest or tenant boundaries', () => tx(async (db) => {
  const f = await db.fixture();
  const empty = await db.server(f.org, 'Empty invite server');
  const old = await db.server(f.org, 'Archived invite server');
  await db.q('update dek.servers set archived_at=now() where id=$1', [old]);
  const list = await db.call(f.alice, 'list_servers', { p_org:f.org });
  assert.ok(list.some(s=>s.id===f.tech && s.access==='browse'));
  assert.ok(list.some(s=>s.id===empty && s.access==='browse' && s.requested===false));
  assert.equal(list.filter(s=>s.id===f.medical).length,1);
  assert.ok(!list.some(s=>s.id===old || s.id===f.otherServer));
  const partial = (await db.call(f.carol,'list_servers',{p_org:f.org})).find(s=>s.id===f.medical);
  assert.equal(partial.access,'partial');
  const guest = await db.call(f.guest,'list_servers',{p_org:f.org});
  assert.ok(!guest.some(s=>s.id===f.tech || s.id===empty));
  for (const [uid, code] of [[f.eve,'not_found'],[f.stranger,'not_found'],[f.suspended,'suspended']]) {
    await expectError(db.call(uid,'list_servers',{p_org:f.org}),code);
  }
}));

test('newly discoverable invite-only servers grant no content, roster, invite, joining or realtime access', () => tx(async (db) => {
  const f = await db.fixture();
  assert.ok((await db.call(f.alice,'list_servers',{p_org:f.org})).some(s=>s.id===f.tech));
  assert.deepEqual(await db.call(f.alice,'list_channels',{p_server:f.tech}),[]);
  for (const [fn,args] of [
    ['list_server_members',{p_server:f.tech}], ['join_server',{p_server:f.tech}],
    ['create_channel',{p_server:f.tech,p_name:'not allowed'}],
    ['create_invite',{p_org:f.org,p_server:f.tech}],
    ['update_server',{p_server:f.tech,p_patch:{join_policy:'open'}}],
  ]) await expectError(db.call(f.alice,fn,args),'forbidden');
  await expectError(db.call(f.alice,'list_messages',{p_channel:f.techGeneral}),'not_found');
  await expectError(db.call(f.alice,'send_message',{p_channel:f.techGeneral,p_client_id:crypto.randomUUID(),p_body:'not allowed'}),'not_found');
  const channels=await db.call(f.alice,'browse_channels',{p_org:f.org});
  assert.ok(!channels.channels.some(c=>c.server_id===f.tech));
  assert.equal((await db.one('select dek.can_read_channel($1,$2) ok',[f.alice,f.techGeneral])).ok,false);
  assert.equal((await db.as(f.alice,'select dek.can_use_topic($1,$2,$3) ok',[`s:${f.tech}`,'read','broadcast']))[0].ok,false);
}));

test('pending server request is caller-specific, idempotent and persists until an authorized decision', () => tx(async (db) => {
  const f = await db.fixture();
  const server=await db.call(f.owner,'create_server',{p_org:f.org,p_name:'Requests',p_join_policy:'approval'});
  const general=(await db.one('select id from dek.channels where server_id=$1',[server.id])).id;
  assert.deepEqual(await db.call(f.alice,'join_server',{p_server:server.id}),{status:'pending'});
  assert.deepEqual(await db.call(f.alice,'join_server',{p_server:server.id}),{status:'pending'});
  const pending=(await db.call(f.alice,'list_servers',{p_org:f.org})).find(s=>s.id===server.id);
  assert.equal(pending.requested,true);
  assert.equal(pending.access,'browse');
  assert.equal((await db.call(f.bob,'list_servers',{p_org:f.org})).find(s=>s.id===server.id).requested,false);
  assert.deepEqual(await db.call(f.alice,'list_channels',{p_server:server.id}),[]);
  const reqs=await db.q('select id from dek.join_requests where server_id=$1 and user_id=$2 and status=$3',[server.id,f.alice,'pending']);
  assert.equal(reqs.length,1);
  await expectError(db.call(f.bob,'decide_join_request',{p_request:reqs[0].id,p_approve:true}),'forbidden');
  await db.call(f.owner,'decide_join_request',{p_request:reqs[0].id,p_approve:true});
  const after=(await db.call(f.alice,'list_servers',{p_org:f.org})).find(s=>s.id===server.id);
  assert.equal(after.requested,false);
  assert.equal(after.my_role,'member');
  assert.ok((await db.call(f.alice,'list_channels',{p_server:server.id})).some(c=>c.id===general));
}));
