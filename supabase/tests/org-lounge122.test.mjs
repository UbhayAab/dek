import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';

test('122 new server has exactly one available default audio lounge before anyone starts a call', () => tx(async db => {
  const f = await db.fixture();
  const s = await db.call(f.alice, 'create_server', { p_org: f.org, p_name: 'Fictional lounge122', p_join_policy: 'open' });
  const rooms = await db.q("select * from dek.channels where server_id=$1 and kind='audio' and archived_at is null", [s.id]);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].name, 'lounge'); assert.equal(rooms[0].visibility, 'public'); assert.equal(rooms[0].auto_join, true);
  assert.equal((await db.one('select role from dek.channel_members where channel_id=$1 and user_id=$2', [rooms[0].id, f.alice])).role, 'owner');
  assert.equal((await db.one('select count(*)::int n from dek.calls where channel_id=$1', [rooms[0].id])).n, 0);
  await db.call(f.bob, 'join_server', { p_server: s.id });
  assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id=$1 and user_id=$2', [rooms[0].id, f.bob])).n, 1);
  await expectError(db.call(f.eve, 'list_channels', { p_server: s.id }), 'not_found');
  await expectError(db.call(f.guest, 'join_server', { p_server: s.id }), 'not_found');
}));

test('122 existing server backfill is idempotent and preserves room preferences and messages', () => tx(async db => {
  const f=await db.fixture();
  const message=await db.message(f.general,f.alice,'Fictional unchanged message122');
  const originalMessage=await db.one('select to_jsonb(m) value from dek.messages m where id=$1',[message.id]);
  const id=(await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id;
  assert.ok(id);
  await db.q("update dek.channel_members set notify='none',muted_until=now()+interval '1 day',last_read_seq=77 where channel_id=$1 and user_id=$2",[id,f.alice]);
  const before=await db.one('select to_jsonb(cm) value from dek.channel_members cm where channel_id=$1 and user_id=$2',[id,f.alice]);
  const events=(await db.one('select count(*)::int n from realtime.messages')).n;
  assert.equal((await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id,id);
  assert.deepEqual(await db.one('select to_jsonb(cm) value from dek.channel_members cm where channel_id=$1 and user_id=$2',[id,f.alice]),before);
  assert.equal((await db.one('select count(*)::int n from realtime.messages')).n,events);
  assert.equal((await db.one("select count(*)::int n from dek.channels where server_id=$1 and kind='audio'",[f.medical])).n,1);
  assert.deepEqual(await db.one('select to_jsonb(m) value from dek.messages m where id=$1',[message.id]),originalMessage);
}));

test('122 a private lounge is not opened or renamed by default-room backfill', () => tx(async db => {
  const f=await db.fixture();
  const secret=await db.channel(f.medical,'lounge',{visibility:'private',kind:'audio',owner:f.owner});
  const original=await db.one('select to_jsonb(c) value from dek.channels c where id=$1',[secret]);
  const id=(await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id;
  assert.notEqual(id,secret);
  assert.equal((await db.one('select name from dek.channels where id=$1',[id])).name,'lounge-2');
  assert.deepEqual(await db.one('select to_jsonb(c) value from dek.channels c where id=$1',[secret]),original);
  assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id=$1 and user_id=$2',[secret,f.alice])).n,0);
}));

test('122 reuses an existing public default audio room without changing its name or settings', () => tx(async db => {
  const f=await db.fixture();
  const id=await db.channel(f.medical,'Team talks',{kind:'audio',owner:f.owner});
  await db.q('update dek.channels set auto_join=true where id=$1',[id]);
  const original=await db.one('select to_jsonb(c) value from dek.channels c where id=$1',[id]);
  assert.equal((await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id,id);
  assert.deepEqual(await db.one('select to_jsonb(c) value from dek.channels c where id=$1',[id]),original);
  assert.equal((await db.one("select count(*)::int n from dek.channels where server_id=$1 and kind='audio'",[f.medical])).n,1);
}));

test('122 backfill skips guest, suspended, moderated and foreign members plus partial channel-only users', () => tx(async db => {
  const f=await db.fixture();
  await db.serverMember(f.medical,f.guest);await db.serverMember(f.medical,f.suspended);await db.serverMember(f.medical,f.eve);
  await db.q('insert into dek.server_member_controls105(server_id,user_id,org_id,suspended) values($1,$2,$3,true)',[f.medical,f.bob,f.org]);
  const id=(await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id;
  for(const uid of [f.guest,f.suspended,f.eve,f.bob,f.carol,f.stranger]) assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id=$1 and user_id=$2',[id,uid])).n,0,uid);
  assert.equal((await db.one('select count(*)::int n from dek.channel_members where channel_id=$1 and user_id=$2',[id,f.alice])).n,1);
}));

test('122 archived and absent servers get no new room', () => tx(async db => {
  const f=await db.fixture();
  await db.q('update dek.servers set archived_at=now() where id=$1',[f.medical]);
  assert.equal((await db.one('select dek.ensure_server_lounge122($1,null) id',[f.medical])).id,null);
  assert.equal((await db.one("select dek.ensure_server_lounge122('00000000-0000-4000-8000-000000000000',null) id")).id,null);
  assert.equal((await db.one("select count(*)::int n from dek.channels where server_id=$1 and kind='audio'",[f.medical])).n,0);
}));

test('122 future server joins still get a lounge when fifty earlier text channels use auto-join', () => tx(async db => {
  const f=await db.fixture();
  const s=await db.call(f.alice,'create_server',{p_org:f.org,p_name:'Many channels122',p_join_policy:'open'});
  await db.q("insert into dek.channels(org_id,server_id,kind,name,auto_join,position) select $1,$2,'text','early-'||n,true,n-100 from generate_series(1,55)n",[f.org,s.id]);
  await db.call(f.bob,'join_server',{p_server:s.id});
  assert.equal((await db.one("select count(*)::int n from dek.channel_members cm join dek.channels c on c.id=cm.channel_id where c.server_id=$1 and c.kind='audio' and cm.user_id=$2",[s.id,f.bob])).n,1);
}));

test('122 default helper is not exposed to browser roles and does not grant new API privileges', () => tx(async db => {
  for(const role of ['anon','authenticated','service_role']) assert.equal((await db.one("select has_function_privilege($1,'dek.ensure_server_lounge122(uuid,uuid)','EXECUTE') allowed",[role])).allowed,false);
}));
