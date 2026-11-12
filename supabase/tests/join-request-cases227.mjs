// Real SQL cases, reusable by the dedicated branch and the owned loopback PG runner.
// No synthetic permission implementation: eligibility is compared to actual API calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { svc, device, prefs, record } from './plat-lib.mjs';

const sorted = xs => [...xs].sort();
const route = (db, id) => db.q('select r.* from dek.notification_intents i cross join lateral dek.plat_route(i)r where i.id=$1',[id]);
async function approvalOracle(db, actors, request, channel = false) {
  const allowed=[];
  for(const actor of actors){
    const savepoint=`oracle227_${++db.n}`;
    await db.q(`savepoint ${savepoint}`);
    try {
      const result=await db.call(actor,channel?'decide_channel_request':'decide_join_request',{p_request:request,p_approve:true});
      assert.equal(result.status,'approved');
      allowed.push(actor);
    } catch(error) {
      assert.ok(['auth_required','forbidden','not_found','suspended'].includes(error.code),
        `unexpected oracle failure ${error.code}: ${error.message}`);
    } finally {
      await db.q(`rollback to savepoint ${savepoint}`);
      await db.q(`release savepoint ${savepoint}`);
    }
  }
  return sorted(allowed);
}
async function world(db){
  const f=await db.fixture();
  const requester=await db.user('Fictional request sender');
  const deleted=await db.user('Fictional deleted admin');
  const blocked=await db.user('Fictional blocked moderator');
  await db.member(f.org,requester);
  await db.member(f.org,deleted,'admin');
  await db.member(f.org,blocked);
  await db.q('update dek.profiles set deleted_at=now() where id=$1',[deleted]);
  const server=await db.server(f.org,'Fictional approval team',{joinPolicy:'approval',admins:[f.alice],moderators:[f.bob,blocked],members:[f.carol,f.guest,f.suspended]});
  await db.serverMember(server,f.suspended,'admin');
  await db.serverMember(f.tech,f.carol,'admin'); // unrelated-server Admin confers nothing here
  await db.q('insert into dek.server_member_controls105(server_id,user_id,org_id,suspended) values($1,$2,$3,true)',[server,blocked,f.org]);
  const actors=[f.owner,f.admin,f.alice,f.bob,f.carol,f.guest,f.suspended,f.eve,f.stranger,requester,deleted,blocked];
  return {...f,requester,deleted,blocked,server,actors};
}
async function request(db,w){
  assert.equal((await db.call(w.requester,'join_server',{p_server:w.server})).status,'pending');
  return (await db.one("select id from dek.join_requests where server_id=$1 and user_id=$2 and status='pending'",[w.server,w.requester])).id;
}
async function events(db,id,event='server.join.req'){
  return db.q("select topic,payload from realtime.messages where event=$1 and payload->>'request_id'=$2::text and payload->>'change'='new'",[event,id]);
}
async function recipients(db,id){
  return sorted((await events(db,id)).map(x=>x.topic.slice(2)));
}
async function assertServerRecipients(db,w,id,explicit){
  const allowed=(await approvalOracle(db,w.actors,id)).filter(x=>x!==w.requester);
  assert.deepEqual(allowed,sorted(explicit),'actual approval oracle must match the independent actor expectation');
  assert.deepEqual(await recipients(db,id),allowed,'exact one in-app event per real approver');
  const intents=await db.q('select target_user_id from dek.notification_intents where server_request_id=$1',[id]);
  assert.deepEqual(sorted(intents.map(x=>x.target_user_id)),allowed,'exact one push intent per real approver');
}
async function decideAndRequest(db,w,id){
  await db.call(w.owner,'decide_join_request',{p_request:id,p_approve:false});
  const next=await request(db,w);assert.notEqual(next,id);return next;
}
async function permission(db,w,role,allowed){
  await db.call(w.owner,'set_server_role_permissions105',{p_server:w.server,p_role:role,p_permissions:{decide_join_requests:allowed}});
}

export const cases227=[
 ['server recipients follow actual105 approval after grants, revocations and controls',async db=>{
   const w=await world(db);let id=await request(db,w);
   await assertServerRecipients(db,w,id,[w.owner,w.admin,w.alice]);
   await permission(db,w,'moderator',true);id=await decideAndRequest(db,w,id);
   await assertServerRecipients(db,w,id,[w.owner,w.admin,w.alice,w.bob]);
   await permission(db,w,'member',true);id=await decideAndRequest(db,w,id);
   await assertServerRecipients(db,w,id,[w.owner,w.admin,w.alice,w.bob,w.carol]);
   await permission(db,w,'moderator',false);id=await decideAndRequest(db,w,id);
   await assertServerRecipients(db,w,id,[w.owner,w.admin,w.alice,w.carol]);
   await db.q("update dek.org_members set status='suspended' where org_id=$1 and user_id=$2",[w.org,w.admin]);
   id=await decideAndRequest(db,w,id);await assertServerRecipients(db,w,id,[w.owner,w.alice,w.carol]);
   await permission(db,w,'member',false);id=await decideAndRequest(db,w,id);
   await assertServerRecipients(db,w,id,[w.owner,w.alice]);
   // Server controls are a second check, separate from the role map.
   await permission(db,w,'moderator',true);
   await db.q('update dek.server_member_controls105 set suspended=false,banned=true where server_id=$1 and user_id=$2',[w.server,w.blocked]);
   id=await decideAndRequest(db,w,id);await assertServerRecipients(db,w,id,[w.owner,w.alice,w.bob]);
 }],
 ['server requests are idempotent; open joins create no requests or notifications',async db=>{
   const w=await world(db);const id=await request(db,w);
   assert.equal(await request(db,w),id);
   await assertServerRecipients(db,w,id,[w.owner,w.admin,w.alice]);
   assert.equal((await db.one('select count(*)::int n from dek.join_requests where server_id=$1',[w.server])).n,1);
   const original=(await db.one('select * from dek.notification_intents where server_request_id=$1 limit 1',[id]));
   await db.q(`insert into dek.notification_intents(org_id,kind,actor_id,target_user_id,server_request_id)
     values($1,'request',$2,$3,$4) on conflict do nothing`,[w.org,w.requester,original.target_user_id,id]);
   assert.equal((await db.one('select count(*)::int n from dek.notification_intents where server_request_id=$1',[id])).n,3);
   const open=await db.server(w.org,'Fictional open team',{joinPolicy:'open'});
   const before=(await db.one('select count(*)::int n from dek.notification_intents where org_id=$1',[w.org])).n;
   assert.equal((await db.call(w.requester,'join_server',{p_server:open})).status,'joined');
   assert.equal((await db.one('select count(*)::int n from dek.join_requests where server_id=$1',[open])).n,0);
   assert.equal((await db.one('select count(*)::int n from dek.notification_intents where org_id=$1',[w.org])).n,before);
   const next=await decideAndRequest(db,w,id);await assertServerRecipients(db,w,next,[w.owner,w.admin,w.alice]);
 }],
 ['organization approval and requester exclusion use the exact scope',async db=>{
   const w=await world(db);
   const invite=await db.call(w.owner,'create_invite',{p_org:w.org,p_requires_approval:true});
   assert.equal((await db.call(w.stranger,'accept_invite',{p_code:invite.code})).status,'pending');
   assert.equal((await db.call(w.stranger,'accept_invite',{p_code:invite.code})).status,'pending');
   const r=await db.one('select id from dek.join_requests where org_id=$1 and user_id=$2 and server_id is null',[w.org,w.stranger]);
   await assertServerRecipients(db,{...w,requester:w.stranger},r.id,[w.owner,w.admin]);
   const serverInvite=await db.call(w.owner,'create_invite',{p_org:w.org,p_server:w.server,p_requires_approval:true});
   assert.equal((await db.call(w.requester,'accept_invite',{p_code:serverInvite.code})).status,'pending');
   const sr=await db.one('select id from dek.join_requests where server_id=$1 and user_id=$2',[w.server,w.requester]);
   await assertServerRecipients(db,w,sr.id,[w.owner,w.admin,w.alice]);
   const self=await db.one('insert into dek.join_requests(org_id,user_id) values($1,$2) returning id',[w.org,w.owner]);
   assert.deepEqual(await recipients(db,self.id),[w.admin]);
   assert.deepEqual((await db.q('select target_user_id from dek.notification_intents where server_request_id=$1',[self.id])).map(x=>x.target_user_id),[w.admin]);
 }],
 ['channel0916 new/open/repeat/decide behavior retains exact current105 approvers',async db=>{
   const w=await world(db);
   const channel=await db.channel(w.server,'fictional-locked',{visibility:'private',owner:w.owner,members:[w.bob,w.blocked,w.carol]});
   await permission(db,w,'moderator',true);
   const r=await db.call(w.alice,'request_channel_join',{p_channel:channel});
   assert.equal(r.status,'pending');
   assert.equal((await db.call(w.alice,'request_channel_join',{p_channel:channel})).request_id,r.request_id);
   const allowed=(await approvalOracle(db,w.actors,r.request_id,true)).filter(x=>x!==w.alice);
   assert.deepEqual(allowed,sorted([w.owner,w.admin,w.bob]));
   assert.deepEqual(sorted((await events(db,r.request_id,'join.req')).map(x=>x.topic.slice(2))),allowed);
   const intent=await db.one('select id,target_user_id from dek.notification_intents where channel_request_id=$1',[r.request_id]);
   assert.equal(intent.target_user_id,null);
   for(const u of w.actors)await device(db,u,{endpoint:`https://dek227.invalid/${randomUUID()}`});
   assert.deepEqual(sorted((await route(db,intent.id)).map(x=>x.r_user)),allowed);
   await permission(db,w,'moderator',false);
   assert.deepEqual(sorted((await route(db,intent.id)).map(x=>x.r_user)),sorted([w.owner,w.admin]));
   await db.call(w.owner,'decide_channel_request',{p_request:r.request_id,p_approve:true});
   assert.equal((await route(db,intent.id)).length,0);
   const approval=await db.one('select id from dek.notification_intents where channel_request_id=$1 and target_user_id=$2',[r.request_id,w.alice]);
   assert.deepEqual((await route(db,approval.id)).map(x=>x.r_user),[w.alice]);
   const pub=await db.channel(w.server,'fictional-open');
   const n=(await db.one('select count(*)::int n from dek.notification_intents where org_id=$1',[w.org])).n;
   assert.equal((await db.call(w.alice,'request_channel_join',{p_channel:pub})).status,'joined');
   assert.equal((await db.one('select count(*)::int n from dek.notification_intents where org_id=$1',[w.org])).n,n);
 }],
 ['channel fanout includes more than fifty approvers and five hundred devices',async db=>{
   const w=await world(db);
   const channel=await db.channel(w.server,'fictional-broad-approval',{visibility:'private',owner:w.owner});
   const members=[];
   for(let n=0;n<51;n++){
     const u=await db.user(`Fictional approver ${n}`);await db.member(w.org,u);await db.serverMember(w.server,u,'moderator');
     await db.channelMember(channel,u);members.push(u);
   }
   await permission(db,w,'moderator',true);
   await db.serverMember(w.server,w.requester);
   const r=await db.call(w.requester,'request_channel_join',{p_channel:channel});
   const everyone=[w.owner,w.admin,w.alice,...members];
   assert.deepEqual(sorted((await events(db,r.request_id,'join.req')).map(x=>x.topic.slice(2))),sorted(everyone));
   await db.q(`insert into dek.push_devices(user_id,kind,endpoint)
    select u,'fcm','dek227-native-only:'||u::text||':'||n::text
    from unnest($1::uuid[])u cross join generate_series(1,10)n`,[everyone]);
   const intent=await db.one('select id from dek.notification_intents where channel_request_id=$1',[r.request_id]);
   const pushes=await route(db,intent.id);
   assert.equal(pushes.length,everyone.length*10,'every eligible device must route, not only the first500');
   assert.deepEqual(sorted([...new Set(pushes.map(x=>x.r_user))]),sorted(everyone));
   const claimed=await svc(db,'svc_claim_intent',{p_intent:intent.id,p_dry_run:true});
   assert.equal(claimed.deliveries.length,everyone.length*10,'normal service-role claim preserves the entire fanout');
   const recorded=await record(db,intent.id,claimed.deliveries.map(d=>({user_id:d.user_id,device_id:d.device.id,status:'sent',http_status:201})));
   assert.equal(recorded.recorded,everyone.length*10);assert.equal(recorded.status,'done');
   assert.equal((await route(db,intent.id)).length,0,'all540final device outcomes deduplicate');
 }],
 ['server push checks pending status, fresh grants, privacy, quiet hours and final delivery dedup',async db=>{
   const w=await world(db);await permission(db,w,'moderator',true);
   const devices={};
   for(const u of w.actors)devices[u]=await device(db,u,{endpoint:`https://dek227.invalid/${randomUUID()}`});
   const disabled=await device(db,w.bob,{enabled:false,endpoint:`https://dek227.invalid/${randomUUID()}`});
   const revoked=await device(db,w.bob,{revoked:true,endpoint:`https://dek227.invalid/${randomUUID()}`});
   const id=await request(db,w);
   const intents=await db.q('select id,target_user_id from dek.notification_intents where server_request_id=$1',[id]);
   assert.equal(intents.length,4);
   for(const i of intents){
     const rows=await route(db,i.id);assert.equal(rows.length,1);const r=rows[0];
     assert.equal(r.r_user,i.target_user_id);assert.equal(r.r_device,devices[i.target_user_id]);
     assert.equal(r.r_tag,`sreq:${id}`);
     const orgAdmin=[w.owner,w.admin].includes(i.target_user_id);
     assert.equal(r.r_url,orgAdmin?`/o/${w.org}/admin/requests`:`/o/${w.org}/s/${w.server}/settings#requests`);
     assert.equal(r.r_title,'Request to join Fictional approval team');
     assert.match(r.r_body,/Fictional request sender/);assert.equal(r.r_quiet,false);
     assert.ok(![disabled,revoked].includes(r.r_device));
   }
   const bobIntent=intents.find(i=>i.target_user_id===w.bob).id;
   await prefs(db,w.bob,{preview:'none',quiet_start:'00:00',quiet_end:'23:59:59.999999',quiet_tz:'UTC'});
   const hidden=(await route(db,bobIntent))[0];
   assert.equal(hidden.r_title,'Dek');assert.equal(hidden.r_body,'Someone asked to join a team');assert.equal(hidden.r_quiet,true);
   const claimed=await svc(db,'svc_claim_intent',{p_intent:bobIntent,p_dry_run:false});
   assert.equal(claimed.deliveries.length,0);assert.equal(claimed.skipped.length,1);
   assert.equal((await route(db,bobIntent)).length,0,'quiet skip is a final device outcome');
   const aliceIntent=intents.find(i=>i.target_user_id===w.alice).id;
   await record(db,aliceIntent,[{user_id:w.alice,device_id:devices[w.alice],status:'failed',http_status:429}]);
   assert.equal((await route(db,aliceIntent)).length,1,'429 remains retryable');
   await record(db,aliceIntent,[{user_id:w.alice,device_id:devices[w.alice],status:'sent',http_status:201}]);
   assert.equal((await route(db,aliceIntent)).length,0,'successful per-device delivery never routes again');
   await permission(db,w,'moderator',false);assert.equal((await route(db,bobIntent)).length,0);
   const ownerIntent=intents.find(i=>i.target_user_id===w.owner).id;
   await db.call(w.owner,'decide_join_request',{p_request:id,p_approve:false});
   assert.equal((await route(db,ownerIntent)).length,0,'decided before dispatch');
 }],
 ['server queued recipient loses eligibility immediately, and internal helpers remain uncallable',async db=>{
   const w=await world(db);await permission(db,w,'moderator',true);
   await device(db,w.bob,{endpoint:`https://dek227.invalid/${randomUUID()}`});
   const id=await request(db,w);const intent=await db.one('select id from dek.notification_intents where server_request_id=$1 and target_user_id=$2',[id,w.bob]);
   assert.equal((await route(db,intent.id)).length,1);
   await permission(db,w,'moderator',false);assert.equal((await route(db,intent.id)).length,0);
   await permission(db,w,'moderator',true);assert.equal((await route(db,intent.id)).length,1);
   await db.q('insert into dek.server_member_controls105(server_id,user_id,org_id,suspended) values($1,$2,$3,true)',[w.server,w.bob,w.org]);
   assert.equal((await route(db,intent.id)).length,0);
   for(const role of ['anon','authenticated','service_role']){
     const acl=await db.one(`select has_function_privilege($1,'dek.server_request_approvers227(uuid,uuid)','EXECUTE') as helper,
      has_function_privilege($1,'dek.plat_route_server_request227(dek.notification_intents)','EXECUTE') as router`,[role]);
     assert.deepEqual(acl,{helper:false,router:false});
   }
   assert.equal((await db.one("select has_function_privilege('authenticated','api.svc_claim_intent(bigint,boolean)','EXECUTE') ok")).ok,false);
   assert.equal((await db.one("select has_function_privilege('service_role','api.svc_claim_intent(bigint,boolean)','EXECUTE') ok")).ok,true);
 }],
];
